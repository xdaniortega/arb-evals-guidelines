import { createAppleContainerSandbox } from "../sandboxes/apple-container.ts";
import { MCP_CLIENT_POLICY } from "../harnesses/pi/mcp-tools.ts";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildAllowlistedEnv } from "../test-guards.ts";
import { buildRunReport, formatRunReport, readCandidate, readNativeSession, verifyRun } from "../artifacts/queries.ts";
import { sha256Hex } from "../core/experiment.ts";
import { buildFreshBoundaryCommand } from "./container-paired-boundary.ts";

const enabled = process.env.EVAL_CONTAINER_TESTS === "1";
const evalsRoot = process.cwd();
const stateDir = join(evalsRoot, ".state");
const childScript = resolve(evalsRoot, "src/runner/container-paired.test-child.ts");
const reportScript = resolve(evalsRoot, "scripts/report.ts");
const nonce = randomBytes(4).toString("hex");
const suiteId = `paired-synthetic-${nonce}`;
const suiteDir = join(evalsRoot, suiteId);
const skillDir = join(evalsRoot, `${suiteId}-skill`);
const testStateDir = join(stateDir, suiteId);
const retained = process.env.EVALS_RETAIN_DEMO === "1";
const recordTimings = process.env.EVALS_PAIRED_TIMINGS === "1";

type JournalEntry = { action: string; conditionId: string | null; event: string; kind: string; name: string; runId: string; sequence: number; status: string | null };
type ClaimedRun = { runId: string; runDir: string | null; journalPath: string | null; cleanupConfirmed: boolean; expectationConfirmed: boolean; diagnosis: string };
type TimingPayload = { measurements: Record<string, Array<{ label: string; ms: number }>>; progress: Array<{ type: string; timestampMs: number }>; childInvocationWindowMs: number };
type ChildRun = { stdout: string; stderr: string; receipt: string; runDir: string; baselineHtml: string; treatmentHtml: string; claimed: ClaimedRun; policy: "serial" | "overlap"; timing?: TimingPayload };
type FaultScenario = "preparation" | "export" | "grading" | "task-budget";
type AbortScenario = "preparation-abort" | "guest-preparation-abort" | "tool-abort" | "export-abort" | "grading-abort";

const claimedRuns: ClaimedRun[] = [];
let containersBefore: string[] = [];
let networksBefore: string[] = [];
let imagesBefore: string[] = [];
let overlap: ChildRun | null = null;
let serial: ChildRun | null = null;
let suiteAssertionsFailed = false;

function listIds(kind: "container" | "network" | "image"): string[] {
  const args = kind === "container" ? ["list", "--all", "--format", "json"] : [kind, "list", "--format", "json"];
  const parsed = JSON.parse(execFileSync("container", args, { encoding: "utf8", timeout: 20_000 })) as Array<{ id?: string; configuration?: { name?: string; descriptor?: { digest?: string } } }>;
  return parsed.map((item) => item.id ?? item.configuration?.name ?? item.configuration?.descriptor?.digest ?? JSON.stringify(item)).sort();
}

async function names(path: string, suffix = ""): Promise<string[]> {
  return (await readdir(path).catch(() => [])).filter((name) => name.endsWith(suffix)).sort();
}

async function readJournal(path: string): Promise<JournalEntry[]> {
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as JournalEntry);
}

function journalConfirmsCleanup(entries: readonly JournalEntry[]): boolean {
  const claimed = entries.filter((entry) => entry.action === "create" && entry.event === "intent" && (entry.kind === "guest" || entry.kind === "network"));
  return claimed.length > 0 && claimed.every((claim) => entries.some((entry) =>
    entry.sequence > claim.sequence && entry.action === "destroy" && entry.event === "observed" &&
    entry.kind === claim.kind && entry.name === claim.name && ["destroyed", "already-absent"].includes(entry.status ?? ""),
  ));
}

function extractTable(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("┌─"));
  const end = lines.findIndex((line) => line.startsWith("└─"));
  if (start < 0 || end < start) throw new Error(`table missing:\n${text}`);
  return lines.slice(start, end + 1).join("\n");
}

function eventIndex(stderr: string, fragment: string): number {
  const matches = stderr.split("\n").map((line, index) => ({ line, index })).filter(({ line }) => line.includes(fragment));
  expect(matches, `expected exactly one progress event containing ${JSON.stringify(fragment)}\n${stderr}`).toHaveLength(1);
  return matches[0]!.index;
}

function assertProgressOrder(run: ChildRun, pairs: number): void {
  for (let pair = 1; pair <= pairs; pair += 1) {
    const ready = eventIndex(run.stderr, `pair ${pair}/${pairs} both arms ready`);
    const baselineStart = eventIndex(run.stderr, `pair ${pair} [baseline] execution started`);
    const treatmentStart = eventIndex(run.stderr, `pair ${pair} [treatment] execution started`);
    const baselineDone = eventIndex(run.stderr, `pair ${pair} [baseline] completed:`);
    const treatmentDone = eventIndex(run.stderr, `pair ${pair} [treatment] completed:`);
    expect(ready).toBeLessThan(Math.min(baselineStart, treatmentStart));
    if (run.policy === "overlap") {
      expect(Math.max(baselineStart, treatmentStart)).toBeLessThan(Math.min(baselineDone, treatmentDone));
    } else {
      expect(baselineStart).toBeLessThan(baselineDone);
      expect(baselineDone).toBeLessThan(treatmentStart);
      expect(treatmentStart).toBeLessThan(treatmentDone);
    }
  }
}

async function runChild(policy: "serial" | "overlap", repetitions: number, extraEnv: Readonly<Record<string, string>> = {}): Promise<ChildRun> {
  const home = join(stateDir, `${suiteId}-${policy}-home`);
  await mkdir(home, { recursive: true });
  const runDirsBefore = new Set(await names(join(suiteDir, "runs")));
  const journalsBefore = new Set(await names(testStateDir, ".journal.jsonl"));
  const result = spawnSync(process.execPath, ["--experimental-strip-types", childScript, suiteId, policy, String(repetitions)], {
    cwd: process.cwd(), encoding: "utf8", timeout: 175_000,
    env: buildAllowlistedEnv(home, extraEnv),
  });

  const newRunDirs = (await names(join(suiteDir, "runs"))).filter((name) => !runDirsBefore.has(name));
  // This directory is passed to the child as its journal root and is owned by this
  // random suite only. Never enumerate or open journals from the shared .state root.
  const newJournals = (await names(testStateDir, ".journal.jsonl")).filter((name) => !journalsBefore.has(name));
  const claimedIds = new Set([...newRunDirs, ...newJournals.map((name) => name.replace(/\.journal\.jsonl$/, ""))]);
  for (const runId of claimedIds) {
    const runDir = newRunDirs.includes(runId) ? join(suiteDir, "runs", runId) : null;
    const journalPath = newJournals.includes(`${runId}.journal.jsonl`) ? join(testStateDir, `${runId}.journal.jsonl`) : null;
    const entries = journalPath ? await readJournal(journalPath).catch(() => []) : [];
    const receiptStatus = runDir ? await readFile(join(runDir, "receipt.json"), "utf8").then((text) => (JSON.parse(text) as { status?: string }).status ?? "missing-status").catch(() => "missing-receipt") : "no-evidence-dir";
    const cleanupConfirmed = journalConfirmsCleanup(entries);
    claimedRuns.push({ runId, runDir, journalPath, cleanupConfirmed, expectationConfirmed: false, diagnosis: `policy=${policy} childStatus=${result.status ?? "spawn-error"} receipt=${receiptStatus} cleanup=${cleanupConfirmed ? "journal-confirmed" : "UNRESOLVED"}` });
  }

  const diagnostic = `${result.stderr}\n${result.stdout}`;
  if (result.error || result.status !== 0) {
    const environment = /platform-unsupported|public DNS|public egress|ECONNREFUSED|container system/i.test(diagnostic);
    throw new Error(`${environment ? "ENVIRONMENT_UNAVAILABLE" : "L2_ASSERTION_OR_EXECUTION_FAILURE"}: ${policy} child failed; claimed=${[...claimedIds].join(",") || "none"}; ${result.error?.message ?? `exit ${result.status}`}\n${diagnostic}`);
  }
  expect(claimedIds.size, `successful child must claim exactly one run: ${diagnostic}`).toBe(1);
  const claimed = claimedRuns.find((item) => item.runId === [...claimedIds][0])!;
  expect(claimed.cleanupConfirmed, claimed.diagnosis).toBe(true);
  const value = (name: string): string => {
    const match = result.stdout.match(new RegExp(`^${name}=(.+)$`, "m"));
    if (!match?.[1]) throw new Error(`${name} missing from child output`);
    return match[1];
  };
  const timingMatch = result.stdout.match(/^PAIRED_METRICS=(.+)$/m);
  return { stdout: result.stdout, stderr: result.stderr, receipt: value("PAIRED_RECEIPT"), runDir: value("PAIRED_RUN_DIR"), baselineHtml: value("PAIRED_BASELINE_HTML"), treatmentHtml: value("PAIRED_TREATMENT_HTML"), claimed, policy, ...(timingMatch?.[1] ? { timing: JSON.parse(timingMatch[1]) as TimingPayload } : {}) };
}

async function discoverAndRegisterAttempts(
  scenario: string,
  resultStatus: number | null,
  runDirsBefore: ReadonlySet<string>,
  journalsBefore: ReadonlySet<string>,
): Promise<{ newRunDirs: string[]; newJournals: string[]; claims: ClaimedRun[] }> {
  const newRunDirs = (await names(join(suiteDir, "runs"))).filter((name) => !runDirsBefore.has(name));
  const newJournals = (await names(testStateDir, ".journal.jsonl")).filter((name) => !journalsBefore.has(name));
  const ids = new Set([...newRunDirs, ...newJournals.map((name) => name.replace(/\.journal\.jsonl$/, ""))]);
  const claims: ClaimedRun[] = [];
  for (const runId of ids) {
    const runDir = newRunDirs.includes(runId) ? join(suiteDir, "runs", runId) : null;
    const journalPath = newJournals.includes(`${runId}.journal.jsonl`) ? join(testStateDir, `${runId}.journal.jsonl`) : null;
    const entries = journalPath ? await readJournal(journalPath).catch(() => []) : [];
    const creates = entries.filter((entry) => entry.action === "create" && entry.event === "intent" && (entry.kind === "guest" || entry.kind === "network"));
    const cleanupConfirmed = creates.length > 0 && journalConfirmsCleanup(entries);
    const claim = { runId, runDir, journalPath, cleanupConfirmed, expectationConfirmed: false, diagnosis: `fault=${scenario} childStatus=${resultStatus ?? "spawn-error"} cleanup=${cleanupConfirmed ? "journal-confirmed" : "UNRESOLVED/UNCLASSIFIED"}` };
    claimedRuns.push(claim);
    claims.push(claim);
  }
  return { newRunDirs, newJournals, claims };
}

async function runFaultChild(
  scenario: FaultScenario,
  testExpectation: { expectedStatus?: number } = {},
): Promise<{ report: Awaited<ReturnType<typeof buildRunReport>> | null; claims: ClaimedRun[] }> {
  const containersAtStart = listIds("container");
  const networksAtStart = listIds("network");
  const runDirsBefore = new Set(await names(join(suiteDir, "runs")));
  const journalsBefore = new Set(await names(testStateDir, ".journal.jsonl"));
  const home = join(stateDir, `${suiteId}-${scenario}-home`);
  await mkdir(home, { recursive: true });
  const result = spawnSync(process.execPath, ["--experimental-strip-types", childScript, suiteId, "overlap", "1"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 175_000,
    env: buildAllowlistedEnv(home, { EVALS_TEST_FAULT: scenario }),
  });

  // Discover and register every owned attempt before ANY status/report expectation. A
  // failed expectation leaves expectationConfirmed=false, so teardown retains evidence.
  const discovered = await discoverAndRegisterAttempts(scenario, result.status, runDirsBefore, journalsBefore);
  try {
    expect(result.error, `${scenario}: ${result.stderr}`).toBeUndefined();
    expect(result.status, `${scenario}: ${result.stderr}\n${result.stdout}`).toBe(testExpectation.expectedStatus ?? (scenario === "task-budget" ? 0 : 1));
    expect(listIds("container"), `${scenario}: container baseline changed`).toEqual(containersAtStart);
    expect(listIds("network"), `${scenario}: network baseline changed`).toEqual(networksAtStart);
    if (scenario === "preparation") {
      expect(discovered.newRunDirs).toEqual([]);
      expect(discovered.newJournals).toEqual([]);
      expect(result.stderr).toContain("injected trusted preparation failure");
      return { report: null, claims: discovered.claims };
    }
    expect(discovered.newRunDirs, `${scenario}: exactly one evidence directory`).toHaveLength(1);
    expect(discovered.newJournals, `${scenario}: exactly one owned journal`).toHaveLength(1);
    const claim = discovered.claims[0]!;
    expect(discovered.newJournals[0]).toBe(`${claim.runId}.journal.jsonl`);
    expect(claim.cleanupConfirmed, claim.diagnosis).toBe(true);
    const report = await buildRunReport(join(claim.runDir!, "receipt.json"));
    return { report, claims: discovered.claims };
  } catch (error) {
    for (const claim of discovered.claims) claim.diagnosis += `; expectation=FAILED:${error instanceof Error ? error.message : String(error)}`;
    throw error;
  }
}

async function verifyClaimedAttempts<T>(claims: readonly ClaimedRun[], assertions: () => Promise<T> | T): Promise<T> {
  try {
    const result = await assertions();
    for (const claim of claims) claim.expectationConfirmed = true;
    return result;
  } catch (error) {
    for (const claim of claims) claim.diagnosis += `; expectation=FAILED:${error instanceof Error ? error.message : String(error)}`;
    throw error;
  }
}

function sumMetric(payload: TimingPayload, name: string): number {
  return (payload.measurements[name] ?? []).reduce((total, row) => total + row.ms, 0);
}

function eventTime(payload: TimingPayload, type: string, last = false): number {
  const matches = payload.progress.filter((event) => event.type === type);
  expect(matches, `missing raw progress event ${type}`).not.toHaveLength(0);
  return matches[last ? matches.length - 1 : 0]!.timestampMs;
}

function correctedTimingRow(payload: TimingPayload): Record<string, number> {
  const sdk = payload.measurements.sdkExecutionMs ?? [];
  return {
    imageAcquireInspectMs: sumMetric(payload, "imageAcquireInspectMs"),
    inputFreezeMs: eventTime(payload, "freeze-completed") - eventTime(payload, "freeze-started"),
    networkCreateMs: sumMetric(payload, "networkCreateMs"),
    guestCreateMs: sumMetric(payload, "guestCreateMs"),
    workspaceStageMs: sumMetric(payload, "workspaceStageMs"),
    attestationMs: sumMetric(payload, "guestAttestationMs") + sumMetric(payload, "harnessAttestationMs"),
    sdkBaselineMs: sdk.find((row) => row.label === "baseline")?.ms ?? -1,
    sdkTreatmentMs: sdk.find((row) => row.label === "treatment")?.ms ?? -1,
    schedulingMakespanMs: eventTime(payload, "arm-execution-completed", true) - eventTime(payload, "arm-execution-started"),
    workspaceExportMs: sumMetric(payload, "workspaceExportMs"),
    agentResourceCleanupMs: sumMetric(payload, "agentResourceCleanupMs") + sumMetric(payload, "agentGuestCleanupMs"),
    validatorLifecycleMs: sumMetric(payload, "validatorLifecycleMs"),
    sealingVerifyMs: eventTime(payload, "finalization-completed") - eventTime(payload, "sealing-started"),
    childInvocationWindowMs: payload.childInvocationWindowMs,
  };
}

async function waitFor<T>(description: string, probe: () => Promise<T | null>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function runAbortChild(scenario: AbortScenario): Promise<{ report: Awaited<ReturnType<typeof buildRunReport>> | null; marker: { operationPid?: number; resource?: string; resourceKind?: "guest" | "network" }; stderr: string; entries: JournalEntry[]; claim: ClaimedRun | null }> {
  const containersAtStart = listIds("container");
  const networksAtStart = listIds("network");
  const runDirsBefore = new Set(await names(join(suiteDir, "runs")));
  const journalsBefore = new Set(await names(testStateDir, ".journal.jsonl"));
  const markerDir = await mkdtemp(join(tmpdir(), `${scenario}-`));
  const home = join(stateDir, `${suiteId}-${scenario}-home`);
  await mkdir(home, { recursive: true });
  const child = spawn(process.execPath, ["--experimental-strip-types", childScript, suiteId, "serial", "1"], {
    cwd: process.cwd(), env: buildAllowlistedEnv(home, { EVALS_TEST_FAULT: scenario, EVALS_ABORT_MARKER_DIR: markerDir }), stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });

  let marker: { operationPid?: number; resource?: string; resourceKind?: "guest" | "network" } = {};
  let attemptsRegistered = false;
  try {
    marker = await waitFor(`${scenario} operation entry`, async () => {
      if (child.exitCode !== null) throw new Error(`${scenario} child exited before its barrier (${child.exitCode}):\n${stderr}\n${stdout}`);
      const text = await readFile(join(markerDir, "process.json"), "utf8").catch(() => null);
      const parsed = text === null ? {} : JSON.parse(text) as { operationPid?: number; resource?: string; resourceKind?: "guest" | "network" };
      if (scenario === "guest-preparation-abort") {
        if (text === null || parsed.resourceKind !== "guest" || parsed.resource === undefined) return null;
        const journalNames = (await names(testStateDir, ".journal.jsonl")).filter((name) => !journalsBefore.has(name));
        if (journalNames.length !== 1) return null;
        const entries = await readJournal(join(testStateDir, journalNames[0]!)).catch(() => []);
        const intended = entries.some((entry) => entry.action === "create" && entry.event === "intent" && entry.kind === "guest" && entry.name === parsed.resource);
        if (!intended) return null;
        const inspected = spawnSync("container", ["inspect", parsed.resource], { encoding: "utf8", timeout: 5_000 });
        return inspected.status === 0 ? parsed : null;
      }
      if (scenario !== "tool-abort") return text === null ? null : parsed;
      const journalNames = (await names(testStateDir, ".journal.jsonl")).filter((name) => !journalsBefore.has(name));
      if (journalNames.length !== 1) return null;
      const entries = await readJournal(join(testStateDir, journalNames[0]!)).catch(() => []);
      const guest = entries.find((entry) => entry.action === "create" && entry.event === "observed" && entry.kind === "guest" && entry.conditionId === "baseline")?.name;
      if (!guest) return null;
      const entered = spawnSync("container", ["exec", guest, "/usr/bin/test", "-f", "/work/.abort-tool-entered"], { encoding: "utf8", timeout: 5_000 });
      return entered.status === 0 ? parsed : null;
    });
    child.kill("SIGINT");
    const status = await Promise.race([
      new Promise<number | null>((resolveExit) => child.once("exit", resolveExit)),
      new Promise<never>((_resolve, reject) => setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${scenario} child did not stop`)); }, 175_000)),
    ]);

    // As with fault injection, evidence discovery/registration precedes every outcome assertion.
    const discovered = await discoverAndRegisterAttempts(scenario, status, runDirsBefore, journalsBefore);
    attemptsRegistered = true;
    const entries = discovered.claims[0]?.journalPath ? await readJournal(discovered.claims[0]!.journalPath!) : [];
    try {
      expect(status, `${scenario}: ${stderr}\n${stdout}`).toBe(1);
      expect(listIds("container"), `${scenario}: container baseline changed`).toEqual(containersAtStart);
      expect(listIds("network"), `${scenario}: network baseline changed`).toEqual(networksAtStart);
      if (marker.resourceKind === "network") expect(listIds("network")).not.toContain(marker.resource);
      if (marker.resourceKind === "guest") expect(listIds("container")).not.toContain(marker.resource);
      if (marker.operationPid !== undefined) expect(() => process.kill(marker.operationPid!, 0)).toThrow();
      if (scenario === "preparation-abort") {
        expect(discovered.newRunDirs).toEqual([]);
        expect(discovered.newJournals).toEqual([]);
        expect(stderr).toContain("EvalError: SIGINT received");
        expect(stderr).toContain("at: 'trusted-preparation'");
        return { report: null, marker, stderr, entries, claim: null };
      }
      expect(discovered.claims).toHaveLength(1);
      const claim = discovered.claims[0]!;
      expect(claim.cleanupConfirmed, claim.diagnosis).toBe(true);
      const report = await buildRunReport(join(claim.runDir!, "receipt.json"));
      expect(report.verification.ok).toBe(true);
      expect(report.status).toBe("partial");
      expect(report.summary?.qualityDelta).toBeNull();
      return { report, marker, stderr, entries, claim };
    } catch (error) {
      for (const claim of discovered.claims) claim.diagnosis += `; expectation=FAILED:${error instanceof Error ? error.message : String(error)}`;
      throw error;
    }
  } catch (error) {
    if (!attemptsRegistered) {
      await discoverAndRegisterAttempts(scenario, child.exitCode, runDirsBefore, journalsBefore);
      attemptsRegistered = true;
    }
    throw error;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(markerDir, { recursive: true, force: true });
  }
}

async function chainedHashes(runDir: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const walk = async (dir: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative === "views" || relative.startsWith("views/")) continue;
      if (entry.isDirectory()) await walk(join(dir, entry.name), relative);
      else if (entry.isFile()) hashes[relative] = sha256Hex(await readFile(join(dir, entry.name)));
    }
  };
  await walk(runDir);
  return hashes;
}

describe("paired L2 fresh-boundary shell", () => {
  for (const obstruction of ["pre-existing sentinel", "hidden oracle file"] as const) {
    it(`fails without a success marker for a ${obstruction}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "paired-boundary-negative-"));
      const home = join(root, "home");
      const temp = join(root, "tmp");
      const work = join(root, "work");
      try {
        await Promise.all([mkdir(home), mkdir(temp), mkdir(work)]);
        if (obstruction === "pre-existing sentinel") await writeFile(join(home, ".paired-fresh"), "owned");
        else await writeFile(join(work, "oracle.json"), "private");
        const result = spawnSync("/bin/bash", ["-c", buildFreshBoundaryCommand({
          suiteId: "negative-boundary",
          expectedHome: home,
          expectedTmpDir: temp,
          skillRoot: join(root, "skills"),
        })], {
          cwd: work,
          encoding: "utf8",
          env: { HOME: home, TMPDIR: temp, GEMINI_API_KEY: "synthetic-negative-only" },
          timeout: 5_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        expect(result.stdout).not.toContain("agent-boundary-fresh");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

if (!enabled) {
  describe("real paired Pi SDK L2", () => {
    it.skip("requires explicit EVAL_CONTAINER_TESTS=1 (pnpm test:container)", () => undefined);
  });
} else {
  describe.sequential("real paired Pi SDK L2", () => {
    afterEach((context) => {
      if (context.task.result?.state === "fail") suiteAssertionsFailed = true;
    });

    beforeAll(async () => {
      // Fault scenarios target running guests, not a cold image build. Establish the
      // shared immutable cache before taking the inventory that must stay unchanged.
      await createAppleContainerSandbox({ runId: `${suiteId}-image` }).buildImage({
        runtimeProfileId: "default",
        contextDir: resolve("container"),
        signal: AbortSignal.timeout(150_000),
        deadlineAtMs: Date.now() + 150_000,
      });
      containersBefore = listIds("container");
      networksBefore = listIds("network");
      imagesBefore = listIds("image");
      await mkdir(join(suiteDir, "cases/workspace/paired-sdk/fixture"), { recursive: true });
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(suiteDir, "eval.json"), JSON.stringify({ schemaVersion: 1, id: suiteId, skillPath: `evals/${suiteId}-skill`, runtimeProfileId: "default", limits: { wallClockMs: 30_000 } }));
      await writeFile(join(suiteDir, "cases/workspace/paired-sdk/case.json"), JSON.stringify({ id: "paired-sdk", version: 1, prompt: "Create and edit the requested synthetic workspace using the available built-in tools.", outputPath: "__workspace__", allowedTools: ["read", "write", "edit", "bash"], validator: "validator.ts" }));
      await writeFile(join(suiteDir, "cases/workspace/paired-sdk/oracle.json"), JSON.stringify({ hidden: "grader-only-token", expectedTreatment: "treatment" }));
      await writeFile(join(suiteDir, "cases/workspace/paired-sdk/validator.ts"), `export function validateSnapshot(input) {\n  if (process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY) throw new Error("grader received a credential");\n  if (input.oracle.hidden !== "grader-only-token") throw new Error("hidden oracle missing from grader");\n  const text = (path) => Object.prototype.hasOwnProperty.call(input.candidateFiles, path) ? Buffer.from(input.candidateFiles[path], "base64").toString("utf8") : null;\n  const score = text("nested/result.txt") === input.oracle.expectedTreatment && text("companion.txt") === "preserved" && text("fresh-state.txt") === "" ? 1 : 0;\n  return { status: "graded", score, fullPass: score === 1, checks: [{ id: "workspace-effect", passed: score === 1, message: score === 1 ? "treatment effect observed" : "baseline control observed" }] };\n}\n`);
      await mkdir(join(suiteDir, "cases/workspace/bad-validator/fixture"), { recursive: true });
      await writeFile(join(suiteDir, "cases/workspace/bad-validator/case.json"), JSON.stringify({ id: "bad-validator", version: 1, prompt: "Exercise an isolated grading failure.", outputPath: "__workspace__", allowedTools: ["read", "write", "edit", "bash"], validator: "validator.ts" }));
      await writeFile(join(suiteDir, "cases/workspace/bad-validator/oracle.json"), "{}");
      await writeFile(join(suiteDir, "cases/workspace/bad-validator/validator.ts"), `export function validateSnapshot() { throw new Error("injected isolated grading failure"); }\n`);
      await mkdir(join(suiteDir, "cases/workspace/busy-validator/fixture"), { recursive: true });
      await writeFile(join(suiteDir, "cases/workspace/busy-validator/case.json"), JSON.stringify({ id: "busy-validator", version: 1, prompt: "Exercise an in-flight isolated grader.", outputPath: "__workspace__", allowedTools: ["read", "write", "edit", "bash"], validator: "validator.ts" }));
      await writeFile(join(suiteDir, "cases/workspace/busy-validator/oracle.json"), "{}");
      await writeFile(join(suiteDir, "cases/workspace/busy-validator/validator.ts"), `export function validateSnapshot() { const until = Date.now() + 120000; while (Date.now() < until) {} return { status: "graded", score: 1, fullPass: true, checks: [] }; }\n`);
      await writeFile(join(skillDir, "SKILL.md"), "---\nname: paired-frozen-skill\ndescription: Synthetic paired-run fixture.\n---\nUse the requested tools.\n");
    }, 180_000);

    afterAll(async () => {
      let baselinePreserved = false;
      try {
        baselinePreserved = JSON.stringify(listIds("container")) === JSON.stringify(containersBefore) && JSON.stringify(listIds("network")) === JSON.stringify(networksBefore) && JSON.stringify(listIds("image")) === JSON.stringify(imagesBefore);
      } catch (error) {
        process.stderr.write(`PAIRED teardown baseline inspection failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      const selectedRetainedId = retained && overlap?.claimed.cleanupConfirmed && baselinePreserved ? overlap.claimed.runId : null;
      for (const claim of claimedRuns) {
        process.stderr.write(`PAIRED claimed run ${claim.runId}: ${claim.diagnosis}; baselinePreserved=${baselinePreserved}\n`);
        if (suiteAssertionsFailed || !claim.cleanupConfirmed || !claim.expectationConfirmed || !baselinePreserved || claim.runId === selectedRetainedId) continue;
        if (claim.runDir) await rm(claim.runDir, { recursive: true, force: true });
      }
      const unresolved = suiteAssertionsFailed || claimedRuns.some((claim) => !claim.cleanupConfirmed || !claim.expectationConfirmed) || !baselinePreserved;
      if (!unresolved) {
        if (selectedRetainedId) {
          await rm(join(suiteDir, "eval.json"), { force: true });
          await rm(join(suiteDir, "cases"), { recursive: true, force: true });
        } else {
          await rm(suiteDir, { recursive: true, force: true });
        }
        await rm(skillDir, { recursive: true, force: true });
        await rm(join(stateDir, `${suiteId}-serial-home`), { recursive: true, force: true });
        await rm(join(stateDir, `${suiteId}-overlap-home`), { recursive: true, force: true });
        await rm(join(stateDir, `${suiteId}-report-home`), { recursive: true, force: true });
        await rm(join(stateDir, `${suiteId}-overlap-repro-home`), { recursive: true, force: true });
        await rm(join(stateDir, `${suiteId}-repro-negative-home`), { recursive: true, force: true });
        for (const scenario of ["preparation", "export", "grading", "task-budget", "preparation-abort", "guest-preparation-abort", "tool-abort", "export-abort", "grading-abort"]) {
          await rm(join(stateDir, `${suiteId}-${scenario}-home`), { recursive: true, force: true });
        }
        if (!selectedRetainedId) await rm(testStateDir, { recursive: true, force: true });
      } else {
        process.stderr.write(`PAIRED unresolved cleanup retained explicitly: suite=${suiteDir}; claimed=${claimedRuns.map((claim) => claim.runId).join(",") || "none"}\n`);
      }
      if (selectedRetainedId && overlap) process.stdout.write(`\n${overlap.stdout}`);
    });

    it.skipIf(!recordTimings)("records five equivalent warm workloads per scheduling policy at direct operation boundaries", async () => {
      const timingClaims: ClaimedRun[] = [];
      for (const policy of ["serial", "overlap"] as const) {
        for (let sample = 1; sample <= 5; sample += 1) {
          const run = await runChild(policy, 1, { EVALS_PAIRED_TIMING_CHILD: "1" });
          timingClaims.push(run.claimed);
          expect(run.stderr).toContain("image cache hit");
          expect(run.stderr).not.toContain("image build started");
          expect(run.timing).toBeDefined();
          const timings = correctedTimingRow(run.timing!);
          expect(timings.sdkBaselineMs).toBeGreaterThanOrEqual(0);
          expect(timings.sdkTreatmentMs).toBeGreaterThanOrEqual(0);
          process.stdout.write(`PAIRED_TIMING policy=${policy} sample=${sample} ${JSON.stringify(timings)}\n`);
        }
      }
      expect(listIds("container")).toEqual(containersBefore);
      expect(listIds("network")).toEqual(networksBefore);
      expect(listIds("image")).toEqual(imagesBefore);
      for (const claim of timingClaims) claim.expectationConfirmed = true;
    }, 180_000);

    it("interrupts actual in-flight L2 preparation, tool, export, and grading stages and proves exact cleanup", async () => {
      const verifiedClaims: ClaimedRun[] = [];
      for (const scenario of ["preparation-abort", "guest-preparation-abort", "tool-abort", "export-abort", "grading-abort"] as const) {
        const outcome = await runAbortChild(scenario);
        const resourceIds = outcome.marker.resource === undefined
          ? outcome.entries.filter((entry) => entry.action === "create" && entry.event === "intent" && (entry.kind === "guest" || entry.kind === "network")).map((entry) => `${entry.kind}:${entry.name}`)
          : [`${outcome.marker.resourceKind ?? "network"}:${outcome.marker.resource}`];
        process.stdout.write(`PAIRED_ABORT stage=${scenario} operationPid=${outcome.marker.operationPid ?? "cooperative-preparer"} resources=${resourceIds.join(",") || "none"}\n`);
        if (scenario === "preparation-abort") {
          expect(outcome.marker.resourceKind).toBe("network");
          expect(outcome.marker.resource).toMatch(/^eval-prep-abort-/);
          expect(outcome.report).toBeNull();
          continue;
        }
        const conditions = outcome.report!.pairs.flatMap((pair) => pair.conditions);
        expect(conditions.some((condition) => condition.status === "infrastructure-failure")).toBe(true);
        expect(conditions.every((condition) => condition.cleanupOutcomes.every((entry) => entry.includes("verified")))).toBe(true);
        const receiptPath = join(suiteDir, "runs", outcome.report!.runId, "receipt.json");
        const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as { pairs: Array<{ conditions: Array<{ conditionId: string; dir: string }> }> };
        const baseline = receipt.pairs[0]!.conditions.find((condition) => condition.conditionId === "baseline")!;
        const treatment = receipt.pairs[0]!.conditions.find((condition) => condition.conditionId === "treatment")!;
        if (scenario === "guest-preparation-abort") {
          expect(outcome.marker.resourceKind).toBe("guest");
          expect(outcome.entries.some((entry) => entry.action === "create" && entry.event === "intent" && entry.kind === "guest" && entry.name === outcome.marker.resource)).toBe(true);
          expect(outcome.entries.some((entry) => entry.action === "create" && entry.event === "observed" && entry.kind === "network" && entry.status === "created")).toBe(true);
          expect(outcome.entries.some((entry) => entry.action === "destroy" && entry.event === "observed" && entry.kind === "guest" && entry.name === outcome.marker.resource && entry.status === "destroyed")).toBe(true);
          expect(journalConfirmsCleanup(outcome.entries)).toBe(true);
          expect(conditions.map((condition) => condition.status)).toEqual(["infrastructure-failure", "not-started"]);
          expect(outcome.stderr).not.toContain("execution started");
          expect(outcome.report!.summary?.qualityDelta).toBeNull();
        } else if (scenario === "tool-abort") {
          expect(conditions.map((condition) => condition.status)).toEqual(["infrastructure-failure", "not-started"]);
          expect(outcome.stderr.match(/\[baseline\] execution started/g)).toHaveLength(1);
          expect(outcome.stderr).not.toContain("[treatment] execution started");
          const session = await readNativeSession(receiptPath, baseline.dir);
          expect(session.available).toBe(true);
          expect(session.incompleteTail).toBe(true);
          expect(JSON.stringify(session.entries)).toContain("in-flight-bash");
          expect(JSON.stringify(session.entries)).not.toContain("must not be dispatched after interruption");
        } else if (scenario === "export-abort") {
          expect(conditions.map((condition) => condition.status)).toEqual(["infrastructure-failure", "not-started"]);
          expect(outcome.stderr.match(/execution started/g)).toHaveLength(1);
          expect(outcome.stderr).not.toContain("[treatment] execution started");
          const session = await readNativeSession(receiptPath, baseline.dir);
          expect(session.available).toBe(true);
          expect(session.incompleteTail).toBe(true);
        } else {
          expect(conditions.map((condition) => condition.status)).toEqual(["infrastructure-failure", "infrastructure-failure"]);
          expect(outcome.stderr.match(/execution started/g)).toHaveLength(2);
          for (const condition of [baseline, treatment]) {
            const session = await readNativeSession(receiptPath, condition.dir);
            expect(session.available).toBe(true);
            expect(session.incompleteTail).toBe(true);
            // The grading operation was interrupted after both SDK runs completed. The
            // receipt tail is incomplete because grading changed final disposition; the
            // SDK's terminal assistant message and every scripted tool result remain.
            const entries = session.entries as Array<{ message?: { role?: string; toolCallId?: string; content?: Array<{ type?: string; id?: string; name?: string; text?: string }> } }>;
            const content = entries.flatMap((entry) => entry.message?.content ?? []);
            expect(content.some((item) => item.type === "text" && item.text === "Synthetic workspace completed.")).toBe(true);
            for (const [id, name] of [
              ["assert-fresh-agent-boundary", "bash"],
              ["write-result", "write"],
              ["read-classification", "read"],
              ["install-classification", "bash"],
              ["edit-companion", "edit"],
            ] as const) {
              expect(content.some((item) => item.id === id && item.name === name)).toBe(true);
              expect(entries.some((entry) => entry.message?.role === "toolResult" && entry.message.toolCallId === id)).toBe(true);
            }
          }
          const validatorCreates = outcome.entries.filter((entry) => entry.action === "create" && entry.event === "intent" && entry.conditionId === null && entry.kind === "guest");
          expect(validatorCreates).toHaveLength(1);
        }
        verifiedClaims.push(outcome.claim!);
      }
      expect(listIds("container")).toEqual(containersBefore);
      expect(listIds("network")).toEqual(networksBefore);
      for (const claim of verifiedClaims) claim.expectationConfirmed = true;
    }, 360_000);

    it("retains cleaned evidence when helper or actual caller expectations fail until diagnosis", async () => {
      const beforeHelperFailure = claimedRuns.length;
      await expect(runFaultChild("task-budget", { expectedStatus: 1 })).rejects.toThrow();
      const helperClaims = claimedRuns.slice(beforeHelperFailure);
      expect(helperClaims).toHaveLength(1);

      // This failure is deliberately in the real caller after the helper has returned a
      // verified report, covering the path that helper-local fault injection cannot.
      const callerResult = await runFaultChild("export");
      await expect(verifyClaimedAttempts(callerResult.claims, () => {
        expect(callerResult.report!.status).toBe("complete");
      })).rejects.toThrow();

      for (const claim of [...helperClaims, ...callerResult.claims]) {
        expect(claim.cleanupConfirmed).toBe(true);
        expect(claim.expectationConfirmed).toBe(false);
        expect(claim.diagnosis).toContain("expectation=FAILED");
        const receipt = await readFile(join(claim.runDir!, "receipt.json"), "utf8");
        expect(receipt).toContain(claim.runId);
        expect((await verifyRun(claim.runDir!)).ok).toBe(true);
        claim.expectationConfirmed = true;
        claim.diagnosis += "; diagnosed-by-retention-regression";
      }
    }, 180_000);

    it("classifies bounded preparation, export, isolated-grading, and task-budget faults with exact cleanup", async () => {
      for (const scenario of ["preparation", "export", "grading", "task-budget"] as const) {
        const result = await runFaultChild(scenario);
        await verifyClaimedAttempts(result.claims, async () => {
          const report = result.report;
          if (scenario === "preparation") {
            expect(report).toBeNull();
            return;
          }
          expect(report).not.toBeNull();
          expect(report!.verification.ok, scenario).toBe(true);
          expect(report!.testDouble, scenario).toBe(true);
          const conditions = report!.pairs.flatMap((pair) => pair.conditions);
        if (scenario === "task-budget") {
          expect(report!.status).toBe("complete");
          expect(conditions.map((condition) => condition.status)).toEqual(["task-limit", "task-limit"]);
          expect(conditions.every((condition) => condition.gradeable)).toBe(true);
          expect(report!.counts?.infrastructureFailureCount).toBe(0);
        } else {
          expect(report!.status).toBe("partial");
          expect(report!.counts?.validPairs).toBe(0);
          expect(report!.summary?.qualityDelta).toBeNull();
          expect(conditions.every((condition) => !condition.gradeable)).toBe(true);
          expect(report!.counts?.infrastructureFailureCount).toBeGreaterThan(0);
        }
        expect(conditions.every((condition) => condition.cleanupOutcomes.length > 0)).toBe(true);
        expect(conditions.every((condition) => condition.cleanupOutcomes.every((outcome) => outcome.includes("verified")))).toBe(true);
          expect(listIds("container")).toEqual(containersBefore);
          expect(listIds("network")).toEqual(networksBefore);
        });
      }
    }, 180_000);

    it("proves overlap and two serial repetitions through exact readiness, ordering, cleanup, and warm reuse", async () => {
      overlap = await runChild("overlap", 1);
      serial = await runChild("serial", 2);
      expect(listIds("container")).toEqual(containersBefore);
      expect(listIds("network")).toEqual(networksBefore);
      expect(listIds("image")).toEqual(imagesBefore);
      assertProgressOrder(overlap, 1);
      assertProgressOrder(serial, 2);
      expect(serial.stderr).toContain("image cache hit");
      expect(serial.stderr).not.toContain("image build started");

      const journal = await readJournal(serial.claimed.journalPath!);
      for (const repetition of ["r001", "r002"]) {
        for (const kind of ["guest", "network"]) {
          const baselineDestroy = journal.find((entry) => entry.action === "destroy" && entry.event === "observed" && entry.conditionId === "baseline" && entry.kind === kind && entry.name.includes(`-${repetition}-`));
          expect(baselineDestroy, `${repetition} baseline ${kind} destruction missing from journal`).toMatchObject({ status: "destroyed" });
          const beforeTreatment = journal.find((entry) => entry.action === "verify" && entry.event === "observed" && entry.conditionId === "treatment" && entry.kind === kind && entry.name === baselineDestroy?.name);
          expect(beforeTreatment, `${repetition} baseline ${kind} pre-treatment absence missing from journal`).toMatchObject({ status: "absent" });
          expect(baselineDestroy!.sequence).toBeLessThan(beforeTreatment!.sequence);
        }
      }
      const priorArmDestroys = journal.filter((entry) => entry.action === "destroy" && entry.event === "observed" && entry.name.includes("-r001-") && (entry.kind === "guest" || entry.kind === "network"));
      const nextPairCreate = journal.find((entry) => entry.action === "create" && entry.event === "intent" && entry.name.includes("-r002-"));
      expect(priorArmDestroys).toHaveLength(4);
      expect(nextPairCreate).toBeDefined();
      expect(Math.max(...priorArmDestroys.map((entry) => entry.sequence))).toBeLessThan(nextPairCreate!.sequence);
      const allArmDestroys = journal.filter((entry) => entry.action === "destroy" && entry.event === "observed" && entry.conditionId !== null && (entry.kind === "guest" || entry.kind === "network"));
      const validatorCreates = journal.filter((entry) => entry.action === "create" && entry.event === "intent" && entry.conditionId === null && (entry.kind === "guest" || entry.kind === "network"));
      expect(allArmDestroys).toHaveLength(8);
      expect(validatorCreates).toHaveLength(8);
      expect(Math.max(...allArmDestroys.map((entry) => entry.sequence))).toBeLessThan(Math.min(...validatorCreates.map((entry) => entry.sequence)));
    }, 360_000);

    it("verifies fresh identities/state, hidden-input isolation, evidence, tool effects, reports, and HTML", async () => {
      const allSessionIds = new Set<string>();
      const allGuestNames = new Set<string>();
      const allNetworkNames = new Set<string>();
      for (const run of [overlap!, serial!]) {
        const expectedPairs = run.policy === "overlap" ? 1 : 2;
        const report = await buildRunReport(run.receipt);
        expect(report.verification.ok).toBe(true);
        expect(report.testDouble).toBe(true);
        expect(report.evidenceLabel).toContain("TEST-DOUBLE EVIDENCE");
        expect(report.summary).toMatchObject({ baselineMean: 0, treatmentMean: 1, qualityDelta: 1 });
        expect(report.counts).toMatchObject({ validPairs: expectedPairs, attemptedPairs: expectedPairs, infrastructureFailureCount: 0 });
        expect(report.pairs.every((pair) => pair.conditions.map((condition) => condition.skillPathCount).join(",") === "0,1")).toBe(true);
        expect(report.pairs.every((pair) => new Set(pair.conditions.map((condition) => condition.imageDigest)).size === 1)).toBe(true);
        expect(report.pairs.every((pair) => pair.conditions.every((condition) => condition.cleanupOutcomes.every((outcome) => outcome.includes("verified"))))).toBe(true);
        const policy = JSON.parse(await readFile(join(dirname(run.receipt), "inputs/policy.json"), "utf8"));
        expect(policy.execution.schedulingPolicy).toBe(run.policy);
        const receipt = JSON.parse(await readFile(run.receipt, "utf8")) as { pairs: Array<{ conditions: Array<{ conditionId: string; dir: string }> }> };
        expect(receipt.pairs).toHaveLength(expectedPairs);
        for (const pair of receipt.pairs) {
          for (const condition of pair.conditions) {
            const candidate = await readCandidate(run.receipt, condition.dir);
            expect([...candidate.includedPaths].sort()).toEqual(["companion.txt", "fresh-state.txt", "nested/result.txt"]);
            expect(JSON.stringify(candidate)).not.toContain("grader-only-token");
            const sealedAttestation = JSON.parse(await readFile(join(dirname(run.receipt), condition.dir, "attestation.json"), "utf8"));
            expect(sealedAttestation.observed).toMatchObject({ source: "apple-container-guest", testDouble: false, hostBackedMounts: [], unexpectedWritableMounts: [] });
            const conditionRecord = JSON.parse(await readFile(join(dirname(run.receipt), condition.dir, "condition.json"), "utf8"));
            expect(conditionRecord.runtime.allowedTools).toEqual(["read", "write", "edit", "bash"]);
            expect(conditionRecord.runtime.activeTools).toEqual(["read", "write", "edit", "bash", "mcp"]);
            expect(conditionRecord.runtime.mcpClientId).toBe(MCP_CLIENT_POLICY.id);
            expect(conditionRecord.runtime.seededMcpServers).toEqual([]);
            expect(allGuestNames.has(sealedAttestation.guestName)).toBe(false);
            expect(allNetworkNames.has(sealedAttestation.networkName)).toBe(false);
            allGuestNames.add(sealedAttestation.guestName);
            allNetworkNames.add(sealedAttestation.networkName);
            const session = await readNativeSession(run.receipt, condition.dir);
            expect(session.available).toBe(true);
            expect(session.incompleteTail).toBe(false);
            const header = session.header as { id: string; cwd: string };
            expect(header.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
            expect(header.cwd).toBe("/work");
            expect(allSessionIds.has(header.id)).toBe(false);
            allSessionIds.add(header.id);
            expect(session.redactions.count).toBeGreaterThan(0);
            const native = JSON.stringify(session.entries);
            expect(native).not.toContain(`paired-synthetic-canary-${suiteId}`);
            expect(native).not.toContain("grader-only-token");
            expect(native).not.toContain("grader received a credential");
            const messages = session.entries as Array<{ message?: { content?: Array<{ id?: string; arguments?: { command?: string }; text?: string }>; isError?: boolean; toolCallId?: string } }>;
            const toolCalls = messages.flatMap((entry) => entry.message?.content ?? []).filter((content) => content.id !== undefined);
            expect(new Set(toolCalls.map((content) => (content as { name?: string }).name))).toEqual(new Set(["bash", "write", "read", "edit"]));
            const boundaryCalls = toolCalls.filter((content) => content.id === "assert-fresh-agent-boundary");
            const boundaryResults = messages.filter((entry) => entry.message?.toolCallId === "assert-fresh-agent-boundary");
            expect(boundaryCalls).toHaveLength(1);
            expect(boundaryResults).toHaveLength(1);
            const boundaryCall = boundaryCalls[0];
            const boundaryResult = boundaryResults[0]!.message;
            expect(boundaryCall?.arguments?.command).toContain('test ! -e "$HOME/.paired-fresh"');
            expect(boundaryCall?.arguments?.command).toContain('test ! -e "$TMPDIR/paired-fresh"');
            expect(boundaryCall?.arguments?.command).toContain("test ! -e oracle.json");
            expect(boundaryCall?.arguments?.command).toContain("test ! -e validator.ts");
            expect(boundaryResult?.isError).toBe(false);
            const boundaryOutput = boundaryResult?.content?.map((content) => content.text ?? "").join("\n") ?? "";
            expect(boundaryOutput).toContain("agent-boundary-fresh");
          }
        }
        expect((await readFile(run.baselineHtml, "utf8")).length).toBeGreaterThan(1_000);
        expect((await readFile(run.treatmentHtml, "utf8")).length).toBeGreaterThan(1_000);
        const before = await chainedHashes(dirname(run.receipt));
        const rendered = formatRunReport(report, { format: "table" });
        expect(extractTable(run.stdout)).toBe(extractTable(rendered));
        const reportHome = join(stateDir, `${suiteId}-report-home`);
        await mkdir(reportHome, { recursive: true });
        const external = spawnSync(process.execPath, ["--experimental-strip-types", reportScript, "--receipt", run.receipt], { cwd: process.cwd(), encoding: "utf8", env: buildAllowlistedEnv(reportHome), timeout: 30_000 });
        expect(external.status, external.stderr).toBe(0);
        expect(extractTable(external.stdout)).toBe(extractTable(run.stdout));
        expect(await chainedHashes(dirname(run.receipt))).toEqual(before);
        expect((await verifyRun(dirname(run.receipt))).ok).toBe(true);
      }
      expect(allSessionIds.size).toBe(6);
      expect(allGuestNames.size).toBe(6);
      expect(allNetworkNames.size).toBe(6);
      for (const claim of [overlap!.claimed, serial!.claimed]) claim.expectationConfirmed = true;
    }, 60_000);
  });
}
