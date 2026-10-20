/**
 * @notice Verifies paired evaluation parity, lifecycle, grading, evidence sealing, cleanup, and interruption behavior.
 */

import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PARITY_FIELDS, buildManifestTree, canonicalJson, canonicalJsonSha256, resourceNameFor, runIdFor, sha256Hex } from "../core/experiment.ts";
import { EMPTY_SKILL_TOOL_BUNDLE } from "../core/skill-tools.ts";
import type { RunPlan } from "../core/experiment.ts";
import { EvalError } from "../core/types.ts";
import { scanManyForSecrets } from "../core/secret-scan.ts";
import { createFakeHarness } from "../harnesses/fake.ts";
import type { FakeHarnessScript } from "../harnesses/fake.ts";
import { createPiHarness } from "../harnesses/pi/adapter.ts";
import { createScriptedStreamSimple } from "../harnesses/pi/scripted-stream.ts";
import { createFakeSandbox } from "../sandboxes/fake.ts";
import { createInProcessValidatorRunner } from "./validation.ts";
import { readRunJournal } from "../artifacts/store.ts";
import type { JournalEntry } from "../artifacts/store.ts";
import { exportNativeSessionView, inspectCondition, verifyRun, buildRunReport, formatRunReport, readCandidate } from "../artifacts/queries.ts";
import type { Harness } from "../harnesses/harness.ts";
import type { Sandbox } from "../sandboxes/sandbox.ts";
import type { ValidatorRunner } from "./validation.ts";
import {
  assertModeAllows,
  disposeRunWorkDir,
  runPairedEvaluation,
} from "./run.ts";

describe("empty-bundle digest pin", () => {
  it("pins the empty-bundle digest that hand-written guest fixtures hard-code", () => {


    expect(canonicalJsonSha256(EMPTY_SKILL_TOOL_BUNDLE)).toBe(
      "f9cc8e2b85ebe6aa64c21b5be039960cdc74a5743ca280d0f84c440f745c993b",
    );
  });
});

describe("startup deadline and image build", () => {
  it("bounds image build by the startup deadline (invocation clock + startup allowance) and actively cancels it", async () => {
    const base = createFakeSandbox();
    let buildStopped = false;
    let buildDeadlineAtMs: number | undefined;
    const sandbox: Sandbox = {
      ...base,
      async buildImage(spec) {
        buildDeadlineAtMs = spec.deadlineAtMs;
        await new Promise<void>((_resolve, reject) => {
          const stop = () => { buildStopped = true; reject(spec.signal?.reason); };
          if (spec.signal?.aborted) stop();
          else spec.signal?.addEventListener("abort", stop, { once: true });
        });
        throw new Error("unreachable");
      },
    };


    const invocationStartedAtMs = Date.now() - 600;
    const { result } = await runFake({ sandbox, startupAllowanceMs: 1_000, invocationStartedAtMs });
    expect(buildDeadlineAtMs).toBe(invocationStartedAtMs + 1_000);
    expect(buildStopped).toBe(true);
    expect(result.status).toBe("partial");
    expect(result.stopReason).toContain("deadline");
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ failureClass: "infrastructure" }),
    ]));
  });
});
import type { RunOptions, RunResult } from "./run.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const evalsRoot = repoRoot;
const SUITE = "network-config-01";
const CASE = "network-config-01";

const workDirs: string[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  while (workDirs.length > 0) {
    const dir = workDirs.pop();
    if (dir !== undefined) await disposeRunWorkDir(dir);
  }
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

interface Harnessed {
  readonly result: RunResult;
  readonly runDir: string;
  readonly stateDir: string;
}

async function createTempEvalsRootWithRubric(rubric: unknown): Promise<string> {
  const tempEvals = await mkdtemp(join(tmpdir(), "eval-rubric-evals-"));
  tempRoots.push(tempEvals);
  const sourceCaseDir = join(evalsRoot, "eval-cases", "arbitrum-docs", "network-config-01");
  const targetCaseDir = join(tempEvals, "eval-cases", "arbitrum-docs", "network-config-01");
  await mkdir(join(tempEvals, "eval-cases", "arbitrum-docs"), { recursive: true });
  await cp(sourceCaseDir, targetCaseDir, {
    recursive: true,
    filter: (src) => relative(sourceCaseDir, src).split(sep)[0] !== "runs",
  });



  await symlink(join(evalsRoot, "container"), join(tempEvals, "container"));
  await writeFile(join(targetCaseDir, "rubric.json"), JSON.stringify(rubric, null, 2), "utf8");
  return tempEvals;
}

async function runFake(
  overrides: Partial<RunOptions> & { readonly script?: FakeHarnessScript } = {},
): Promise<Harnessed> {
  const root = await mkdtemp(join(tmpdir(), "eval-run-test-"));
  tempRoots.push(root);
  const workDir = await mkdtemp(join(tmpdir(), "eval-run-work-"));
  workDirs.push(workDir);
  const runId = overrides.runId ?? runIdFor(new Date(0), "abcdef12");

  const { script, ...rest } = overrides;
  const options: RunOptions = {
    evalsRoot,
    repoRoot,
    caseSelector: CASE,
    skillPath: "skills/arbitrum-docs",
    mode: "fake",
    repetitions: 1,
    cliLimits: {},
    target: { provider: "google", model: "fake-model-0", thinking: "off" },
    runId,
    resourceNonce: "0a1b2c3d",
    createdAt: new Date(0).toISOString(),
    source: { revision: "0".repeat(40), dirty: false },
    evaluatorBuild: "evals-src@test",
    harness: createFakeHarness(script === undefined ? {} : { script }),
    sandbox: createFakeSandbox(),
    validatorRunner: createInProcessValidatorRunner(),
    workDir,
    runsRoot: join(root, "runs"),
    stateDir: join(root, ".state"),
    ...rest,
  };

  const result = await runPairedEvaluation(options);
  return { result, runDir: result.runDir, stateDir: join(root, ".state") };
}

async function readRecord(runDir: string, relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(runDir, relativePath), "utf8")) as Record<string, unknown>;
}

function conditionDir(runId: string, conditionId: string): string {
  return `pairs/${runId}-r001/${conditionId}`;
}

async function resealChangedRecord(runDir: string, relativePath: string, value: unknown): Promise<void> {
  const body = `${canonicalJson(value)}\n`;
  await chmod(join(runDir, relativePath), 0o600);
  await writeFile(join(runDir, relativePath), body);
  const manifestPath = join(runDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { schemaVersion: number; entries: Array<{ path: string; sha256: string; bytes: number }> };
  await chmod(manifestPath, 0o600);
  manifest.entries = manifest.entries.map((entry) => entry.path === relativePath ? { path: relativePath, sha256: sha256Hex(body), bytes: Buffer.byteLength(body) } : entry);
  const tree = buildManifestTree(manifest.entries, manifest.schemaVersion);
  const manifestBody = `${canonicalJson(tree)}\n`;
  await writeFile(manifestPath, manifestBody);
  const receiptPath = join(runDir, "receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, any>;
  await chmod(receiptPath, 0o600);
  receipt.manifest = { treeSha256: tree.treeSha256, fileSha256: sha256Hex(manifestBody) };
  await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);
}

/** The exact identity the plan will derive, so a fault can name it before it exists. */
function guestNameFor(runId: string, conditionId: "baseline" | "treatment"): string {
  return resourceNameFor("guest", { runId, resourceNonce: "0a1b2c3d" }, 1, conditionId);
}

function networkNameFor(runId: string, conditionId: "baseline" | "treatment"): string {
  return resourceNameFor("net", { runId, resourceNonce: "0a1b2c3d" }, 1, conditionId);
}

/** Every regular file under a sealed run, as raw bytes. */
async function sealedFiles(runDir: string): Promise<Array<{ path: string; content: Buffer }>> {
  const found: Array<{ path: string; content: Buffer }> = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const target = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
        continue;
      }
      found.push({ path: target, content: await readFile(target) });
    }
  };
  await walk(runDir);
  return found;
}

describe("skill presence is the only difference", () => {
  it("runs alternate skills against the same task and records the complete selected setup", async () => {
    const docs = await runFake();
    const network = await runFake({ skillPath: "skills/arbitrum-onchain" });
    const docsCase = await readRecord(docs.runDir, "inputs/case.json");
    const networkCase = await readRecord(network.runDir, "inputs/case.json");
    expect(networkCase).toEqual(docsCase);
    const docsSkill = await readRecord(docs.runDir, "inputs/skill-snapshot.json");
    const networkSkill = await readRecord(network.runDir, "inputs/skill-snapshot.json");
    expect(docsSkill.sourcePath).toBe("skills/arbitrum-docs");
    expect(networkSkill.sourcePath).toBe("skills/arbitrum-onchain");
    expect(networkSkill.treeSha256).not.toBe(docsSkill.treeSha256);
    expect((networkSkill.files as { path: string }[]).some((file) => file.path === "SKILL.md")).toBe(true);
    for (const { result, runDir } of [docs, network]) {
      const baseline = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
      const treatment = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/condition.json`);
      expect(baseline.skillPaths).toEqual([]);
      expect(treatment.skillPaths).toHaveLength(1);
      expect((baseline.parity as Record<string, unknown>).limits).toEqual((treatment.parity as Record<string, unknown>).limits);
      expect((await readRecord(runDir, "receipt.json")).caseSelector).toBe("network-config-01");
    }
    expect((await readRecord(network.runDir, "inputs/policy.json")).limits).toEqual((await readRecord(docs.runDir, "inputs/policy.json")).limits);
  });

  it("gives baseline zero skill paths and treatment exactly one frozen snapshot path", async () => {
    const { result, runDir } = await runFake();
    const baseline = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
    const treatment = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/condition.json`);

    expect(baseline.skillPaths).toEqual([]);
    expect(treatment.skillPaths).toEqual(["/opt/skills/network-config-01"]);

    // The harness itself must have observed the same thing, not just the plan.
    expect((baseline.runtime as { skillPaths: string[] }).skillPaths).toEqual([]);
    expect((treatment.runtime as { skillPaths: string[] }).skillPaths).toEqual(["/opt/skills/network-config-01"]);
  });

  it("binds the frozen skill snapshot tree hash to BOTH arms, and it matches the snapshot record", async () => {
    const { result, runDir } = await runFake();
    const snapshot = await readRecord(runDir, "inputs/skill-snapshot.json");
    const baseline = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
    const treatment = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/condition.json`);

    const treeSha256 = snapshot.treeSha256 as string;
    expect(treeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((baseline.parity as Record<string, unknown>).skillSnapshotTreeSha256).toBe(treeSha256);
    expect((treatment.parity as Record<string, unknown>).skillSnapshotTreeSha256).toBe(treeSha256);
    // Only treatment stages it; both arms are bound to it.
    expect(snapshot.stagedInConditions).toEqual(["treatment"]);
    expect(snapshot.boundToConditions).toEqual(["baseline", "treatment"]);
    expect((snapshot.fileCount as number) > 0).toBe(true);
  });

  it("seals the declared skill tool bundle and binds its hash to both arms", async () => {
    const { result, runDir } = await runFake();
    const bundle = await readRecord(runDir, "inputs/skill-tool-bundle.json");
    const baseline = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
    const treatment = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/condition.json`);

    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.source).toBe("agents/openai.yaml");
    expect(bundle.servers).toHaveLength(1);
    expect((bundle.servers as Array<{ name: string }>)[0]?.name).toBe("arbitrumDocs");

    const bundleSha256 = canonicalJsonSha256(bundle);
    expect((baseline.parity as Record<string, unknown>).skillToolBundleSha256).toBe(bundleSha256);
    expect((treatment.parity as Record<string, unknown>).skillToolBundleSha256).toBe(bundleSha256);
  });

  it("threads skillToolBundle: null to baseline harness request and resolved bundle to treatment", async () => {
    const requests: Record<string, any> = {};
    const baseHarness = createFakeHarness();
    const spyingHarness: Harness = {
      ...baseHarness,
      run: async (guest, req) => {
        requests[req.conditionId] = req;
        return baseHarness.run(guest, req);
      },
    };
    await runFake({ harness: spyingHarness });
    expect(requests.baseline.skillToolBundle).toBeNull();
    expect(requests.treatment.skillToolBundle).not.toBeNull();
    expect(requests.treatment.skillToolBundle.servers[0].name).toBe("arbitrumDocs");
    expect(requests.baseline.skillToolBundleSha256).toBe(requests.treatment.skillToolBundleSha256);
  });
});

describe("parity", () => {
  it("runs both arms from one identical image digest with all 23 parity fields identical", async () => {
    const { result, runDir } = await runFake();
    const plan = (await readRecord(runDir, "inputs/plan.json")) as unknown as RunPlan;
    const baseline = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
    const treatment = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/condition.json`);

    expect(baseline.imageDigest).toBe(treatment.imageDigest);
    expect(String(baseline.imageDigest)).toMatch(/^sha256:[0-9a-f]{64}$/);

    const left = baseline.parity as Record<string, unknown>;
    const right = treatment.parity as Record<string, unknown>;
    // Collection mode, validator closure, and skill tool bundle are included in parity.
    expect(PARITY_FIELDS).toHaveLength(23);
    for (const field of PARITY_FIELDS) {
      expect(canonicalJson(left[field], field)).toBe(canonicalJson(right[field], field));
      expect(left[field]).not.toBeUndefined();
      expect(left[field]).not.toBeNull();
      if (typeof left[field] === "string") expect(left[field]).not.toBe("");
    }
    // Case identity and policy, skill snapshot, and tool bundle hashes must be populated.
    expect(left.caseId).toBe("network-config-01");
    expect(left.caseVersion).toBe(10);
    expect(String(left.executionPolicySha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(left.skillSnapshotTreeSha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(left.skillToolBundleSha256)).toMatch(/^[0-9a-f]{64}$/);

    expect(plan.planSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.conditions[0].conditionId).toBe("baseline");
    expect(plan.conditions[1].conditionId).toBe("treatment");
  });

  it("records the effective workspace collection policy explicitly in every frozen record", async () => {
    const { result, runDir } = await runFake();
    // The authored case carries no candidateMode: the fresh-run policy is resolved once,
    // before freezing and dispatch, and every frozen record states it.
    const frozenConfig = await readRecord(runDir, "inputs/frozen/case/case.json");
    expect(frozenConfig.candidateMode).toBe("workspace");
    const caseSummary = await readRecord(runDir, "inputs/case.json");
    expect(caseSummary.candidateMode).toBe("workspace");
    const policy = await readRecord(runDir, "inputs/policy.json");
    expect((policy.execution as { candidateMode: unknown }).candidateMode).toBe("workspace");
    const plan = (await readRecord(runDir, "inputs/plan.json")) as unknown as RunPlan;
    expect(plan.parity.candidateMode).toBe("workspace");
    for (const condition of plan.conditions) expect(condition.parity.candidateMode).toBe("workspace");
    for (const arm of ["baseline", "treatment"] as const) {
      const candidate = await readRecord(runDir, `${conditionDir(result.runId, arm)}/candidate.json`);
      expect(candidate.candidateMode).toBe("workspace");
    }
  });

  it("hashes an execution policy that names arm order, sequencing, and the re-run prohibition", async () => {
    const { runDir } = await runFake();
    const policy = (await readRecord(runDir, "inputs/policy.json")).execution as Record<string, unknown>;
    expect(policy.armOrder).toEqual(["baseline", "treatment"]);
    expect(policy.sequentialExecution).toBe(true);
    expect(policy.destroyPreviousBeforeNext).toBe(true);
    expect(policy.verifyDestructionBeforeNext).toBe(true);
    expect(policy.cleanupOnFailure).toBe(true);
    expect(policy.autoRerunForBetterResult).toBe(false);
  });
});

describe("sequential execution and verified destruction", () => {
  it("prepares both serial guests, then destroys and verifies baseline before treatment dispatch", async () => {
    const { result, stateDir } = await runFake();
    const entries = await readRunJournal(stateDir, result.runId);
    const key = (entry: JournalEntry): string =>
      `${entry.event}:${entry.action}:${entry.kind}:${entry.conditionId}:${entry.status ?? "-"}`;
    const at = (needle: string): number => {
      const index = entries.findIndex((entry) => key(entry) === needle);
      expect(index, `journal is missing ${needle}`).toBeGreaterThanOrEqual(0);
      return index;
    };

    const baselineGuestCreated = at("observed:create:guest:baseline:created");
    const baselineGuestDestroyed = at("observed:destroy:guest:baseline:destroyed");
    const baselineNetDestroyed = at("observed:destroy:network:baseline:destroyed");
    // The verification is journaled under the condition that is about to start.
    const guestVerifiedAbsent = at("observed:verify:guest:treatment:absent");
    const netVerifiedAbsent = at("observed:verify:network:treatment:absent");
    const treatmentNetIntent = at("intent:create:network:treatment:-");
    const treatmentGuestIntent = at("intent:create:guest:treatment:-");

    expect(baselineGuestCreated).toBeLessThan(treatmentNetIntent);
    expect(treatmentNetIntent).toBeLessThan(treatmentGuestIntent);
    expect(treatmentGuestIntent).toBeLessThan(baselineGuestDestroyed);
    expect(baselineGuestDestroyed).toBeLessThan(guestVerifiedAbsent);
    expect(baselineNetDestroyed).toBeLessThan(netVerifiedAbsent);

    // Every create is journaled with its exact intended identity BEFORE the effect.
    for (const observed of entries.filter((entry) => entry.event === "observed" && entry.action === "create")) {
      const intent = entries.find(
        (entry) => entry.event === "intent" && entry.action === "create" && entry.kind === observed.kind,
      );
      expect(intent).toBeDefined();
      expect((intent as JournalEntry).sequence).toBeLessThan(observed.sequence);
    }
  });

  it("records a verified cleanup outcome for every condition and sweeps every journaled identity", async () => {
    const { result, runDir, stateDir } = await runFake();
    for (const conditionId of ["baseline", "treatment"]) {
      const condition = await readRecord(runDir, `${conditionDir(result.runId, conditionId)}/condition.json`);
      const cleanup = condition.cleanup as Array<{ kind: string; status: string; verified: boolean }>;
      expect(cleanup.map((entry) => entry.kind)).toEqual(["guest", "network"]);
      expect(cleanup.every((entry) => entry.status === "destroyed" && entry.verified)).toBe(true);
    }

    const entries = await readRunJournal(stateDir, result.runId);
    // Sweep cleans up per-run resources (guest, network), preserving shared cached images.
    const createdPerRunNames = new Set(
      entries
        .filter((entry) => entry.action === "create" && entry.kind !== "image")
        .map((entry) => `${entry.kind}:${entry.name}`),
    );
    const sweep = (await readRecord(runDir, "cleanup.json")).sweep as Array<{ kind: string; name: string }>;
    expect(new Set(sweep.map((entry) => `${entry.kind}:${entry.name}`))).toEqual(createdPerRunNames);
  });

  it("writes the receipt only after every cleanup outcome is known", async () => {
    const { result, runDir } = await runFake();
    const receipt = await readRecord(runDir, "receipt.json");
    const cleanup = receipt.cleanup as Array<{ status: string }>;
    expect(cleanup.length).toBeGreaterThan(0);
    expect(cleanup.every((entry) => entry.status === "destroyed" || entry.status === "already-absent")).toBe(true);

    // Ordering on disk: the receipt cannot predate the cleanup record it embeds.
    const receiptStat = await stat(join(runDir, "receipt.json"));
    const cleanupStat = await stat(join(runDir, "cleanup.json"));
    expect(receiptStat.mtimeMs).toBeGreaterThanOrEqual(cleanupStat.mtimeMs);
  });
});

describe("delta validity", () => {
  it("seals delta: null with a reason when an arm is ungradeable, and never a number", async () => {
    const script: FakeHarnessScript = (request) =>
      request.conditionId === "treatment"
        ? { outcome: "infrastructure-failure", assistantText: "guest protocol drift" }
        : { outcome: "completed", assistantText: "done" };

    const { result, runDir } = await runFake({ script });
    const pair = await readRecord(runDir, `pairs/${result.runId}-r001/pair.json`);
    expect(pair.delta).toBeNull();
    expect(pair.gradeable).toBe(false);
    expect(String(pair.deltaReason)).toContain("treatment");

    const treatment = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/condition.json`);
    expect(treatment.gradeable).toBe(false);
    expect(treatment.failureClass).toBe("infrastructure");

    // An infrastructure outcome is never recorded as a task score.
    const validation = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/validation.json`);
    expect(validation.outcome).toBeNull();
  });

  it("treats a task-limit stop as a gradeable task outcome that may score low", async () => {
    const script: FakeHarnessScript = () => ({ outcome: "task-limit", assistantText: "ran out of steps" });
    const { result, runDir } = await runFake({ script });
    const baseline = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
    expect(baseline.status).toBe("task-limit");
    expect(baseline.gradeable).toBe(true);
    expect(baseline.failureClass).toBe("task");

    const pair = await readRecord(runDir, `pairs/${result.runId}-r001/pair.json`);
    expect(pair.gradeable).toBe(true);
    expect(typeof pair.delta).toBe("number");
  });
  it("preserves full pass and paired comparison when a task-limit output satisfies the rubric", async () => {
    const passingChecks = [
      "production-chain-identity", "staging-chain-identity",
      "production-legacy-fallback", "staging-legacy-fallback",
      "production-rpc-endpoints", "staging-rpc-endpoints",
      "production-sequencer-policy", "staging-sequencer-policy",
      "production-token-identity", "staging-token-identity",
      "production-bridge-addresses", "staging-bridge-addresses",
      "production-bridge-onboarding", "staging-bridge-onboarding",
      "production-finality-policy", "staging-finality-policy",
      "json-shape", "preservation",
    ].map((id) => ({ id, passed: true, message: "correct" }));

    const validatorRunner: ValidatorRunner = {
      id: "passing-validator", testDouble: true,
      async run() {
        return { runnerId: this.id, testDouble: true, durationMs: 1, failure: null,
          outcome: { status: "graded", score: 1, fullPass: true, checks: passingChecks } };
      },
    };
    const { result, runDir } = await runFake({
      script: () => ({ outcome: "task-limit", assistantText: "output is ready" }), validatorRunner,
    });
    expect(result.status).toBe("complete");
    for (const arm of ["baseline", "treatment"]) {
      const condition = await readRecord(runDir, `${conditionDir(result.runId, arm)}/condition.json`);
      expect(condition).toMatchObject({ status: "task-limit", gradeable: true });
      const validation = await readRecord(runDir, `${conditionDir(result.runId, arm)}/validation.json`);
      expect(validation.outcome).toMatchObject({ score: 1, fullPass: true });
    }
    const pair = await readRecord(runDir, `pairs/${result.runId}-r001/pair.json`);
    expect(pair).toMatchObject({ gradeable: true, delta: 0 });
  });

  it("proves a local unsolicited abort is inspectable but ungraded with stopCause unexpected-abort", async () => {
    const streamSimpleOverride = createScriptedStreamSimple([
      {
        type: "text",
        text: "partial progress before unsolicited abort",
        stopReason: "aborted",
      },
    ]);
    const harness = createPiHarness({ streamSimpleOverride });
    const { result, runDir } = await runFake({
      harness,
      target: { provider: "google", model: "gemini-3.8-flash", thinking: "low" },
    });

    // Both arms hit unsolicited abort and classify as infrastructure-failure / unexpected-abort
    const baseline = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
    expect(baseline.status).toBe("infrastructure-failure");
    expect(baseline.stopCause).toBe("unexpected-abort");
    expect(baseline.gradeable).toBe(false);
    expect(baseline.failureClass).toBe("infrastructure");

    // Pair comparison is ungradeable and delta is null
    const pair = await readRecord(runDir, `pairs/${result.runId}-r001/pair.json`);
    expect(pair.gradeable).toBe(false);
    expect(pair.delta).toBeNull();
    expect(String(pair.deltaReason)).toContain("baseline");

    // Condition evidence is preserved and inspectable: condition, session, validation
    const session = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/session.json`);
    expect(session).toBeDefined();

    const validation = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/validation.json`);
    expect(validation.outcome).toBeNull();

    // Verification via inspectCondition confirms evidence integrity and inspection
    const inspection = await inspectCondition({
      receiptPath: result.receiptPath,
      pairId: `${result.runId}-r001`,
      conditionId: "baseline",
      view: "condition",
    });
    expect(inspection.content).toMatchObject({
      status: "infrastructure-failure",
      stopCause: "unexpected-abort",
      gradeable: false,
    });
  });

  it("grades a task-limit arm under the frozen rubric and shows it in the accuracy and outcome checks tables", async () => {
    const ids = [
      "production-chain-identity", "staging-chain-identity",
      "production-legacy-fallback", "staging-legacy-fallback",
      "production-rpc-endpoints", "staging-rpc-endpoints",
      "production-sequencer-policy", "staging-sequencer-policy",
      "production-token-identity", "staging-token-identity",
      "production-bridge-addresses", "staging-bridge-addresses",
      "production-bridge-onboarding", "staging-bridge-onboarding",
      "production-finality-policy", "staging-finality-policy",
      "json-shape", "preservation",
    ];
    // Baseline hits a task limit with only the legacy fallback + constraints correct (30/100).
    const validatorRunner: ValidatorRunner = {
      id: "task-limit-validator", testDouble: true,
      async run(request) {
        const text = Object.values(request.input.candidateFiles).map((b64) => Buffer.from(b64, "base64").toString("utf8")).join("");
        const baseline = !text.includes("treatment");
        const passed = (id: string): boolean =>
          !baseline || id.includes("legacy-fallback") || id === "json-shape" || id === "preservation";
        return { runnerId: this.id, testDouble: true, durationMs: 1, failure: null,
          outcome: { status: "graded", score: 0, fullPass: false, checks: ids.map((id) => ({ id, passed: passed(id), message: "" })) } };
      },
    };
    const { result, runDir } = await runFake({
      script: (request) => request.conditionId === "baseline"
        ? { outcome: "task-limit", assistantText: "baseline", writes: [{ path: "config.json", text: "{\"arm\":\"baseline\"}" }] }
        : { outcome: "completed", assistantText: "treatment", writes: [{ path: "config.json", text: "{\"arm\":\"treatment\"}" }] },
      validatorRunner,
    });
    const validation = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/validation.json`);
    expect((validation.outcome as { rubricScore: { accuracyTotal: number } }).rubricScore.accuracyTotal).toBe(30);

    const report = await buildRunReport(join(runDir, "receipt.json"));
    const baseline = report.pairs[0]!.conditions.find((c) => c.conditionId === "baseline")!;
    expect(baseline.status).toBe("task-limit");
    expect(baseline.rubricScore?.groups.outcome.got).toBe(10);
    expect(report.scored?.statusLine).toBe("Without this skill: task limit reached, graded · With this skill: completed, graded");
    expect(report.scored?.accuracyTable.rows[0]?.baseline).toBe("10/80 — 13%");
    expect(report.scored?.accuracyTable.totalRow.baseline).toBe("**30/100 — 30%**");
    const fallbackRow = report.scored?.checksTable?.rows.find((row) => row.id === "legacy-fallback");
    expect(fallbackRow).toMatchObject({ baseline: "10/10", treatment: "10/10" });
    expect(formatRunReport(report, { format: "markdown", checks: true })).toContain("| Legacy RPC fallback configuration | 10/10 | 10/10 |");
  });

  it("seals authoritative rubric score, rubricVersion and rubric.json in inputs when a rubric is frozen", async () => {
    const testRubric = {
      rubricVersion: "v0.2",
      topics: [
        { id: "main-topic", label: "Main topic", points: 80 },
        { id: "rules-topic", label: "Rules topic", points: 20 },
      ],
      checks: [
        { id: "task-check-1", group: "outcome", topic: "main-topic", points: 80 },
        { id: "task-check-2", group: "constraints", topic: "rules-topic", points: 20 },
      ],
    };

    const tempEvals = await createTempEvalsRootWithRubric(testRubric);

    // Validator returns task-check-1 passed, task-check-2 failed => raw score = 1/2 = 0.5
    // Rubric score: outcome 80/80 + constraints 0/20 = 80/100 = 0.8
    const validatorRunner: ValidatorRunner = {
      id: "rubric-seal-validator",
      testDouble: true,
      async run() {
        return {
          runnerId: this.id,
          testDouble: true,
          durationMs: 1,
          failure: null,
          outcome: {
            status: "graded",
            score: 0.5,
            fullPass: false,
            checks: [
              { id: "task-check-1", passed: true, message: "ok" },
              { id: "task-check-2", passed: false, message: "failed" },
            ],
          },
        };
      },
    };

    const { result, runDir } = await runFake({ evalsRoot: tempEvals, validatorRunner });
    expect(result.status).toBe("complete");

    // inputs/rubric.json and inputs/frozen/case/rubric.json must exist
    const rubricInput = await readRecord(runDir, "inputs/rubric.json");
    expect(rubricInput.rubricVersion).toBe("v0.2");
    const frozenRubric = await readRecord(runDir, "inputs/frozen/case/rubric.json");
    expect(frozenRubric.rubricVersion).toBe("v0.2");

    // Validation.json has authoritative rubric score overwritten: 0.8 instead of 0.5
    const treatmentValidation = await readRecord(
      runDir,
      `${conditionDir(result.runId, "treatment")}/validation.json`,
    );
    expect((treatmentValidation.outcome as any).score).toBe(0.8);
    expect((treatmentValidation.outcome as any).fullPass).toBe(false);
    expect((treatmentValidation.outcome as any).rubricScore).toBeDefined();
    expect((treatmentValidation.outcome as any).rubricScore.accuracyTotal).toBe(80);
    expect((treatmentValidation.outcome as any).rubricScore.groups.outcome.got).toBe(80);
    expect((treatmentValidation.outcome as any).rubricScore.groups.constraints.got).toBe(0);

    // Receipt and pair records have rubricVersion: "v0.2"
    const receipt = await readRecord(runDir, "receipt.json");
    expect(receipt.rubricVersion).toBe("v0.2");
    const pair = await readRecord(runDir, `pairs/${result.runId}-r001/pair.json`);
    expect(pair.rubricVersion).toBe("v0.2");

    // Whole evidence directory verifies byte for byte
    const verification = await verifyRun(runDir);
    expect(verification.ok).toBe(true);
    expect(verification.failures).toEqual([]);
  });

  it("converts unknown check IDs returned by validator to infrastructure-failure when rubric is frozen", async () => {
    const testRubric = {
      rubricVersion: "v0.2",
      checks: [
        { id: "task-check-1", group: "outcome", points: 80 },
        { id: "task-check-2", group: "constraints", points: 20 },
      ],
    };

    const tempEvals = await createTempEvalsRootWithRubric(testRubric);

    const validatorRunner: ValidatorRunner = {
      id: "rubric-mismatch-validator",
      testDouble: true,
      async run() {
        return {
          runnerId: this.id,
          testDouble: true,
          durationMs: 1,
          failure: null,
          outcome: {
            status: "graded",
            score: 1,
            fullPass: true,
            checks: [
              { id: "unexpected-check-id", passed: true, message: "bogus" },
            ],
          },
        };
      },
    };

    const { result, runDir } = await runFake({ evalsRoot: tempEvals, validatorRunner });
    expect(result.status).toBe("partial");
    expect(result.stopReason).toContain("rubric scoring failed");

    // Baseline should have infrastructure-failure outcome with null score
    const baselineValidation = await readRecord(
      runDir,
      `${conditionDir(result.runId, "baseline")}/validation.json`,
    );
    expect(baselineValidation.outcome).toBeNull(); // ungradeable arm has outcome null in validation.json
    const baselineCondition = await readRecord(
      runDir,
      `${conditionDir(result.runId, "baseline")}/condition.json`,
    );
    expect(baselineCondition.status).toBe("infrastructure-failure");
    expect(baselineCondition.gradeable).toBe(false);

    const verification = await verifyRun(runDir);
    expect(verification.ok).toBe(true);
  });

});

describe("run modes", () => {
  it("refuses --mode measured while any resolved implementation is a test double", () => {
    const error = (() => {
      try {
        assertModeAllows({
          mode: "measured",
          harness: createFakeHarness(),
          sandbox: createFakeSandbox(),
          validatorRunner: createInProcessValidatorRunner(),
        });
        return null;
      } catch (cause: unknown) {
        return cause;
      }
    })();
    expect(error).toBeInstanceOf(EvalError);
    expect((error as EvalError).code).toBe("not-implemented");
    expect((error as EvalError).message).toContain("harness:fake");
    expect((error as EvalError).message).toContain("sandbox:fake");
    expect((error as EvalError).message).toContain("validator-runner:in-process");
  });

  it("refuses --mode measured if only harness is a test double", () => {
    const stubRealSandbox: Sandbox = { ...createFakeSandbox(), id: "apple-container", testDouble: false };
    const stubRealValidator: ValidatorRunner = { ...createInProcessValidatorRunner(), id: "isolated-container", testDouble: false };

    expect(() =>
      assertModeAllows({
        mode: "measured",
        harness: createFakeHarness(),
        sandbox: stubRealSandbox,
        validatorRunner: stubRealValidator,
      }),
    ).toThrowError(/refuses test doubles: harness:fake/);
  });

  it("refuses --mode measured if only sandbox is a test double", () => {
    const stubRealHarness: Harness = { ...createFakeHarness(), id: "pi", testDouble: false };
    const stubRealValidator: ValidatorRunner = { ...createInProcessValidatorRunner(), id: "isolated-container", testDouble: false };

    expect(() =>
      assertModeAllows({
        mode: "measured",
        harness: stubRealHarness,
        sandbox: createFakeSandbox(),
        validatorRunner: stubRealValidator,
      }),
    ).toThrowError(/refuses test doubles: sandbox:fake/);
  });

  it("refuses --mode measured if only validator-runner is a test double", () => {
    const stubRealHarness: Harness = { ...createFakeHarness(), id: "pi", testDouble: false };
    const stubRealSandbox: Sandbox = { ...createFakeSandbox(), id: "apple-container", testDouble: false };

    expect(() =>
      assertModeAllows({
        mode: "measured",
        harness: stubRealHarness,
        sandbox: stubRealSandbox,
        validatorRunner: createInProcessValidatorRunner(),
      }),
    ).toThrowError(/refuses test doubles: validator-runner:in-process/);
  });

  it("allows --mode measured when all three components are non-doubles", () => {
    const stubRealHarness: Harness = { ...createFakeHarness(), id: "pi", testDouble: false };
    const stubRealSandbox: Sandbox = { ...createFakeSandbox(), id: "apple-container", testDouble: false };
    const stubRealValidator: ValidatorRunner = { ...createInProcessValidatorRunner(), id: "isolated-container", testDouble: false };

    expect(() =>
      assertModeAllows({
        mode: "measured",
        harness: stubRealHarness,
        sandbox: stubRealSandbox,
        validatorRunner: stubRealValidator,
      }),
    ).not.toThrow();
  });

  it("refuses a measured run end to end", async () => {
    await expect(runFake({ mode: "measured" })).rejects.toMatchObject({ code: "not-implemented" });
  });

  it("self-labels every fake-mode record as test-double-produced", async () => {
    const { result, runDir } = await runFake();
    const receipt = await readRecord(runDir, "receipt.json");
    expect(receipt.mode).toBe("fake");
    expect(receipt.testDouble).toBe(true);
    expect(String(receipt.evidenceLabel)).toContain("not a measured result");

    const pair = await readRecord(runDir, `pairs/${result.runId}-r001/pair.json`);
    expect(pair.testDouble).toBe(true);
    for (const conditionId of ["baseline", "treatment"]) {
      const condition = await readRecord(runDir, `${conditionDir(result.runId, conditionId)}/condition.json`);
      expect(condition.testDouble).toBe(true);
      expect((condition.runtime as { testDouble: boolean }).testDouble).toBe(true);
    }
    const target = await readRecord(runDir, "inputs/target.json");
    expect((target.image as { testDouble: boolean }).testDouble).toBe(true);
  });

  it("allows a measured run with real non-doubles and stamps measured evidence without double labels", async () => {
    const delivered: Array<{ conditionId: string; variable: string; value: string }> = [];

    const baseSandbox = createFakeSandbox();
    const stubRealSandbox: Sandbox = {
      ...baseSandbox,
      id: "apple-container",
      testDouble: false,
      async buildImage(spec) {
        const img = await baseSandbox.buildImage(spec);
        return { ...img, testDouble: false };
      },
      async createGuest(spec) {
        const guest = await baseSandbox.createGuest(spec);
        return Object.create(guest, {
          attest: {
            value: async () => {
              const att = await guest.attest();
              return {
                ...att,
                testDouble: false,
                source: "apple-container-guest",
                observed: {
                  ...att.observed,
                  testDouble: false,
                  source: "apple-container-guest",
                },
              };
            },
          },
          deliverCredential: {
            value: async (req: { variable: string; value: string }) => {
              await guest.deliverCredential(req);
              delivered.push({ conditionId: spec.name, variable: req.variable, value: req.value });
            },
          },
        });
      },
    };

    const baseHarness = createFakeHarness();
    const stubRealHarness: Harness = {
      ...baseHarness,
      id: "pi",
      testDouble: false,
      async attest(guest, req) {
        const att = await baseHarness.attest(guest, req);
        return {
          ...att,
          runtime: {
            ...att.runtime,
            testDouble: false,
          },
        };
      },
      async run(guest, req) {
        const res = await baseHarness.run(guest, req);
        return {
          ...res,
          runtime: {
            ...res.runtime,
            testDouble: false,
          },
        };
      },
    };

    const baseValidator = createInProcessValidatorRunner();
    const stubRealValidator: ValidatorRunner = {
      ...baseValidator,
      id: "isolated-container",
      testDouble: false,
      async run(req) {
        const res = await baseValidator.run(req);
        return {
          ...res,
          runnerId: "isolated-container",
          testDouble: false,
        };
      },
    };

    const secretValue = "super-secret-measured-api-key";
    const { result, runDir } = await runFake({
      mode: "measured",
      target: { provider: "google", model: "gemini-3.8-flash", thinking: "low" },
      harness: stubRealHarness,
      sandbox: stubRealSandbox,
      validatorRunner: stubRealValidator,
      guardedSecrets: [{ label: "GEMINI_API_KEY", value: secretValue }],
      credentials: [{ variable: "GEMINI_API_KEY", value: secretValue }],
    });

    expect(result.failures).toEqual([]);
    expect(result.stopReason).toBeNull();
    expect(result.status).toBe("complete");

    // Receipt must NOT carry the test-double label
    const receipt = await readRecord(runDir, "receipt.json");
    expect(receipt.mode).toBe("measured");
    expect(receipt.testDouble).toBe(false);
    expect(receipt.evidenceLabel).toBe("measured evidence");
    expect(String(receipt.evidenceLabel)).not.toContain("TEST-DOUBLE");
    expect(String(receipt.evidenceLabel)).not.toContain("not a measured result");

    // Pair record
    const pair = await readRecord(runDir, `pairs/${result.runId}-r001/pair.json`);
    expect(pair.testDouble).toBe(false);
    expect(pair.evidenceLabel).toBe("measured evidence");

    // Per-condition records and attestation
    for (const conditionId of ["baseline", "treatment"]) {
      const condition = await readRecord(runDir, `${conditionDir(result.runId, conditionId)}/condition.json`);
      expect(condition.testDouble).toBe(false);
      expect(condition.evidenceLabel).toBe("measured evidence");
      expect((condition.runtime as { testDouble: boolean }).testDouble).toBe(false);

      const attestation = await readRecord(runDir, `${conditionDir(result.runId, conditionId)}/attestation.json`);
      expect(attestation.testDouble).toBe(false);
      expect(attestation.evidenceLabel).toBe("measured evidence");
      expect((attestation.observed as { testDouble: boolean }).testDouble).toBe(false);
    }

    // inputs/target.json
    const target = await readRecord(runDir, "inputs/target.json");
    expect((target.image as { testDouble: boolean }).testDouble).toBe(false);

    // Human reports omit routine evidence metadata and retain synthetic-result labels.
    const report = await buildRunReport(result.receiptPath);
    expect(report.evidenceLabel).toBe("measured evidence");
    const formatted = formatRunReport(report);
    expect(formatted).not.toMatch(/^evidence\s/m);
    expect(formatted).not.toContain("TEST-DOUBLE");
    expect(formatted).not.toContain("not a measured result");

    // Credentials delivered post-attestation to both arms
    expect(delivered.length).toBe(2);
    expect(delivered[0]?.variable).toBe("GEMINI_API_KEY");
    expect(delivered[0]?.value).toBe(secretValue);
    expect(delivered[1]?.variable).toBe("GEMINI_API_KEY");
    expect(delivered[1]?.value).toBe(secretValue);

    // Secret must NEVER appear in any sealed evidence file
    const files = await sealedFiles(runDir);
    for (const file of files) {
      expect(file.content.toString("utf8")).not.toContain(secretValue);
    }
  });
});

describe("preflight and evidence shape", () => {
  it("rethrows a bad selector instead of continuing to dispatch", async () => {
    await expect(runFake({ caseSelector: "no-such-case" })).rejects.toMatchObject({ code: "input-invalid" });
  });

  it("never creates a latest pointer, alias, or symlink inside a run", async () => {
    const { runDir } = await runFake();
    const names: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        expect(entry.isSymbolicLink()).toBe(false);
        names.push(entry.name);
        if (entry.isDirectory()) await walk(join(dir, entry.name));
      }
    };
    await walk(runDir);
    expect(names).not.toContain("latest");
    expect(names).not.toContain("current");
  });

  it("stores the raw exported workspace separately from the projected candidate", async () => {
    const { result, runDir } = await runFake({
      script: () => ({
        outcome: "completed",
        writes: [{ path: "scratch.txt", text: "notes the validator must not see" }],
      }),
    });
    const dir = conditionDir(result.runId, "treatment");
    const workspace = await readRecord(runDir, `${dir}/workspace.json`);
    const candidate = await readRecord(runDir, `${dir}/candidate.json`);

    const workspacePaths = (workspace.files as Array<{ path: string }>).map((file) => file.path);
    expect(workspacePaths).toContain("scratch.txt");
    expect(workspacePaths).toContain("config.json");
    // A fresh run grades the bounded final workspace, and the record states that policy
    // explicitly. The raw export stays a separate record from the projected candidate.
    expect(candidate.candidateMode).toBe("workspace");
    expect(candidate.outputPath).toBe("config.json");
    expect(candidate.includedPaths).toEqual(["config.json", "scratch.txt"]);
    expect(candidate.skipped).toEqual([]);
    expect(candidate.projected).toBe(true);
  });
});

describe("interruption", () => {
  it("seals partial evidence with an explicit not-started condition that still verifies", async () => {
    const controller = new AbortController();
    // Abort while the FIRST condition is executing, so the second never starts.
    const script: FakeHarnessScript = (request) => {
      if (request.conditionId === "baseline") controller.abort();
      return { outcome: "completed", assistantText: "interrupted" };
    };

    const { result, runDir } = await runFake({ script, signal: controller.signal });
    expect(result.status).toBe("partial");
    expect(result.stopReason).not.toBeNull();

    // The baseline arm is the one that was interrupted: it is an INFRASTRUCTURE outcome
    // carrying the `interrupted` code, never a task failure that could score zero.
    const baseline = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
    expect(baseline.status).toBe("infrastructure-failure");
    expect(baseline.failureClass).toBe("infrastructure");
    expect(baseline.gradeable).toBe(false);
    // The sealed stop cause of a locally-cancelled arm is the concrete cancellation cause,
    // not a null/unknown — it matches how the guest classifies the same event.
    expect(baseline.stopCause).toBe("external-cancellation");
    expect(baseline.providerStopReason).toBeNull();
    const baselineFailures = (await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/errors.json`))
      .failures as Array<{ code: string; failureClass: string }>;
    expect(baselineFailures.map((failure) => failure.code)).toContain("interrupted");
    expect(baselineFailures.every((failure) => failure.failureClass === "infrastructure")).toBe(true);
    const baselineValidation = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/validation.json`);
    expect(baselineValidation.outcome).toBeNull();
    const receiptFailures = (await readRecord(runDir, "receipt.json")).failures as Array<{ code: string }>;
    expect(receiptFailures.map((failure) => failure.code)).toContain("interrupted");

    const treatment = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/condition.json`);
    expect(treatment.status).toBe("not-started");
    expect(treatment.gradeable).toBe(false);
    expect(treatment.failureClass).toBe("infrastructure");
    expect(String(treatment.notStartedReason).length).toBeGreaterThan(0);

    // Both guests crossed the readiness barrier, so the unprompted treatment still has
    // exact, verified destruction outcomes rather than an invented never-created state.
    const cleanup = treatment.cleanup as Array<{ kind: string; status: string; verified: boolean }>;
    expect(cleanup.map((entry) => entry.kind)).toEqual(["guest", "network"]);
    expect(cleanup.every((entry) => ["destroyed", "already-absent"].includes(entry.status) && entry.verified)).toBe(true);

    // Partial evidence is inspectable: the baseline condition is fully sealed.
    // Canonical session.json holds the captured messages and tool steps.
    for (const file of ["condition.json", "attestation.json", "session.json", "workspace.json", "candidate.json", "validation.json", "errors.json"]) {
      await expect(stat(join(runDir, conditionDir(result.runId, "baseline"), file))).resolves.toBeDefined();
      await expect(stat(join(runDir, conditionDir(result.runId, "treatment"), file))).resolves.toBeDefined();
    }

    const pair = await readRecord(runDir, `pairs/${result.runId}-r001/pair.json`);
    expect(pair.delta).toBeNull();

    // And the receipt still verifies.
    const verification = await verifyRun(runDir);
    expect(verification.failures).toEqual([]);
    expect(verification.ok).toBe(true);

    // The interrupted arm is reported as ungraded: every accuracy cell is n/a, never zero.
    const report = await buildRunReport(join(runDir, "receipt.json"));
    expect(report.scored?.statusLine).toBe(
      "Without this skill: interrupted, grading unavailable \u00b7 With this skill: not started, grading unavailable",
    );
    expect(report.scored?.pillars.accuracy.baseline).toBe("n/a");
    for (const row of report.scored?.accuracyTable.rows ?? []) expect(row.baseline).toBe("n/a");
    expect(report.scored?.accuracyTable.totalRow.baseline).toBe("**n/a**");
  });
});

describe("overlap failure isolation", () => {
  it("retains and independently grades a completed sibling when the other arm fails", async () => {
    let releaseTreatment!: () => void;
    const baselineCompleted = new Promise<void>((resolve) => { releaseTreatment = resolve; });
    const baseHarness = createFakeHarness({
      script: () => ({ outcome: "completed", assistantText: "baseline completed" }),
    });
    const harness: Harness = {
      ...baseHarness,
      async run(guest, request) {
        if (request.conditionId === "treatment") {
          await baselineCompleted;
          throw new EvalError("provider-error", "synthetic treatment provider failure", { at: "treatment" });
        }
        return await baseHarness.run(guest, request);
      },
    };

    const { result, runDir } = await runFake({
      harness,
      schedulingPolicy: "overlap",
      onProgress(event) {
        if (event.type === "arm-execution-completed" && event.arm === "baseline") releaseTreatment();
      },
    });

    expect(result.status).toBe("partial");
    const baselineDir = conditionDir(result.runId, "baseline");
    const baseline = await readRecord(runDir, `${baselineDir}/condition.json`);
    expect(baseline).toMatchObject({ status: "completed", gradeable: true });
    const workspace = await readRecord(runDir, `${baselineDir}/workspace.json`);
    expect((workspace.files as unknown[]).length).toBeGreaterThan(0);
    const candidate = await readRecord(runDir, `${baselineDir}/candidate.json`);
    expect(candidate).toMatchObject({ projected: true, includedPaths: ["config.json"] });
    const validation = await readRecord(runDir, `${baselineDir}/validation.json`);
    expect(validation.outcome).toMatchObject({ status: "graded" });

    const treatment = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/condition.json`);
    expect(treatment).toMatchObject({ status: "infrastructure-failure", gradeable: false });
    const pair = await readRecord(runDir, `pairs/${result.runId}-r001/pair.json`);
    expect(pair).toMatchObject({ gradeable: false, delta: null });
    expect((await verifyRun(runDir)).ok).toBe(true);
  });
});

describe("secret quarantine and redaction", () => {
  // Credential echo produced by the evaluated agent is recorded as agent behaviour:
  // occurrences are redacted across all scanned encodings, recorded in sealed evidence,
  // the condition remains gradeable, and the pair delta is computable.
  it("redacts echoed secrets, records them in evidence, keeps condition gradeable, and leaves no secret byte in the run", async () => {
    const secretValue = "fake-eval-secret-0123456789abcdef";
    const script: FakeHarnessScript = () => ({
      outcome: "completed",
      writes: [{ path: "config.json", text: `{"leaked":"${secretValue}"}` }],
      assistantText: `wrote the answer with ${secretValue}`,
      nativeSessionEntries: [
        {
          type: "session",
          id: "sess-echo-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          version: 3,
        },
        {
          type: "message",
          id: "msg-echo-1",
          parentId: "sess-echo-1",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "assistant",
            content: `wrote the answer with ${secretValue}`,
          },
        },
      ],
    });

    const { result, runDir } = await runFake({
      script,
      guardedSecrets: [{ label: "FAKE_EVAL_KEY", value: secretValue }],
    });

    expect(result.status).toBe("complete");
    const baseline = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
    expect(baseline.status).toBe("completed");
    expect(baseline.gradeable).toBe(true);
    const redactions = baseline.redactions as { count: number; locations: string[] };
    expect(redactions.count).toBeGreaterThanOrEqual(2);
    expect(redactions.locations).toContain("workspace:config.json");
    expect(redactions.locations).toContain("messages[1]");

    const redactionsRecord = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/redactions.json`);
    expect((redactionsRecord as { count: number }).count).toBeGreaterThanOrEqual(2);

    // Treatment also runs and completes: pair is valid
    const treatment = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/condition.json`);
    expect(treatment.status).toBe("completed");
    expect(treatment.gradeable).toBe(true);

    const pair = await readRecord(runDir, `pairs/${result.runId}-r001/pair.json`);
    expect(pair.gradeable).toBe(true);
    expect(typeof pair.delta).toBe("number");

    // The candidate file scored by the validator references workspace bytes without duplicating base64.
    const candidate = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/candidate.json`);
    const configFile = (candidate.files as Array<{ path: string; base64: string | null; workspaceRef: string | null }>).find((f) => f.path === "config.json");
    expect(configFile).toBeDefined();
    expect(configFile!.workspaceRef).toBe("config.json");
    expect(configFile!.base64).toBeNull();

    // Universal reader resolves candidate bytes from workspace reference
    const resolvedCand = await readCandidate(result.receiptPath, conditionDir(result.runId, "baseline"));
    const resolvedConfig = resolvedCand.files.find((f) => f.path === "config.json");
    expect(resolvedConfig).toBeDefined();
    const configDecoded = Buffer.from(resolvedConfig!.base64, "base64").toString("utf8");
    expect(configDecoded).toContain("[REDACTED:FAKE_EVAL_KEY]");
    expect(configDecoded).not.toContain(secretValue);

    // Session record was sanitized and redacted
    const session = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/session.json`);
    expect(JSON.stringify(session)).toContain("[REDACTED:FAKE_EVAL_KEY]");
    expect(JSON.stringify(session)).not.toContain(secretValue);

    // Inspect view for redactions works
    const inspected = await inspectCondition({
      receiptPath: result.receiptPath,
      conditionId: "baseline",
      view: "redactions",
    });
    expect(inspected.verified).toBe(true);
    expect((inspected.content as { count: number }).count).toBeGreaterThanOrEqual(2);

    // The secret appears nowhere in the sealed run in ANY scanned encoding
    const hits = scanManyForSecrets(await sealedFiles(runDir), [
      { label: "FAKE_EVAL_KEY", value: secretValue },
    ]);
    expect(hits.map((hit) => `${hit.path} (${hit.encoding})`)).toEqual([]);

    const verification = await verifyRun(runDir);
    expect(verification.ok).toBe(true);
  });

  it("discards contaminated output, blocks the rest of the run, and quarantines when redaction cannot be verified", async () => {
    const secretValue = "fake-eval-secret-0123456789abcdef";
    const script: FakeHarnessScript = () => ({
      outcome: "completed",
      writes: [{ path: "config.json", text: `{"leaked":"${secretValue}"}` }],
      assistantText: "wrote the answer",
    });

    const { result, runDir } = await runFake({
      script,
      guardedSecrets: [{ label: "FAKE_EVAL_KEY", value: secretValue }],
      faults: { simulateSurvivingSecretHit: true },
    });

    expect(result.status).toBe("partial");
    const baseline = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
    expect(baseline.status).toBe("infrastructure-failure");
    const failures = (await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/errors.json`))
      .failures as Array<{ code: string }>;
    expect(failures.some((failure) => failure.code === "secret-quarantine")).toBe(true);

    // No further paid call after an unverifiable quarantine: treatment never started
    const treatment = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/condition.json`);
    expect(treatment.status).toBe("not-started");

    // Zero secret bytes reached disk
    const hits = scanManyForSecrets(await sealedFiles(runDir), [
      { label: "FAKE_EVAL_KEY", value: secretValue },
    ]);
    expect(hits.map((hit) => `${hit.path} (${hit.encoding})`)).toEqual([]);

    const verification = await verifyRun(runDir);
    expect(verification.ok).toBe(true);
  });
});

describe("wall clock per condition", () => {
  it("provides each arm an independent wallClock budget so one arm does not starve the other", async () => {
    let baselineExecuted = false;
    const script: FakeHarnessScript = (request) => {
      if (request.conditionId === "baseline") {
        baselineExecuted = true;
        return {
          outcome: "task-limit",
          writes: [{ path: "config.json", text: "partial output" }],
          assistantText: "timed out",
        };
      }
      return {
        outcome: "completed",
        writes: [{ path: "config.json", text: "good output" }],
        assistantText: "completed successfully",
      };
    };

    const { result, runDir } = await runFake({
      script,
      cliLimits: { wallClockMs: 10_000 },
    });

    expect(result.status).toBe("complete");
    expect(baselineExecuted).toBe(true);

    const baseline = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
    expect(baseline.status).toBe("task-limit");
    expect(baseline.gradeable).toBe(true);

    const treatment = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/condition.json`);
    expect(treatment.status).toBe("completed");
    expect(treatment.gradeable).toBe(true);

    const pair = await readRecord(runDir, `pairs/${result.runId}-r001/pair.json`);
    expect(pair.gradeable).toBe(true);
    expect(typeof pair.delta).toBe("number");
  });

  it("serial baseline consuming its entire allowance still leaves treatment its full allowance", async () => {
    let treatmentCompleted = false;
    let baselineDeadline: number | undefined;
    let treatmentDeadline: number | undefined;
    let baselineDispatchAt = 0;
    let treatmentDispatchAt = 0;
    const script: FakeHarnessScript = async (request) => {
      if (request.conditionId === "baseline") {
        baselineDispatchAt = Date.now();
        baselineDeadline = request.deadlineAtMs;
        // Sleep past baseline's wallClock allowance (50ms) to trigger per-arm timer
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { outcome: "completed", writes: [{ path: "config.json", text: "baseline late" }] };
      }
      treatmentDispatchAt = Date.now();
      treatmentDeadline = request.deadlineAtMs;
      // Treatment receives its own full 50ms allowance even after baseline used its entire allowance
      await new Promise((resolve) => setTimeout(resolve, 30));
      treatmentCompleted = true;
      return { outcome: "completed", writes: [{ path: "config.json", text: "treatment on time" }] };
    };

    const { result, runDir } = await runFake({
      script,
      schedulingPolicy: "serial",
      cliLimits: { wallClockMs: 50 },
    });

    expect(result.status).toBe("complete");
    expect(treatmentCompleted).toBe(true); // treatment ran and completed within its own window

    expect(baselineDeadline).toBeDefined();
    expect(treatmentDeadline).toBeDefined();
    // Under serial execution, treatment deadline must be shifted by at least roughly baseline's execution duration (~80ms).
    // Under a shared activeDeadlineAtMs clock, treatmentDeadline - baselineDeadline === 0.
    expect(treatmentDeadline! - baselineDeadline!).toBeGreaterThanOrEqual(60);
    // Each arm's deadline is independently anchored at ≈ its own dispatch time + wallClockMs (50ms).
    expect(Math.abs(baselineDeadline! - (baselineDispatchAt + 50))).toBeLessThanOrEqual(25);
    expect(Math.abs(treatmentDeadline! - (treatmentDispatchAt + 50))).toBeLessThanOrEqual(25);

    const baseline = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
    expect(baseline.status).toBe("task-limit");

    const treatment = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/condition.json`);
    expect(treatment.status).toBe("completed");
  });

  it("multi-repetition run whose total budget exceeds 300000ms aggregate cap completes without truncation", async () => {
    const { result, runDir } = await runFake({
      repetitions: 2, // 4 conditions * 80s + overhead = 380s > 300s
    });
    expect(result.status).toBe("complete");
    const receipt = (await readRecord(runDir, "receipt.json")) as any;
    expect(receipt.pairs).toHaveLength(2);
  });

  it("overlapping arms have independent execution deadlines", async () => {
    let treatmentFinished = false;
    let baselineDeadline: number | undefined;
    let treatmentDeadline: number | undefined;
    let baselineDispatchAt = 0;
    let treatmentDispatchAt = 0;
    const script: FakeHarnessScript = async (request) => {
      if (request.conditionId === "baseline") {
        baselineDispatchAt = Date.now();
        baselineDeadline = request.deadlineAtMs;
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { outcome: "completed", writes: [{ path: "config.json", text: "b" }] };
      }
      treatmentDispatchAt = Date.now();
      treatmentDeadline = request.deadlineAtMs;
      await new Promise((resolve) => setTimeout(resolve, 20));
      treatmentFinished = true;
      return { outcome: "completed", writes: [{ path: "config.json", text: "t" }] };
    };

    const { result, runDir } = await runFake({
      script,
      schedulingPolicy: "overlap",
      cliLimits: { wallClockMs: 50 },
    });

    expect(result.status).toBe("complete");
    expect(treatmentFinished).toBe(true);

    expect(baselineDeadline).toBeDefined();
    expect(treatmentDeadline).toBeDefined();
    expect(Math.abs(baselineDeadline! - (baselineDispatchAt + 50))).toBeLessThanOrEqual(25);
    expect(Math.abs(treatmentDeadline! - (treatmentDispatchAt + 50))).toBeLessThanOrEqual(25);

    const baseline = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
    expect(baseline.status).toBe("task-limit");

    const treatment = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/condition.json`);
    expect(treatment.status).toBe("completed");
  });

  it("unlimited-arm HarnessRequest carries deadlineAtMs undefined (not Infinity) to the harness", async () => {
    let observedDeadlineAtMs: number | "was-defined" | undefined = "was-defined";
    const script: FakeHarnessScript = (request) => {
      observedDeadlineAtMs = request.deadlineAtMs;
      return { outcome: "completed", writes: [{ path: "config.json", text: "ok" }] };
    };
    const { result } = await runFake({
      script,
      cliLimits: { wallClockMs: null },
    });
    expect(result.status).toBe("complete");
    expect(observedDeadlineAtMs).toBeUndefined();
  });

  it("ordinary child task timeout leaves sibling runnable while explicit cancellation stops the run", async () => {
    // 1. Task timeout leaves sibling runnable and grades both
    const timeoutScript: FakeHarnessScript = (request) => {
      if (request.conditionId === "baseline") {
        return { outcome: "task-limit", writes: [{ path: "config.json", text: "b" }] };
      }
      return { outcome: "completed", writes: [{ path: "config.json", text: "t" }] };
    };
    const { result: timeoutResult, runDir } = await runFake({ script: timeoutScript });
    expect(timeoutResult.status).toBe("complete");
    const baseline = await readRecord(runDir, `${conditionDir(timeoutResult.runId, "baseline")}/condition.json`);
    expect(baseline.status).toBe("task-limit");
    const treatment = await readRecord(runDir, `${conditionDir(timeoutResult.runId, "treatment")}/condition.json`);
    expect(treatment.status).toBe("completed");

    // 2. Explicit cancellation stops the run immediately
    const cancelController = new AbortController();
    cancelController.abort(new Error("explicit cancellation"));
    const { result: cancelResult } = await runFake({ signal: cancelController.signal });
    expect(cancelResult.status).toBe("partial");
    expect(cancelResult.stopReason).toContain("explicit cancellation");
  });
});

describe("stage order is not skippable", () => {
  /**
   * A resource that is verified gone and then leaks back is the one shape that makes the
   * pre-next-condition absence check throw AFTER an arm has already executed and exported.
   * Before the stage-3/stage-4 split that throw skipped validation for the arm that had
   * already run, which the contract forbids ("MUST NOT reorder or skip a stage").
   */
  const scenario = async (): Promise<Harnessed> => {
    const runId = runIdFor(new Date(0), "abcdef12");
    return runFake({
      runId,
      sandbox: createFakeSandbox({
        faults: { reappearsAfterDestroy: [`guest:${guestNameFor(runId, "baseline")}`] },
      }),
    });
  };

  it("still validates an arm that executed when a stage-3 teardown check throws afterwards", async () => {
    const { result, runDir } = await scenario();

    // The teardown check did throw: the run is partial and carries a cleanup failure.
    expect(result.status).toBe("partial");
    expect(result.failures.map((failure) => failure.code)).toContain("cleanup-failed");

    // ...and the arm that already ran was STILL validated.
    const baseline = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
    expect(baseline.status).toBe("completed");
    expect(baseline.gradeable).toBe(true);

    const candidate = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/candidate.json`);
    expect(candidate.projected).toBe(true);
    expect(candidate.includedPaths).toEqual(["config.json"]);

    const validation = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/validation.json`);
    const outcome = validation.outcome as { status: string; score: number; checks: unknown[] } | null;
    expect(outcome).not.toBeNull();
    expect(outcome?.status).toBe("graded");
    expect(typeof outcome?.score).toBe("number");
    expect(outcome?.checks).toHaveLength(18);

    expect((await verifyRun(runDir)).ok).toBe(true);
  });

  it("seals an unprompted ready condition with affirmative cleanup, never an empty array", async () => {
    const { result, runDir } = await scenario();
    const treatment = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/condition.json`);
    expect(treatment.status).toBe("not-started");

    const cleanup = treatment.cleanup as Array<{
      kind: string;
      status: string;
      verified: boolean;
      detail: string | null;
    }>;
    expect(cleanup).not.toEqual([]);
    expect(cleanup.map((entry) => entry.kind)).toEqual(["guest", "network"]);
    expect(cleanup.some((entry) => !entry.verified)).toBe(true);
    expect(cleanup.every((entry) => typeof entry.status === "string" && entry.status.length > 0)).toBe(true);

    // Still an infrastructure outcome carrying no score.
    const validation = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/validation.json`);
    expect(validation.outcome).toBeNull();
    const pair = await readRecord(runDir, `pairs/${result.runId}-r001/pair.json`);
    expect(pair.delta).toBeNull();
    expect((await verifyRun(runDir)).ok).toBe(true);
  });
});

describe("validator infrastructure normalization", () => {
  it("cancels an in-flight grader at its own operation deadline", async () => {
    let graderStopped = false;
    const validatorRunner: ValidatorRunner = {
      id: "delayed-validator",
      testDouble: true,
      async run(request) {
        await new Promise<void>((_resolve, reject) => {
          const stop = () => { graderStopped = true; reject(request.signal?.reason); };
          if (request.signal?.aborted) stop();
          else request.signal?.addEventListener("abort", stop, { once: true });
        });
        throw new Error("unreachable");
      },
    };
    const { result } = await runFake({ validatorRunner, operationAllowanceMs: 800 });
    expect(graderStopped).toBe(true);
    expect(result.status).toBe("partial");
  });

  it("continues grading the next arm after one grader times out", async () => {
    let calls = 0;
    const validatorRunner: ValidatorRunner = {
      id: "one-delayed-validator", testDouble: true,
      async run(request) {
        if (++calls === 1) {
          await new Promise<void>((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
          });
        }
        expect(request.signal?.aborted).toBe(false);
        const passingChecks = [
          "production-chain-identity", "staging-chain-identity",
          "production-legacy-fallback", "staging-legacy-fallback",
          "production-rpc-endpoints", "staging-rpc-endpoints",
          "production-sequencer-policy", "staging-sequencer-policy",
          "production-token-identity", "staging-token-identity",
          "production-bridge-addresses", "staging-bridge-addresses",
          "production-bridge-onboarding", "staging-bridge-onboarding",
          "production-finality-policy", "staging-finality-policy",
          "json-shape", "preservation",
        ].map((id) => ({ id, passed: true, message: "correct" }));

        return { runnerId: this.id, testDouble: true, durationMs: 1, failure: null,
          outcome: { status: "graded", score: 1, fullPass: true, checks: passingChecks } };
      },
    };
    const { result, runDir } = await runFake({ validatorRunner, operationAllowanceMs: 800 });
    expect(calls).toBe(2);
    expect(await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`)).toMatchObject({ gradeable: false });
    expect(await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/condition.json`)).toMatchObject({ gradeable: true });
    expect((await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/validation.json`)).outcome).toMatchObject({ score: 1 });
  });

  it("makes a returned infrastructure outcome partial, ungradeable, and visible in stopReason", async () => {
    const validatorRunner: ValidatorRunner = {
      id: "returned-infrastructure",
      testDouble: true,
      async run() {
        const failure = { code: "validator-infrastructure" as const, failureClass: "infrastructure" as const, message: "synthetic returned validator failure", at: "validator run" };
        return { runnerId: this.id, testDouble: true, durationMs: 1, failure,
          outcome: { status: "infrastructure-failure" as const, score: null, fullPass: null, checks: [] } };
      },
    };
    const { result, runDir } = await runFake({ validatorRunner });
    expect(result.status).toBe("partial");
    expect(result.stopReason).toContain("validator-infrastructure");
    const baseline = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
    expect(baseline).toMatchObject({ status: "infrastructure-failure", gradeable: false });
    const pair = await readRecord(runDir, `pairs/${result.runId}-r001/pair.json`);
    expect(pair).toMatchObject({ gradeable: false, delta: null });
  });
});

describe("cleanup settlement guarantees", () => {
  it.each([false, true])("clears losing cleanup timers after settled operations (destroy rejects: %s)", async (rejectDestroy) => {
    const base = createFakeSandbox();
    let rejected = false;
    const sandbox: Sandbox = {
      ...base,
      async destroyResource(kind, name, signal) {
        if (rejectDestroy && !rejected && kind === "guest") {
          rejected = true;
          throw new Error("synthetic settled destroy rejection");
        }
        return base.destroyResource(kind, name, signal);
      },
    };
    // Real filesystem/worker completion stays active. Advancing no clock proves the
    // cleanup races cancel their losing timers rather than waiting for them to expire.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { result } = await runFake({ sandbox });
      expect(result.status).toBe(rejectDestroy ? "partial" : "complete");
      expect(rejected).toBe(rejectDestroy);
      expect(vi.getTimerCount()).toBe(0);
      expect(base.live).toEqual({ guests: [], networks: [] });
    } finally {
      vi.useRealTimers();
      for (const name of base.created.guests) await base.destroyResource("guest", name);
      for (const name of base.created.networks) await base.destroyResource("network", name);
    }
  });

  it("records an unresolved network creation as cleanup-failed without verifying it absent", async () => {
    const base = createFakeSandbox();
    const sandbox: Sandbox = {
      ...base,
      async createNetwork() { return await new Promise<never>(() => undefined); },
    };
    const { result, runDir, stateDir } = await runFake({ sandbox, operationAllowanceMs: 800 });
    const name = networkNameFor(result.runId, "baseline");
    const cleanup = (await readRecord(runDir, "cleanup.json")).sweep as Array<{ kind: string; name: string; status: string; verified: boolean; failure?: { code: string } }>;
    expect(result.status).toBe("partial");
    expect(cleanup.find((entry) => entry.kind === "network" && entry.name === name)).toMatchObject({ status: "failed", verified: false, failure: { code: "cleanup-failed" } });
    const entries = await readRunJournal(stateDir, result.runId);
    expect(entries).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "observed", action: "verify", kind: "network", name, status: "absent" })]));
  });

  it("records an unresolved guest creation as cleanup-failed, after guest-before-network cleanup", async () => {
    const base = createFakeSandbox();
    const sandbox: Sandbox = {
      ...base,
      async createGuest() { return await new Promise<never>(() => undefined); },
    };
    const { result, runDir, stateDir } = await runFake({ sandbox, operationAllowanceMs: 800 });
    const guest = guestNameFor(result.runId, "baseline");
    const network = networkNameFor(result.runId, "baseline");
    const cleanup = (await readRecord(runDir, "cleanup.json")).sweep as Array<{ kind: string; name: string; status: string; verified: boolean; failure?: { code: string } }>;
    const condition = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
    expect(result.status).toBe("partial");
    expect(cleanup.find((entry) => entry.kind === "guest" && entry.name === guest)).toMatchObject({ status: "failed", verified: false, failure: { code: "cleanup-failed" } });
    expect(condition.cleanup).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "guest", name: guest, status: "failed", verified: false, failure: expect.objectContaining({ code: "cleanup-failed" }) }),
    ]));
    const entries = await readRunJournal(stateDir, result.runId);
    const key = (entry: JournalEntry): string => `${entry.event}:${entry.action}:${entry.kind}:${entry.name}:${entry.status ?? "-"}`;
    const guestDestroy = entries.findIndex((entry) => key(entry) === `intent:destroy:guest:${guest}:-`);
    expect(guestDestroy).toBe(-1);
    // The unresolved guest is never destroyed or inspected; the remaining cleanup window
    // may be exhausted before the already-created network can be attempted.
    expect(entries).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "intent", action: "destroy", kind: "guest", name: guest })]));
    expect(entries).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "observed", action: "verify", kind: "guest", name: guest, status: "absent" })]));
  });

  it("does not let a late successful creation mutate sealed evidence", async () => {
    const base = createFakeSandbox();
    let release!: (value: Awaited<ReturnType<Sandbox["createNetwork"]>>) => void;
    const late = new Promise<Awaited<ReturnType<Sandbox["createNetwork"]>>>((resolve) => { release = resolve; });
    const sandbox: Sandbox = { ...base, async createNetwork(name, policy) { return await late.then(() => base.createNetwork(name, policy)); } };
    const run = await runFake({ sandbox, operationAllowanceMs: 800 });
    const before = await sealedFiles(run.runDir);
    const resultBefore = { ...run.result };
    release({ name: networkNameFor(run.result.runId, "baseline"), policySha256: "late" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(run.result).toEqual(resultBefore);
    expect(await sealedFiles(run.runDir)).toEqual(before);
    expect((await readRecord(run.runDir, "receipt.json")).status).toBe("partial");
  });

  it("absorbs a late rejected creation without mutating finalized evidence", async () => {
    const base = createFakeSandbox();
    let rejectLate!: (error: Error) => void;
    const late = new Promise<never>((_resolve, reject) => { rejectLate = reject; });
    const sandbox: Sandbox = { ...base, async createNetwork() { return await late; } };
    const run = await runFake({ sandbox, operationAllowanceMs: 800 });
    const before = await sealedFiles(run.runDir);
    rejectLate(new Error("late network rejection"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(run.result.status).toBe("partial");
    expect(await sealedFiles(run.runDir)).toEqual(before);
    expect((await readRecord(run.runDir, "receipt.json")).status).toBe("partial");
  });

  it("records an externally aborted in-flight creation without dispatching a guest", async () => {
    const base = createFakeSandbox();
    const parent = new AbortController();
    let guestsDispatched = 0;
    const sandbox: Sandbox = {
      ...base,
      async createNetwork() {
        parent.abort(new Error("test abort"));
        return await new Promise<never>(() => undefined);
      },
      async createGuest(spec) { guestsDispatched++; return base.createGuest(spec); },
    };
    const { result, runDir, stateDir } = await runFake({ sandbox, signal: parent.signal, operationAllowanceMs: 800 });
    const name = networkNameFor(result.runId, "baseline");
    const cleanup = (await readRecord(runDir, "cleanup.json")).sweep as Array<{ kind: string; name: string; status: string; verified: boolean; failure?: { code: string } }>;
    expect(result.status).toBe("partial");
    expect(guestsDispatched).toBe(0);
    expect(cleanup.find((entry) => entry.kind === "network" && entry.name === name)).toMatchObject({ status: "failed", verified: false, failure: { code: "cleanup-failed" } });
    expect((await readRunJournal(stateDir, result.runId))).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "observed", action: "verify", kind: "network", name, status: "absent" })]));
  });

  it("bounds a never-settling operation by the cleanup window and seals partial evidence", async () => {
    const base = createFakeSandbox();
    const sandbox: Sandbox = { ...base, async createNetwork() { return await new Promise<never>(() => undefined); } };
    const started = Date.now();
    const { result, runDir } = await runFake({ sandbox, operationAllowanceMs: 400, cleanupReserveMs: 400 });
    expect(Date.now() - started).toBeLessThan(2_000);
    const cleanup = (await readRecord(runDir, "cleanup.json")).sweep as Array<{ status: string; verified: boolean; failure?: { code: string } }>;
    expect(result.status).toBe("partial");
    expect(cleanup.some((entry) => entry.status === "failed" && entry.verified === false && entry.failure?.code === "cleanup-failed")).toBe(true);
  });

  it("cleans up only after a creation settles, and rejects destroy as cleanup-failed", async () => {
    const base = createFakeSandbox();
    const parent = new AbortController();
    let settled = false;
    const order: string[] = [];
    const sandbox: Sandbox = {
      ...base,
      async createGuest(spec) {
        const aborted = new Promise<void>((resolve) => {
          if (parent.signal.aborted) resolve();
          else parent.signal.addEventListener("abort", () => queueMicrotask(resolve), { once: true });
        });
        parent.abort(new Error("settle-after-abort"));
        await aborted;
        settled = true;
        order.push("settled");
        return base.createGuest(spec);
      },
      async destroyResource(kind, name, signal) { order.push(`destroy:${kind}`); return base.destroyResource(kind, name, signal); },
      async inspectResource(kind, name, signal) { order.push(`inspect:${kind}`); return base.inspectResource(kind, name, signal); },
    };
    const clean = await runFake({ sandbox, signal: parent.signal, operationAllowanceMs: 1_000 });
    expect(order.indexOf("settled")).toBeLessThan(order.findIndex((entry) => entry === "destroy:guest"));
    expect(order.indexOf("destroy:guest")).toBeLessThan(order.findIndex((entry) => entry === "inspect:guest"));
    const cleanBaseline = await readRecord(clean.runDir, `${conditionDir(clean.result.runId, "baseline")}/condition.json`);
    expect(cleanBaseline.cleanup).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "guest", status: "destroyed", verified: true }),
      expect.objectContaining({ kind: "network", status: "destroyed", verified: true }),
    ]));

    const rejecting: Sandbox = { ...createFakeSandbox(), async destroyResource(kind, name) { if (kind === "guest") throw new Error("late destroy rejection"); return base.destroyResource(kind, name); } };
    const failed = await runFake({ sandbox: rejecting });
    const baseline = await readRecord(failed.runDir, `${conditionDir(failed.result.runId, "baseline")}/condition.json`);
    expect(failed.result.status).toBe("partial");
    expect(baseline.cleanup).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "guest", status: "failed", verified: false, failure: expect.objectContaining({ code: "cleanup-failed" }) })]));
    expect((await readRunJournal(failed.stateDir, failed.result.runId))).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "observed", action: "verify", kind: "guest", status: "absent" })]));
  });
});

describe("cleanup failure", () => {
  it("actively cancels delayed cleanup before the sealing reserve", async () => {
    const base = createFakeSandbox();
    let cleanupStopped = false;
    const sandbox: Sandbox = {
      ...base,
      async destroyResource(kind, name, signal) {
        if (kind !== "guest") return await base.destroyResource(kind, name, signal);
        await new Promise<void>((_resolve, reject) => {
          const stop = () => { cleanupStopped = true; reject(signal?.reason); };
          if (signal?.aborted) stop();
          else signal?.addEventListener("abort", stop, { once: true });
        });
        throw new Error("unreachable");
      },
    };
    const { result } = await runFake({ sandbox, cleanupReserveMs: 800 });
    expect(cleanupStopped).toBe(true);
    expect(result.status).toBe("partial");
    expect(result.failures.some((failure) => failure.code === "cleanup-failed")).toBe(true);
  });

  it("records an infrastructure outcome, blocks every further paid call, and still seals a verifying receipt", async () => {
    const runId = runIdFor(new Date(0), "abcdef12");
    const { result, runDir } = await runFake({
      runId,
      sandbox: createFakeSandbox({ faults: { destroyFails: [`guest:${guestNameFor(runId, "baseline")}`] } }),
    });

    expect(result.status).toBe("partial");

    // The failure is INFRASTRUCTURE, never a task failure.
    const baseline = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
    const cleanup = baseline.cleanup as Array<{
      kind: string;
      status: string;
      verified: boolean;
      failure: { code: string; failureClass: string } | null;
    }>;
    const guestCleanup = cleanup.find((entry) => entry.kind === "guest");
    expect(guestCleanup?.status).toBe("failed");
    expect(guestCleanup?.verified).toBe(false);
    expect(guestCleanup?.failure?.code).toBe("cleanup-failed");
    expect(guestCleanup?.failure?.failureClass).toBe("infrastructure");
    expect(result.failures.some((failure) => failure.code === "cleanup-failed")).toBe(true);
    expect(
      result.failures.every((failure) => failure.failureClass === "infrastructure"),
    ).toBe(true);

    // The paid-calls-blocked guard tripped after both guests were ready: treatment was
    // attested but never prompted and has no usage.
    const treatment = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/condition.json`);
    expect(treatment.status).toBe("not-started");
    expect(treatment.runtime).not.toBeNull();
    expect(treatment.usage).toBeNull();
    expect(String(treatment.notStartedReason).length).toBeGreaterThan(0);
    const inspectedTreatment = await inspectCondition({
      receiptPath: result.receiptPath,
      conditionId: "treatment",
      view: "messages",
    });
    const treatmentMessages = (inspectedTreatment.content as { messages: unknown[] }).messages;
    expect(treatmentMessages).toEqual([]);

    // score: null for the ungradeable arm, and no delta for the invalid pair.
    const validation = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/validation.json`);
    expect(validation.outcome).toBeNull();
    const pair = await readRecord(runDir, `pairs/${result.runId}-r001/pair.json`);
    expect(pair.gradeable).toBe(false);
    expect(pair.delta).toBeNull();

    // The receipt is still written, after every cleanup outcome is known, and verifies.
    const receipt = await readRecord(runDir, "receipt.json");
    expect((receipt.cleanup as unknown[]).length).toBeGreaterThan(0);
    expect((receipt.failures as Array<{ code: string }>).map((failure) => failure.code)).toContain("cleanup-failed");
    expect((await verifyRun(runDir)).ok).toBe(true);
  });

  it("treats a resource that reports destroyed but is still present as a cleanup failure", async () => {
    const runId = runIdFor(new Date(0), "abcdef12");
    const { result, runDir } = await runFake({
      runId,
      sandbox: createFakeSandbox({
        faults: { destroyLeavesPresent: [`guest:${guestNameFor(runId, "baseline")}`] },
      }),
    });

    const baseline = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/condition.json`);
    const guestCleanup = (baseline.cleanup as Array<{
      kind: string;
      status: string;
      verified: boolean;
      detail: string | null;
      failure: { code: string; message: string } | null;
    }>).find((entry) => entry.kind === "guest");

    // The destroy call CLAIMED success; the exact-identity re-inspection is what decides.
    expect(guestCleanup?.status).toBe("failed");
    expect(guestCleanup?.verified).toBe(false);
    expect(guestCleanup?.detail ?? "").toContain("still present on re-inspection");
    expect(guestCleanup?.failure?.code).toBe("cleanup-failed");
    expect(guestCleanup?.failure?.message).toContain("is still present after destruction");

    // And it trips the same guard as an outright destroy failure.
    const treatment = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/condition.json`);
    expect(treatment.status).toBe("not-started");
    expect((await verifyRun(runDir)).ok).toBe(true);
  });
});

describe("guarded sealing", () => {
  it("surfaces a sealing write failure as a structured evidence-invalid failure, not a raw error", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-seal-test-"));
    tempRoots.push(root);
    const runId = runIdFor(new Date(0), "abcdef12");
    // Occupy a path the sealer must write. Sealed evidence is write-once, so the write
    // refuses rather than truncating, and the run must not end half-sealed and silent.
    await mkdir(join(root, "runs", runId), { recursive: true });
    await writeFile(join(root, "runs", runId, "cleanup.json"), "{}\n");

    const error = await runFake({ runId, runsRoot: join(root, "runs") }).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(EvalError);
    expect((error as EvalError).code).toBe("evidence-invalid");
    expect((error as EvalError).message).toContain("write-once");
    expect((error as EvalError).message).toContain(runId);

    // No receipt, and the half-sealed tree announces itself in a regenerable view.
    await expect(stat(join(root, "runs", runId, "receipt.json"))).rejects.toBeDefined();
    const notice = await readFile(join(root, "runs", runId, "views/seal-failure.txt"), "utf8");
    expect(notice).toContain("sealing FAILED");
    expect(notice).toContain("MUST NOT be reported as a result");
  });
});

describe("observed attestation is sealed evidence", () => {
  it("seals the real observed values for every condition that started, separately from the declared policy", async () => {
    const { result, runDir } = await runFake();

    for (const conditionId of ["baseline", "treatment"] as const) {
      const record = await readRecord(runDir, `${conditionDir(result.runId, conditionId)}/attestation.json`);
      expect(record.attested).toBe(true);
      expect(record.notAttestedReason).toBeNull();

      const observed = record.observed as {
        source: string;
        testDouble: boolean;
        init: { uid: number; gid: number; groups: number[]; capEff: string; noNewPrivs: boolean };
        self: { uid: number; groups: number[] };
        readOnlyRootProbe: { readOnly: boolean; detail: string };
        resolvers: unknown[];
        anyResolverPrivate: boolean;
        allowedTcpPorts: number[];
        egressProbes: Array<{ label: string; port: number; expectation: string; outcome: string; durationMs: number }>;
        dnsProbe: { ok: boolean };
      };
      // Real values, not a boolean summary.
      expect(observed.init.uid).toBe(10_001);
      expect(observed.init.gid).toBe(10_001);
      expect(observed.init.groups).toEqual([]);
      expect(observed.init.capEff).toBe("0000000000000000");
      expect(observed.init.noNewPrivs).toBe(true);
      expect(observed.self.uid).toBe(10_001);
      expect(observed.readOnlyRootProbe.readOnly).toBe(true);
      expect(observed.anyResolverPrivate).toBe(false);
      expect(observed.allowedTcpPorts).toBe("all");
      // Each probe carries its own target, expectation, outcome, and timing.
      const port80 = observed.egressProbes.find((probe) => probe.label === "public-80");
      expect(port80?.expectation).toBe("connected");
      expect(port80?.outcome).toBe("connected");
      expect(observed.egressProbes.find((probe) => probe.label === "public-443")?.expectation).toBe("connected");
      expect(observed.egressProbes.every((probe) => typeof probe.durationMs === "number")).toBe(true);

      // The double's observation is unmistakably labelled as such.
      expect(observed.source).toBe("fake-sandbox-double");
      expect(observed.testDouble).toBe(true);
      expect(record.testDouble).toBe(true);
      expect(String(record.evidenceLabel)).toContain("TEST-DOUBLE");
    }

    // Declared intent is NOT overwritten or merged into: it stays where it was sealed,
    // and the attestation only references it by hash and path.
    const policy = await readRecord(runDir, "inputs/policy.json");
    expect((policy.network as { allowPublicTcpPorts: unknown }).allowPublicTcpPorts).toBe("all");
    expect((policy.guest as { uid: number }).uid).toBe(10_001);
    expect(policy.observed).toBeUndefined();
    const attestation = await readRecord(runDir, `${conditionDir(result.runId, "baseline")}/attestation.json`);
    expect(attestation.declaredPolicyPath).toBe("inputs/policy.json");
    expect((attestation.declaredPolicySha256 as Record<string, string>).network).toMatch(/^[0-9a-f]{64}$/);

    // It is inside the manifest and therefore inside the hash chain.
    const manifest = await readRecord(runDir, "manifest.json");
    const paths = (manifest.entries as Array<{ path: string }>).map((entry) => entry.path);
    expect(paths).toContain(`${conditionDir(result.runId, "baseline")}/attestation.json`);
    expect(paths).toContain(`${conditionDir(result.runId, "treatment")}/attestation.json`);
    expect((await verifyRun(runDir)).ok).toBe(true);
  });

  it("names the sealed attestation when it is altered after sealing", async () => {
    const { result, runDir } = await runFake();
    const relative = `${conditionDir(result.runId, "treatment")}/attestation.json`;
    const target = join(runDir, relative);
    const original = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
    (original.observed as Record<string, unknown>).init = { uid: 0, gid: 0, groups: [], capEff: "0000003fffffffff", capPrm: null, noNewPrivs: false };
    await rm(target, { force: true });
    await writeFile(target, `${JSON.stringify(original)}\n`);

    const verification = await verifyRun(runDir);
    expect(verification.ok).toBe(false);
    expect(verification.altered).toContain(relative);
    expect(verification.failures.map((failure) => failure.message).join(" ")).toContain(relative);
  });

  it("records attestation for an unprompted serial sibling because both-ready precedes dispatch", async () => {
    const controller = new AbortController();
    const script: FakeHarnessScript = (request) => {
      if (request.conditionId === "baseline") controller.abort();
      return { outcome: "completed", assistantText: "interrupted" };
    };
    const { result, runDir } = await runFake({ script, signal: controller.signal });

    const record = await readRecord(runDir, `${conditionDir(result.runId, "treatment")}/attestation.json`);
    expect(record.attested).toBe(true);
    expect(record.observed).not.toBeNull();
    expect(record.summary).not.toBeNull();
    expect(record.notAttestedReason).toBeNull();
    expect((await verifyRun(runDir)).ok).toBe(true);
  });

  it("binds receipt-addressed candidate reads to chain, condition membership, and workspace bytes", async () => {
    const tampered = await runFake({ runId: "19700101T000000Z-cand0001" });
    const dir = conditionDir(tampered.result.runId, "baseline");
    const candidatePath = join(tampered.runDir, dir, "candidate.json");
    await chmod(candidatePath, 0o600);
    await writeFile(candidatePath, `${await readFile(candidatePath, "utf8")} `);
    await expect(readCandidate(tampered.result.receiptPath, dir)).rejects.toMatchObject({ code: "evidence-invalid" });

    const referenced = await runFake({ runId: "19700101T000000Z-cand0002" });
    const referencedDir = conditionDir(referenced.result.runId, "baseline");
    const candidate = await readRecord(referenced.runDir, `${referencedDir}/candidate.json`);
    const files = candidate.files as Array<Record<string, unknown>>;
    files[0] = { ...files[0], base64: "", workspaceRef: "missing-owned-file" };
    await resealChangedRecord(referenced.runDir, `${referencedDir}/candidate.json`, candidate);
    expect((await verifyRun(referenced.runDir)).ok).toBe(true);
    await expect(readCandidate(referenced.result.receiptPath, referencedDir)).rejects.toMatchObject({ code: "evidence-invalid" });
    await expect(readCandidate(referenced.result.receiptPath, "../outside" )).rejects.toMatchObject({ code: "path-unsafe" });
  });

  it("refuses native export when a test-double condition has no actual native header", async () => {
    const { result } = await runFake();
    const before = await verifyRun(result.runDir);
    await expect(exportNativeSessionView({ receiptPath: result.receiptPath, conditionId: "treatment", format: "both" }))
      .rejects.toThrow(/unavailable or lacks its actual header/);
    const after = await verifyRun(result.runDir);
    expect(after.recomputedTreeSha256).toBe(before.recomputedTreeSha256);
  });

  it("is reachable by a human from a receipt via eval:inspect", async () => {
    const { result } = await runFake();
    const inspected = await inspectCondition({
      receiptPath: result.receiptPath,
      conditionId: "treatment",
      view: "attestation",
    });
    expect(inspected.verified).toBe(true);
    expect(inspected.file).toContain("attestation.json");
    const content = inspected.content as { observed: { init: { uid: number } } };
    expect(content.observed.init.uid).toBe(10_001);

    // And the runtime view points at it.
    const runtime = await inspectCondition({
      receiptPath: result.receiptPath,
      conditionId: "treatment",
      view: "runtime",
    });
    expect((runtime.content as { attestationFile: string }).attestationFile).toContain("attestation.json");
  });
});
