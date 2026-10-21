/**
 * Process-level reporting and runner tests:
 * - Launches actual CLI entry points (scripts/run.ts and scripts/report.ts).
 * - Captures BOTH stdout and stderr on success and failure.
 * - Asserts grouped pair rows with unique IDs and nine-column averages for repeated runs.
 * - Asserts byte-identical table output between run and report.
 * - Validates population regression (0.2, 0.6) and (0.8, 0.4) plus invalid baseline 1.0 -> 0.500 | 0.500 | 0.000.
 * - Validates token denominator when missing telemetry.
 * - Validates cache accounting, JSON parsing, Markdown agreement, quiet mode, tampering refusal.
 * - Validates progress facts ordering, arm identity, and absence of leaks.
 * - Proves slow treatment staging does NOT consume treatment's model allowance.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAllowlistedEnv } from "../test-guards.ts";
import { buildRunReport, formatRunReport, renderResultsTable, REPORT_JSON_SCHEMA_VERSION } from "../artifacts/queries.ts";
import { createEvidenceStore, createRunJournal } from "../artifacts/store.ts";
import { buildRunPlan, sha256Hex } from "../core/experiment.ts";
import type { RunPlan } from "../core/experiment.ts";
import { EVIDENCE_SCHEMA_VERSION, SAFE_DEFAULT_LIMITS } from "../core/types.ts";
import { createFakeHarness } from "../harnesses/fake.ts";
import { createPiHarness } from "../harnesses/pi/adapter.ts";
import { createScriptedStreamSimple } from "../harnesses/pi/scripted-stream.ts";
import { createFakeSandbox } from "../sandboxes/fake.ts";
import { createInProcessValidatorRunner } from "./validation.ts";
import { disposeRunWorkDir, runPairedEvaluation } from "./run.ts";

const RUN_SCRIPT = resolve(process.cwd(), "scripts/run.ts");
const REPORT_SCRIPT = resolve(process.cwd(), "scripts/report.ts");
const VALIDATE_SCRIPT = resolve(process.cwd(), "scripts/validate.ts");
const DOCTOR_SCRIPT = resolve(process.cwd(), "scripts/doctor.ts");
const HISTORY_SCRIPT = resolve(process.cwd(), "scripts/history.ts");

function runCommand(
  scriptPath: string,
  args: readonly string[],
  extraEnv: Record<string, string | undefined> = {},
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", scriptPath, ...args],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      env: buildAllowlistedEnv(tmpdir(), extraEnv),
    },
  );
  return {
    status: res.status ?? (res.error ? 1 : 0),
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

const RESULT_COLUMNS = ["Case", "Harness", "Provider", "Model", "Baseline", "Treatment", "Delta", "Tokens Δ", "Time Δ"];
const PAIR_COLUMNS = ["run_id", ...RESULT_COLUMNS];
const MARKDOWN_HEADER = `| ${RESULT_COLUMNS.join(" | ")} |`;
const PAIR_MARKDOWN_HEADER = `| ${PAIR_COLUMNS.join(" | ")} |`;

function extractTables(output: string): string[] {
  const tables = output.match(/^┌[^\n]*\n[\s\S]*?^└[^\n]*/gm);
  if (tables === null) {
    throw new Error(`Table not found in output:\n${output}`);
  }
  return tables;
}

function tableRows(table: string): string[][] {
  return table.split("\n").filter((line) => line.startsWith("│"))
    .map((line) => line.split("│").slice(1, -1).map((cell) => cell.trim()));
}

/** Timing/outcome tests exercise Pi without depending on a live documentation service. */
async function writeOfflineSkill(repoRoot: string): Promise<void> {
  const skillDir = join(repoRoot, "src", "test-fixtures", "skills", "mcp-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: arbitrum-docs\ndescription: Synthetic skill for runner tests.\n---\nFollow the test task.\n");
}

async function writeSyntheticPairRecord(
  store: Awaited<ReturnType<typeof createEvidenceStore>>,
  pairDir: string,
  pairId: string,
  repetition: number,
): Promise<void> {
  await store.writeRecord(`${pairDir}/pair.json`, {
    pairId,
    repetition,
    conditions: [
      { conditionId: "baseline", dir: `${pairDir}/baseline` },
      { conditionId: "treatment", dir: `${pairDir}/treatment` },
    ],
  });
}

async function writeSyntheticFrozenPlan(
  store: Awaited<ReturnType<typeof createEvidenceStore>>,
  runId: string,
  repetitions: number,
): Promise<RunPlan> {
  const digest = (label: string): string => sha256Hex(label);
  const plan = buildRunPlan({
    runId,
    mode: "fake",
    suiteId: "arbitrum-docs",
    caseSelector: "example-case",
    caseId: "example-case",
    caseVersion: 1,
    repetitions,
    armOrder: ["baseline", "treatment"],
    skillGuestPath: "/skills/arbitrum-docs",
    resourceNonce: "deadbeef",
    createdAt: new Date(0).toISOString(),
    source: { revision: "test", dirty: false },
    evaluatorBuild: "test",
    parity: {
      promptSha256: digest("prompt"),
      fixtureTreeSha256: digest("fixtures"),
      outputPath: "config.json",
      oracleSha256: digest("oracle"),
      validatorSha256: digest("validator"),
      validatorClosureSha256: digest("validator-closure"),
      allowedTools: ["read", "write"],
      harnessId: "pi",
      sandboxId: "fake",
      validatorRunnerId: "in-process",
      runtimeProfileId: "default",
      imageDigest: `sha256:${digest("image")}`,
      target: { provider: "google", model: "scripted-model", thinking: "low" },
      limits: SAFE_DEFAULT_LIMITS,
      networkPolicySha256: digest("network-policy"),
      guestPolicySha256: digest("guest-policy"),
      workspaceRoot: "/workspace",
      executionPolicySha256: digest("execution-policy"),
      caseId: "example-case",
      caseVersion: 1,
      skillSnapshotTreeSha256: digest("skill-snapshot"),
      skillToolBundleSha256: digest("skill-tool-bundle"),
      candidateMode: "file",
    },
  });
  await store.writeRecord("inputs/plan.json", plan);
  return plan;
}

function extractReceiptPath(output: string): string {
  const match = output.match(/receipt\s+([^\s]+\.json)/);
  if (!match || !match[1]) {
    throw new Error(`Receipt path not found in output:\n${output}`);
  }
  return match[1];
}

describe("Process-level automatic table and report contract", () => {
  it("prints one pair-results table without averages for one repetition, and report renders it byte-identically", () => {
    const { status, stdout, stderr } = runCommand(RUN_SCRIPT, [
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "fake",
    ]);

    let receiptPath = "";
    try {
      expect(status).toBe(0);
      receiptPath = extractReceiptPath(stdout);

      const runTables = extractTables(stdout);
      expect(runTables).toHaveLength(3);

      // 1. Evaluation pillars table
      const pillarRows = tableRows(runTables[0]!);
      expect(pillarRows[0]).toEqual(["Pillar", "Without this skill", "With this skill", "Change"]);
      expect(pillarRows[1]?.[0]).toBe("Accuracy");
      expect(pillarRows[2]?.[0]).toBe("Cost: recorded tokens");
      expect(pillarRows[3]?.[0]).toBe("Latency");

      // 2. Accuracy breakdown table
      const accuracyRows = tableRows(runTables[1]!);
      expect(accuracyRows[0]).toEqual(["Check", "Without this skill", "With this skill"]);
      expect(accuracyRows.map((row) => row[0])).toEqual([
        "Check", "Outcome correctness and completeness", "Constraints and preservation", "Accuracy total",
      ]);

      // 3. Cost and latency table
      const costLatencyRows = tableRows(runTables[2]!);
      expect(costLatencyRows[0]).toEqual(["Metric", "Without this skill", "With this skill"]);
      expect(costLatencyRows[1]?.[0]).toBe("Total recorded tokens, including cached input");
      expect(costLatencyRows[2]?.[0]).toBe("Time to completion or termination (ms)");

      expect(stdout).toMatch(/^network configuration migration$/m);
      expect(stdout).toMatch(/^Run:\s+\S+ · Pair r001$/m);
      expect(stdout).toMatch(/^Status: Completed; graded$/m);
      expect(stdout).not.toMatch(/^Pair outcomes$/m);
      expect(stdout).toMatch(/^export\s+pnpm eval:export --receipt \S+$/m);
      expect(stdout).not.toMatch(/^Averages$/m);
      expect(stdout).not.toContain("Gradeable pairs:");
      expect(stdout).not.toContain("In averages:");
      expect(stdout).not.toContain("Resource diagnostics (mean treatment");
      expect(stdout).not.toMatch(/^(mode|evidence|chain)\s+/m);

      // Assert evidence label
      expect(stdout).toContain("TEST-DOUBLE EVIDENCE");

      // Assert expected cell contents
      expect(stdout).toContain("network-config-01");
      expect(stdout).toContain("fake-model-0");

      // Launch the report entry point on that exact receipt
      const reportRes = runCommand(REPORT_SCRIPT, ["--receipt", receiptPath]);
      expect(reportRes.status).toBe(0);

      // The retained report reproduces the same pair table.
      expect(extractTables(reportRes.stdout)).toEqual(runTables);
    } finally {
      if (receiptPath) {
        rmSync(dirname(receiptPath), { recursive: true, force: true });
      }
    }
  });

  it("keeps operational per-arm metadata opt-in with --details", () => {
    const normal = runCommand(RUN_SCRIPT, [
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "fake",
    ]);
    const detailed = runCommand(RUN_SCRIPT, [
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "fake",
      "--details",
      "--repetitions", "2",
    ]);

    const receipts = [normal.stdout, detailed.stdout].map(extractReceiptPath);
    try {
      expect(normal.status).toBe(0);
      expect(normal.stdout).not.toContain("score=");
      expect(detailed.status).toBe(0);
      expect(detailed.stdout).toMatch(/score=\d+\.\d{3}\b/);
      expect(detailed.stdout).toMatch(/delta\s+[+-]?\d+\.\d{3}\b/);
      const combined = runCommand(REPORT_SCRIPT, ["--receipt", receipts[0]!, "--receipt", receipts[1]!]);
      expect(combined.status).toBe(0);
      expect(combined.stdout).toMatch(/^\(1\) /m);
      expect(combined.stdout).toMatch(/^\(2\) /m);
      expect(combined.stdout.match(/^Averages$/gm)).toHaveLength(1);
      expect(combined.stdout).toContain("2 planned / 2 attempted / 2 gradeable");
      const sections = combined.stdout.split(/(?=^\(\d+\) )/m).filter((section) => /^\(\d+\) /.test(section));
      expect(sections).toHaveLength(2);
      for (const [index, section] of sections.entries()) {
        const pairCount = index + 1;
        expect(section).not.toMatch(/^Pair \d+$/m);
        if (pairCount > 1) {
          expect(section.match(/^Pair \d+: Baseline:/gm)).toEqual(Array.from({ length: pairCount }, (_, pair) => `Pair ${pair + 1}: Baseline:`));
        }
        const tables = extractTables(section);
        if (pairCount > 1) {
          expect(tables).toHaveLength(2);
          const pairRows = tableRows(tables.at(-1)!);
          expect(pairRows[0]).toEqual(PAIR_COLUMNS);
          expect(pairRows).toHaveLength(pairCount + 1);
          expect(section.match(/^Averages$/gm)).toHaveLength(1);
          expect(section.indexOf("\nAverages\n")).toBeLessThan(section.indexOf("\nPair outcomes\n"));
          expect(section).toContain(`Gradeable pairs: ${pairCount}`);
          expect(tableRows(tables[0]!)[0]).toEqual(RESULT_COLUMNS);
        } else {
          expect(tables).toHaveLength(3);
          expect(tableRows(tables[0]!)[0]).toEqual(["Pillar", "Without this skill", "With this skill", "Change"]);
          expect(tableRows(tables[1]!)[0]).toEqual(["Check", "Without this skill", "With this skill"]);
          expect(tableRows(tables[1]!).map((row) => row[0])).not.toContain("Unhappy-path handling");
          expect(tableRows(tables[2]!)[0]).toEqual(["Metric", "Without this skill", "With this skill"]);
          expect(section).not.toMatch(/^Averages$/m);
          expect(section).not.toContain("Gradeable pairs:");
        }
      }
      const combinedJson = runCommand(REPORT_SCRIPT, ["--receipt", receipts[0]!, "--receipt", receipts[1]!, "--format", "json"]);
      expect(combinedJson.status).toBe(0);
      const runs = JSON.parse(combinedJson.stdout);
      expect(runs).toHaveLength(2);
      expect(runs.map((run: { counts: { validPairs: number } }) => run.counts.validPairs)).toEqual([1, 2]);
      expect(runs[0].scored).not.toBeNull();
      // Multi-pair runs expose the mean-over-every-pair scored model (B2).
      expect(runs[1].scored).not.toBeNull();
      expect(runs[1].scored.mode).toBe("mean");
      expect(runs[1].scored.pairIds).toEqual(runs[1].pairs.map((pair: { pairId: string }) => pair.pairId));
      // Multi-pair run retains the pair table with pairIds matching runs[1].pairs
      const multiPairIds = tableRows(extractTables(sections[1]!).at(-1)!).slice(1).map((row) => row[0]);
      expect(multiPairIds).toEqual(runs[1].pairs.map((pair: { pairId: string }) => pair.pairId));
      expect(new Set(multiPairIds).size).toBe(multiPairIds.length);
      // Single-pair run contains pair 1 outcome
      expect(sections[0]).toContain("Status: Completed; graded");
    } finally {
      for (const receipt of receipts) rmSync(dirname(receipt), { recursive: true, force: true });
    }
  });

  it("emits lifecycle progress facts on stderr in order with arm identity, and quiet mode suppresses progress", () => {
    // 1. Normal run: captures progress on stderr
    const normal = runCommand(RUN_SCRIPT, [
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "fake",
    ]);

    let receiptPath = "";
    try {
      expect(normal.status).toBe(0);
      receiptPath = extractReceiptPath(normal.stdout);

      const stderr = normal.stderr;
      expect(stderr.length).toBeGreaterThan(0);

      // Verify the shared lifecycle order, without imposing an order on overlapping completions.
      const transitions = [
        "request validated",
        "freeze started",
        "freeze completed",
        "pair 1/1 preparing",
        "both arms ready",
        "[baseline] execution started",
        "[treatment] execution started",
        "cleanup verified",
        "[baseline] capture and grading started",
        "[baseline] capture and grading completed",
        "[treatment] capture and grading started",
        "[treatment] capture and grading completed",
        "evidence sealing started",
        "finalization completed: success=true",
      ];

      let lastIndex = 0;
      for (const t of transitions) {
        const idx = stderr.indexOf(t, lastIndex);
        expect(idx, `expected transition '${t}' in stderr after index ${lastIndex}:\n${stderr}`).toBeGreaterThanOrEqual(0);
        lastIndex = idx + t.length;
      }

      for (const arm of ["baseline", "treatment"]) {
        const started = stderr.indexOf(`[${arm}] execution started`);
        const completed = stderr.indexOf(`[${arm}] completed`);
        expect(completed).toBeGreaterThan(started);
        expect(completed).toBeLessThan(stderr.indexOf("cleanup verified"));
      }

      // Assert neither stream contains secret markers, prompts or private reasoning
      expect(stderr).not.toContain("private thoughts");
      expect(normal.stdout).not.toContain("private thoughts");
    } finally {
      if (receiptPath) {
        rmSync(dirname(receiptPath), { recursive: true, force: true });
      }
    }

    // 2. Quiet mode: suppresses progress on stderr while keeping table on stdout
    const quiet = runCommand(RUN_SCRIPT, [
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "fake",
      "--quiet",
    ]);

    let quietReceipt = "";
    try {
      expect(quiet.status).toBe(0);
      quietReceipt = extractReceiptPath(quiet.stdout);
      // Stderr has no progress lines
      expect(quiet.stderr.trim()).toBe("");
      // Stdout still has the table
      expect(quiet.stdout).toContain("┌─");
      expect(quiet.stdout).toContain("└─");
    } finally {
      if (quietReceipt) {
        rmSync(dirname(quietReceipt), { recursive: true, force: true });
      }
    }
  });

  it("ensures read-only commands emit NO run-progress messages", () => {
    // Validate command
    const valRes = runCommand(VALIDATE_SCRIPT, []);
    expect(valRes.stderr).not.toContain("pair 1/1");
    expect(valRes.stderr).not.toContain("preparing");
    expect(valRes.stderr).not.toContain("both arms ready");

    // Doctor command
    const docRes = runCommand(DOCTOR_SCRIPT, []);
    expect(docRes.stderr).not.toContain("pair 1/1");
    expect(docRes.stderr).not.toContain("preparing");
  });

  it("supports --format json with parseable stdout and --format markdown with identical values", () => {
    const jsonRes = runCommand(RUN_SCRIPT, [
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "fake",
      "--format", "json",
    ]);

    let receiptPath = "";
    try {
      expect(jsonRes.status).toBe(0);
      // Stdout must be 100% parseable JSON without banners
      const parsed = JSON.parse(jsonRes.stdout);
      expect(parsed.schemaVersion).toBe(REPORT_JSON_SCHEMA_VERSION);
      expect(parsed.status).toBe("complete");
      expect(parsed.testDouble).toBe(true);
      expect(parsed.evidenceLabel).toContain("TEST-DOUBLE EVIDENCE");
      expect(parsed.summary).toBeDefined();
      expect(typeof parsed.summary.baseline).toBe("number");
      expect(typeof parsed.summary.treatment).toBe("number");
      expect(typeof parsed.summary.delta).toBe("number");
      expect(parsed.counts.validPairs).toBe(1);
      receiptPath = parsed.receipt;

      // Report in JSON format
      const reportJsonRes = runCommand(REPORT_SCRIPT, ["--receipt", receiptPath, "--format", "json"]);
      expect(reportJsonRes.status).toBe(0);
      const reportParsed = JSON.parse(reportJsonRes.stdout);
      expect(reportParsed.summary).toEqual(parsed.summary);
      expect(reportParsed.counts).toEqual(parsed.counts);

      // Markdown format
      const mdRes = runCommand(REPORT_SCRIPT, ["--receipt", receiptPath, "--format", "markdown"]);
      expect(mdRes.status).toBe(0);
      expect(mdRes.stdout).toContain("# EVALS.MD: network configuration migration");
      expect(mdRes.stdout).toContain(`Agent: fake · google/fake-model-0`);
      expect(mdRes.stdout).toContain(`Skill: mcp-skill`);
      expect(mdRes.stdout).toContain(`Run: ${parsed.runId} · Pair r001`);
      expect(mdRes.stdout).toContain("Status: Completed; graded");
      expect(mdRes.stdout).toContain("| Pillar | Without this skill | With this skill | Change |");
      expect(mdRes.stdout).toContain(`| Accuracy | ${parsed.scored.accuracy.baseline}% | ${parsed.scored.accuracy.treatment}% |`);
      expect(mdRes.stdout).toContain("## Scenario: Migrate production and staging network configuration to Arbitrum");
      expect(mdRes.stdout).toContain("### Accuracy");
      expect(mdRes.stdout).toContain("| Check | Without this skill | With this skill |");
      expect(mdRes.stdout).toContain("| Outcome correctness and completeness |");
      expect(mdRes.stdout).not.toContain("Unhappy-path handling");
      expect(mdRes.stdout).toContain("| Constraints and preservation |");
      expect(mdRes.stdout).toContain(`| **Accuracy total** | **${parsed.scored.accuracy.baseline}/100 — ${parsed.scored.accuracy.baseline}%** | **${parsed.scored.accuracy.treatment}/100 — ${parsed.scored.accuracy.treatment}%** |`);
      expect(mdRes.stdout).toContain("### Cost and latency");
      expect(mdRes.stdout).not.toContain("## Averages");
      expect(mdRes.stdout).not.toContain("## Pair outcomes");
      expect(mdRes.stdout).not.toContain("Gradeable pairs:");
      expect(mdRes.stdout).not.toContain("score=");

      // Numeric agreement: markdown and json share identical numbers
      expect(mdRes.stdout).toContain(`${parsed.scored.accuracy.baseline}%`);
      expect(mdRes.stdout).toContain(`${parsed.scored.accuracy.treatment}%`);
      expect(mdRes.stdout).toContain(parsed.scored.groups.outcome.baseline);
      expect(mdRes.stdout).toContain(parsed.scored.groups.outcome.treatment);
      expect(mdRes.stdout).toContain(parsed.scored.groups.constraints.baseline);
      expect(mdRes.stdout).toContain(parsed.scored.groups.constraints.treatment);

      const detailedMdRes = runCommand(REPORT_SCRIPT, ["--receipt", receiptPath, "--format", "markdown", "--details"]);
      expect(detailedMdRes.status).toBe(0);
      expect(detailedMdRes.stdout).toContain("## Operational details");
      expect(detailedMdRes.stdout).toMatch(/score=\d+\.\d{3}\b/);

      const detailedJsonRes = runCommand(REPORT_SCRIPT, ["--receipt", receiptPath, "--format", "json", "--details"]);
      expect(detailedJsonRes.status).toBe(0);
      expect(JSON.parse(detailedJsonRes.stdout)).toEqual(reportParsed);

      const checksMdRes = runCommand(REPORT_SCRIPT, ["--receipt", receiptPath, "--format", "markdown", "--checks"]);
      expect(checksMdRes.status).toBe(0);
      expect(checksMdRes.stdout).toContain("### Accuracy Outcome Checks");
      expect(checksMdRes.stdout).toContain("| Correct network identities |");

      const checksJsonRes = runCommand(REPORT_SCRIPT, ["--receipt", receiptPath, "--format", "json", "--checks"]);
      expect(checksJsonRes.status).toBe(0);
      expect(JSON.parse(checksJsonRes.stdout)).toEqual(reportParsed);
    } finally {
      if (receiptPath) {
        rmSync(dirname(receiptPath), { recursive: true, force: true });
      }
    }
  });

  it("renders markdown status header with both arms for mixed case baseline task-limit and treatment completed", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "mixed-status-"));
    const workDir = join(tempRoot, "work");

    try {
      await writeOfflineSkill(tempRoot);
      const mixedHarness = createFakeHarness({
        script: (request) => ({
          outcome: request.conditionId === "baseline" ? "task-limit" : "completed",
          assistantText: request.conditionId === "baseline" ? "task limit reached" : "task completed",
        }),
      });

      const result = await runPairedEvaluation({
        evalsRoot: process.cwd(),
        repoRoot: tempRoot,
        caseSelector: "network-config-01",
        skillPath: "src/test-fixtures/skills/mcp-skill",
        mode: "fake",
        repetitions: 1,
        cliLimits: SAFE_DEFAULT_LIMITS,
        target: { provider: "google", model: "fake-model-0", thinking: "off" },
        runId: "mixed-status-test",
        runsRoot: join(tempRoot, "runs"),
        resourceNonce: "abcd1234",
        createdAt: new Date().toISOString(),
        source: { revision: "test", dirty: false },
        evaluatorBuild: "test",
        harness: mixedHarness,
        sandbox: createFakeSandbox(),
        validatorRunner: createInProcessValidatorRunner(),
        workDir,
      });

      const mdRes = runCommand(REPORT_SCRIPT, ["--receipt", result.receiptPath, "--format", "markdown"]);
      expect(mdRes.status).toBe(0);
      expect(mdRes.stdout).toContain("Status: Without this skill: task limit reached, graded · With this skill: completed, graded\n");
    } finally {
      await disposeRunWorkDir(workDir).catch(() => {});
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("gates native session export command on session availability in report output", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "native-gate-"));
    try {
      // 1. Synthetic run with unavailable session (one condition has no session.json, other has available: false)
      const noSessionRunId = "run-no-session";
      const noSessionDir = join(tempRoot, noSessionRunId);
      const noSessionStore = await createEvidenceStore({ runDir: noSessionDir, guardedSecrets: [] });
      await noSessionStore.writeRecord("inputs/target.json", {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        provider: "google",
        model: "fake-model-0",
        thinking: "low",
        harnessId: "fake",
      });
      const planNoSession = await writeSyntheticFrozenPlan(noSessionStore, noSessionRunId, 1);
      const pairDir1 = `pairs/${noSessionRunId}-r001`;
      await writeSyntheticPairRecord(noSessionStore, pairDir1, `${noSessionRunId}-r001`, 1);
      for (const cond of ["baseline", "treatment"] as const) {
        await noSessionStore.writeRecord(`${pairDir1}/${cond}/condition.json`, {
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
          conditionId: cond,
          status: "completed",
          gradeable: true,
          skillPaths: cond === "treatment" ? ["/skills/arbitrum-docs"] : [],
          timing: { durationMs: 50 },
          usage: null,
          cleanup: [],
        });
        await noSessionStore.writeRecord(`${pairDir1}/${cond}/validation.json`, {
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
          outcome: { status: "graded", score: 1.0, fullPass: true, checks: [] },
        });
      }
      // treatment has session.json with available: false; baseline has no session.json
      await noSessionStore.writeRecord(`${pairDir1}/treatment/session.json`, {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        conditionId: "treatment",
        available: false,
        completed: false,
        tailStatus: "unavailable",
        incompleteTail: false,
        incompleteReason: "native session entries unavailable for this condition",
        entries: [],
        entryCount: 0,
        redactions: { count: 0, locations: [] },
      });

      const noSessionManifest = await noSessionStore.sealManifest();
      const noSessionReceipt = await noSessionStore.sealReceipt({
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        runId: noSessionRunId,
        suiteId: "arbitrum-docs",
        caseSelector: "example-case",
        caseId: "example-case",
        mode: "fake",
        status: "complete",
        stopReason: null,
        testDouble: true,
        evidenceLabel: "TEST-DOUBLE EVIDENCE",
        createdAt: new Date().toISOString(),
        finalizedAt: new Date().toISOString(),
        planSha256: planNoSession.planSha256,
        manifest: { treeSha256: noSessionManifest.tree.treeSha256, fileSha256: noSessionManifest.fileSha256 },
        pairs: [
          {
            pairId: `${noSessionRunId}-r001`,
            repetition: 1,
            path: `${pairDir1}/pair.json`,
            conditions: [
              { conditionId: "baseline", dir: `${pairDir1}/baseline` },
              { conditionId: "treatment", dir: `${pairDir1}/treatment` },
            ],
          },
        ],
        cleanup: [],
        failures: [],
      });

      const noSessionRes = runCommand(REPORT_SCRIPT, ["--receipt", noSessionReceipt.path]);
      expect(noSessionRes.status).toBe(0);
      expect(noSessionRes.stdout).toContain("native    n/a (no native Pi session recorded for this run)");
      expect(noSessionRes.stdout).not.toContain("--view session --export both");

      // 2. Synthetic run with available session.json
      const withSessionRunId = "run-with-session";
      const withSessionDir = join(tempRoot, withSessionRunId);
      const withSessionStore = await createEvidenceStore({ runDir: withSessionDir, guardedSecrets: [] });
      await withSessionStore.writeRecord("inputs/target.json", {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        provider: "google",
        model: "scripted-model",
        thinking: "low",
        harnessId: "pi",
      });
      const planWithSession = await writeSyntheticFrozenPlan(withSessionStore, withSessionRunId, 1);
      const pairDir2 = `pairs/${withSessionRunId}-r001`;
      await writeSyntheticPairRecord(withSessionStore, pairDir2, `${withSessionRunId}-r001`, 1);
      for (const cond of ["baseline", "treatment"] as const) {
        await withSessionStore.writeRecord(`${pairDir2}/${cond}/condition.json`, {
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
          conditionId: cond,
          status: "completed",
          gradeable: true,
          skillPaths: cond === "treatment" ? ["/skills/arbitrum-docs"] : [],
          timing: { durationMs: 50 },
          usage: null,
          cleanup: [],
        });
        await withSessionStore.writeRecord(`${pairDir2}/${cond}/validation.json`, {
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
          outcome: { status: "graded", score: 1.0, fullPass: true, checks: [] },
        });
        await withSessionStore.writeRecord(`${pairDir2}/${cond}/session.json`, {
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
          conditionId: cond,
          available: true,
          completed: true,
          tailStatus: "completed",
          incompleteTail: false,
          incompleteReason: null,
          entries: [
            { type: "session", id: `sess-${cond}`, cwd: "/workspace" },
            { type: "message", role: "user", content: "hello" },
          ],
          entryCount: 2,
          redactions: { count: 0, locations: [] },
        });
      }
      const withSessionManifest = await withSessionStore.sealManifest();
      const withSessionReceipt = await withSessionStore.sealReceipt({
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        runId: withSessionRunId,
        suiteId: "arbitrum-docs",
        caseSelector: "example-case",
        caseId: "example-case",
        mode: "fake",
        status: "complete",
        stopReason: null,
        testDouble: true,
        evidenceLabel: "TEST-DOUBLE EVIDENCE",
        createdAt: new Date().toISOString(),
        finalizedAt: new Date().toISOString(),
        planSha256: planWithSession.planSha256,
        manifest: { treeSha256: withSessionManifest.tree.treeSha256, fileSha256: withSessionManifest.fileSha256 },
        pairs: [
          {
            pairId: `${withSessionRunId}-r001`,
            repetition: 1,
            path: `${pairDir2}/pair.json`,
            conditions: [
              { conditionId: "baseline", dir: `${pairDir2}/baseline` },
              { conditionId: "treatment", dir: `${pairDir2}/treatment` },
            ],
          },
        ],
        cleanup: [],
        failures: [],
      });

      const withSessionRes = runCommand(REPORT_SCRIPT, ["--receipt", withSessionReceipt.path]);
      expect(withSessionRes.status).toBe(0);
      expect(withSessionRes.stdout).toContain(
        `native    pnpm eval:inspect --receipt ${withSessionReceipt.path} --pair ${withSessionRunId}-r001 --condition treatment --view session --export both`,
      );
      expect(withSessionRes.stdout).not.toContain("native    n/a");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("validates history CLI argv before run discovery", () => {
    const invalid = runCommand(HISTORY_SCRIPT, ["--format", "bogus"]);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).not.toContain("UnhandledPromiseRejection");
    expect(invalid.stderr).not.toContain("node:internal");
    const stderrLines = invalid.stderr.trim().split("\n").filter((l) => l.length > 0);
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toMatch(/^FAIL \[input-invalid\]: /);

    const help = runCommand(HISTORY_SCRIPT, ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toBe("usage: eval:history [--format table|json] [--latest] [--case <id>]\n");
    expect(help.stderr).toBe("");
  });

  describe("multi-repetition receipt population tampering", () => {
    let fixtureRoot = "";
    let authenticRunDir = "";
    let authenticReceipt: { pairs: unknown[] };

    beforeAll(async () => {
      const runRes = runCommand(RUN_SCRIPT, [
        "--skill", "src/test-fixtures/skills/mcp-skill",
        "--case", "network-config-01",
        "--mode", "fake",
        "--repetitions", "2",
      ]);
      expect(runRes.status).toBe(0);
      authenticRunDir = dirname(extractReceiptPath(runRes.stdout));
      authenticReceipt = JSON.parse(readFileSync(join(authenticRunDir, "receipt.json"), "utf8")) as { pairs: unknown[] };
      fixtureRoot = await mkdtemp(join(tmpdir(), "population-attacks-"));
    });

    afterAll(async () => {
      if (authenticRunDir) await rm(authenticRunDir, { recursive: true, force: true });
      if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
    });

    const attacks: Array<readonly [string, (pairs: unknown[]) => unknown[]]> = [
      ["omitted", (pairs) => pairs.slice(0, 1)],
      ["duplicated", (pairs) => [pairs[0], pairs[0]]],
      ["reordered", (pairs) => [...pairs].reverse()],
    ];

    for (const [name, alter] of attacks) {
      it(`refuses human and JSON scores when the receipt population is ${name}`, async () => {
        // The old and new forms both generate one authentic CLI run. Copying it gives
        // each attack an independent timeout/workload while its human and JSON checks
        // stay together; this is reliability isolation, not fewer authentic fixtures.
        const attackDir = join(fixtureRoot, name);
        await cp(authenticRunDir, attackDir, { recursive: true });
        const receiptPath = join(attackDir, "receipt.json");
        await chmod(receiptPath, 0o644);
        await writeFile(receiptPath, `${JSON.stringify({ ...authenticReceipt, pairs: alter(authenticReceipt.pairs) })}\n`, "utf8");

        const human = runCommand(REPORT_SCRIPT, ["--receipt", receiptPath]);
        expect(human.status).toBe(1);
        expect(human.stdout).toContain("REFUSED");
        expect(human.stdout).not.toContain("┌─");
        expect(human.stdout).not.toContain("score=");

        const machine = runCommand(REPORT_SCRIPT, ["--receipt", receiptPath, "--format", "json"]);
        expect(machine.status).toBe(1);
        const parsed = JSON.parse(machine.stdout);
        expect(parsed.receipt).toBeNull();
        expect(parsed.summary).toBeNull();
        expect(parsed.pairs).toBeUndefined();
      });
    }
  });

  it("exits nonzero for a verified partial invocation while still emitting one honest JSON result", async () => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        RUN_SCRIPT,
        "--skill", "src/test-fixtures/skills/mcp-skill",
        "--case", "network-config-01",
        "--mode", "fake",
        "--format", "json",
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: buildAllowlistedEnv(tmpdir()),
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
      if (stderr.includes("execution started") && !child.killed) {
        child.kill("SIGINT");
      }
    });
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(status).toBe(1);
    const parsed = JSON.parse(stdout) as { status: string; receipt: string };
    expect(parsed.status).toBe("partial");
    expect(parsed.receipt).toMatch(/receipt\.json$/);
    await rm(dirname(parsed.receipt), { recursive: true, force: true });
  });

  it("refuses numeric scores and exits nonzero when evidence is tampered with", () => {
    const runRes = runCommand(RUN_SCRIPT, [
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "fake",
    ]);

    expect(runRes.status).toBe(0);
    const receiptPath = extractReceiptPath(runRes.stdout);
    const runDir = dirname(receiptPath);

    try {
      // Tamper with one byte of target.json
      const validationPath = join(runDir, "inputs", "target.json");
      chmodSync(validationPath, 0o644);
      writeFileSync(validationPath, JSON.stringify({ tampered: true }), "utf8");

      // Report must fail with nonzero exit code and NO numeric scores table
      const reportRes = runCommand(REPORT_SCRIPT, ["--receipt", receiptPath]);
      expect(reportRes.status).toBe(1);
      expect(reportRes.stdout).toContain("verification FAILED");
      expect(reportRes.stdout).toContain("REFUSED");
      expect(reportRes.stdout).not.toContain("┌─");
      expect(reportRes.stdout).not.toContain("score=");

      // JSON mode also returns structured failure with receipt: null
      const reportJson = runCommand(REPORT_SCRIPT, ["--receipt", receiptPath, "--format", "json"]);
      expect(reportJson.status).toBe(1);
      const parsed = JSON.parse(reportJson.stdout);
      expect(parsed.success).toBe(false);
      expect(parsed.receipt).toBeNull();
      expect(parsed.summary).toBeNull();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe("Population regression, cache accounting, and telemetry denominators", () => {
  it("computes exact population regression: (0.2,0.6) and (0.8,0.4) plus invalid baseline 1.0 -> 0.500 | 0.500 | 0.000", async () => {
    // Construct synthetic run directory
    const tempRoot = mkdtempSync(join(tmpdir(), "pop-regression-"));
    const runId = "pop-reg-run";
    const runDir = join(tempRoot, runId);
    const store = await createEvidenceStore({ runDir, guardedSecrets: [] });
    const journal = await createRunJournal({ stateDir: tempRoot, runId, nonce: "testnonce" });

    // Target and metadata
    await store.writeRecord("inputs/target.json", {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      provider: "google",
      model: "scripted-model",
      thinking: "low",
      harnessId: "pi",
    });

    const plan = await writeSyntheticFrozenPlan(store, runId, 3);
    const pairs = [
      { id: `${runId}-r001`, rep: 1, baseScore: 0.2, treatScore: 0.6, baseTok: 100, treatTok: 220, valid: true },
      { id: `${runId}-r002`, rep: 2, baseScore: 0.8, treatScore: 0.4, baseTok: null, treatTok: null, valid: true },
      { id: `${runId}-r003`, rep: 3, baseScore: 1.0, treatScore: null, baseTok: 50, treatTok: null, valid: false },
    ];

    const pairRefs = [];

    for (const p of pairs) {
      const pairDir = `pairs/${p.id}`;
      await writeSyntheticPairRecord(store, pairDir, p.id, p.rep);

      // Baseline condition
      await store.writeRecord(`${pairDir}/baseline/condition.json`, {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        conditionId: "baseline",
        status: "completed",
        gradeable: true,
        skillPaths: [],
        timing: { durationMs: 1000 },
        usage: p.baseTok !== null
          ? { inputTokens: p.baseTok, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
          : null,
        cleanup: [],
      });
      await store.writeRecord(`${pairDir}/baseline/validation.json`, {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        outcome: { status: "graded", score: p.baseScore, fullPass: false, checks: [] },
      });

      // Treatment condition
      const treatGradeable = p.valid;
      await store.writeRecord(`${pairDir}/treatment/condition.json`, {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        conditionId: "treatment",
        status: treatGradeable ? "completed" : "infrastructure-failure",
        gradeable: treatGradeable,
        skillPaths: ["/skills/arbitrum-docs"],
        timing: { durationMs: 2500 },
        usage: p.treatTok !== null
          ? { inputTokens: p.treatTok, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
          : null,
        cleanup: [],
      });
      await store.writeRecord(`${pairDir}/treatment/validation.json`, {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        outcome: treatGradeable ? { status: "graded", score: p.treatScore, fullPass: false, checks: [] } : null,
      });

      pairRefs.push({
        pairId: p.id,
        repetition: p.rep,
        path: `${pairDir}/pair.json`,
        conditions: [
          { conditionId: "baseline", dir: `${pairDir}/baseline` },
          { conditionId: "treatment", dir: `${pairDir}/treatment` },
        ],
      });
    }

    const manifest = await store.sealManifest();
    const receiptPath = await store.sealReceipt({
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      runId,
      suiteId: "arbitrum-docs",
      caseSelector: "example-case",
      caseId: "example-case",
      mode: "fake",
      status: "complete",
      stopReason: null,
      testDouble: true,
      evidenceLabel: "TEST-DOUBLE EVIDENCE",
      createdAt: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
      planSha256: plan.planSha256,
      manifest: { treeSha256: manifest.tree.treeSha256, fileSha256: manifest.fileSha256 },
      pairs: pairRefs,
      cleanup: [],
      failures: [],
    });

    const report = await buildRunReport(receiptPath.path);

    // Assert summary numbers: Baseline 0.500 | Treatment 0.500 | Delta 0.000
    expect(report.summary?.baselineMean).toBe(0.5);
    expect(report.summary?.treatmentMean).toBe(0.5);
    expect(report.summary?.qualityDelta).toBe(0.0);

    // Detail retains unpaired baseline score of 1.0
    expect(report.pairs[2]?.baselineScore).toBe(1.0);
    expect(report.pairs[2]?.treatmentScore).toBeNull();
    expect(report.pairs[2]?.valid).toBe(false);

    // Token delta reports 1-pair denominator (+120 delta)
    expect(report.counts?.tokenDenominator).toBe(1);
    expect(report.summary?.tokensDelta).toBe(120);

    // Format table and assert text cells
    const tableText = renderResultsTable(report);
    expect(tableText).toMatch(/0\.500\s+│\s+0\.500\s+│\s+0\.000\s+│\s+\+120/);

    const fullReportText = formatRunReport(report);
    expect(fullReportText).toContain("Tokens Δ uses 1 pair(s)");
    expect(fullReportText).toContain("3 planned / 3 attempted / 2 gradeable");
    expect(fullReportText).toContain("Pair 3 excluded from averages:");
    expect(fullReportText).toContain("Pair 3: Baseline: completed / NOT PASS; Treatment: infrastructure-failure / ungraded; In averages: no.");
    expect(fullReportText).toContain("Gradeable pairs: 2");
    expect(fullReportText).not.toMatch(/^Pair \d+$/m);
    expect(fullReportText.match(/^Pair \d+: Baseline:/gm)).toEqual(["Pair 1: Baseline:", "Pair 2: Baseline:", "Pair 3: Baseline:"]);
    const tables = extractTables(fullReportText);
    expect(tables).toHaveLength(2);
    expect(tableRows(tables[0]!)[0]).toEqual(RESULT_COLUMNS);
    expect(tableRows(tables[1]!)[0]).toEqual(PAIR_COLUMNS);
    const expectedMeanRow = ["example-case", "pi", "google", "scripted-model", "0.500", "0.500", "0.000", "+120", "+1,500 ms"];
    const expectedPairRows = [
      [`${runId}-r001`, "example-case", "pi", "google", "scripted-model", "0.200", "0.600", "+0.400", "+120", "+1,500 ms"],
      [`${runId}-r002`, "example-case", "pi", "google", "scripted-model", "0.800", "0.400", "-0.400", "n/a", "+1,500 ms"],
      [`${runId}-r003`, "example-case", "pi", "google", "scripted-model", "1.000", "n/a", "n/a", "n/a", "n/a"],
    ];
    expect(tableRows(tables[0]!).slice(1)).toEqual([expectedMeanRow]);
    expect(tableRows(tables[1]!).slice(1)).toEqual(expectedPairRows);
    expect(fullReportText.indexOf("\nAverages\n")).toBeLessThan(fullReportText.indexOf("\nPair outcomes\n"));
    expect(fullReportText.indexOf(tables[1]!) + tables[1]!.length).toBeLessThan(fullReportText.indexOf("Pair 1: Baseline:"));
    expect(fullReportText).not.toContain("score=");

    const markdown = formatRunReport(report, { format: "markdown" });
    expect(markdown).not.toMatch(/^### Pair \d+$/m);
    expect(markdown.split("\n").filter((line) => line === MARKDOWN_HEADER)).toHaveLength(1);
    expect(markdown.split("\n").filter((line) => line === PAIR_MARKDOWN_HEADER)).toHaveLength(1);
    expect(markdown.split("\n").filter((line) => line.startsWith("| example-case |")))
      .toEqual([`| ${expectedMeanRow.join(" | ")} |`]);
    expect(markdown.split("\n").filter((line) => line.startsWith(`| ${runId}-r`)))
      .toEqual(expectedPairRows.map((row) => `| ${row.join(" | ")} |`));
    expect(markdown.indexOf("## Averages")).toBeLessThan(markdown.indexOf("## Pair outcomes"));
    expect(markdown).toContain("Pair 3 excluded from averages:");
    expect(markdown).toContain("Gradeable pairs: 2");

    const detailedReportText = formatRunReport(report, { details: true });
    expect(detailedReportText).toContain("score=1.000");
    expect(detailedReportText).toContain("score=n/a");
    expect(detailedReportText).toContain("delta     none —");

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("keeps a fully correct task-limit answer eligible and accounts for cached tokens", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "cache-acc-"));
    const runId = "cache-run";
    const runDir = join(tempRoot, runId);
    const store = await createEvidenceStore({ runDir, guardedSecrets: [] });

    await store.writeRecord("inputs/target.json", {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      provider: "google",
      model: "scripted-model",
      thinking: "low",
      harnessId: "pi",
    });

    const plan = await writeSyntheticFrozenPlan(store, runId, 1);
    const pairId = `${runId}-r001`;
    const pairDir = `pairs/${pairId}`;
    // Baseline: uncached input 1000, cacheRead 500, cacheWrite 200, output 300 -> total consumed 2000
    await store.writeRecord(`${pairDir}/baseline/condition.json`, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      conditionId: "baseline",
      status: "completed",
      gradeable: true,
      skillPaths: [],
      timing: { durationMs: 1000 },
      usage: {
        inputTokens: 1000,
        cacheReadTokens: 500,
        cacheWriteTokens: 200,
        outputTokens: 300,
      },
      cleanup: [],
    });
    await store.writeRecord(`${pairDir}/baseline/validation.json`, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      outcome: { status: "graded", score: 0.5, fullPass: false, checks: [] },
    });

    // Treatment: uncached input 1200, cacheRead 600, cacheWrite 200, output 400 -> total consumed 2400
    await store.writeRecord(`${pairDir}/treatment/condition.json`, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      conditionId: "treatment",
      status: "task-limit",
      gradeable: true,
      skillPaths: ["/skill"],
      timing: { durationMs: 1500 },
      usage: {
        inputTokens: 1200,
        cacheReadTokens: 600,
        cacheWriteTokens: 200,
        outputTokens: 400,
      },
      cleanup: [],
    });
    await store.writeRecord(`${pairDir}/treatment/validation.json`, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      outcome: { status: "graded", score: 1, fullPass: true, checks: [] },
    });

    await writeSyntheticPairRecord(store, pairDir, pairId, 1);
    const manifest = await store.sealManifest();
    const receiptPath = await store.sealReceipt({
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      runId,
      suiteId: "arbitrum-docs",
      caseSelector: "example-case",
      caseId: "example-case",
      mode: "fake",
      status: "complete",
      stopReason: null,
      testDouble: true,
      evidenceLabel: "TEST-DOUBLE EVIDENCE",
      createdAt: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
      planSha256: plan.planSha256,
      manifest: { treeSha256: manifest.tree.treeSha256, fileSha256: manifest.fileSha256 },
      pairs: [
        {
          pairId,
          repetition: 1,
          path: `${pairDir}/pair.json`,
          conditions: [
            { conditionId: "baseline", dir: `${pairDir}/baseline` },
            { conditionId: "treatment", dir: `${pairDir}/treatment` },
          ],
        },
      ],
      cleanup: [],
      failures: [],
    });

    const report = await buildRunReport(receiptPath.path);

    // Delta is 2400 - 2000 = +400
    expect(report.summary?.tokensDelta).toBe(400);
    expect(report.counts?.validPairs).toBe(1);
    expect(report.summary?.treatmentMean).toBe(1);
    expect(report.summary?.qualityDelta).toBe(0.5);
    expect(formatRunReport(report)).toContain("Pair 1: Baseline: completed / NOT PASS; Treatment: task-limit / PASS.");
    expect(formatRunReport(report)).not.toContain("Gradeable pairs:");
    expect(formatRunReport(report)).not.toMatch(/^Averages$/m);
    expect(formatRunReport(report)).not.toContain("excluded from averages");
    expect(formatRunReport(report, { format: "markdown" })).toContain("task-limit / PASS");
    expect(renderResultsTable(report)).toContain("+400");

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("proves slow treatment staging does NOT consume treatment's model allowance", async () => {
    // Test that staging happens before readiness and dispatch, so a delay in staging
    // leaves the model allowance completely intact.
    const tempRoot = mkdtempSync(join(tmpdir(), "slow-staging-"));
    const workDir = join(tempRoot, "work");

    try {
      await writeOfflineSkill(tempRoot);
      // Tight wall-clock allowance of 2,500ms
      const tightLimits = { ...SAFE_DEFAULT_LIMITS, wallClockMs: 2_500 };

      // Fake sandbox that injects a 1,500ms delay in stage() for treatment
      const baseSandbox = createFakeSandbox();
      const delayedSandbox = {
        ...baseSandbox,
        async createGuest(spec: any) {
          const guest = await baseSandbox.createGuest(spec);
          const originalStage = guest.stage.bind(guest);
          guest.stage = async (req: any) => {
            if (spec.env.EVAL_CONDITION === "treatment") {
              await new Promise((r) => setTimeout(r, 1_500));
            }
            return await originalStage(req);
          };
          return guest;
        },
      };

      // Scripted harness with prompt that takes 1,200ms
      // If staging consumed the 2,500ms budget, treatment (1,500ms staging + 1,200ms prompt = 2,700ms)
      // would exceed the 2,500ms budget and become "task-limit"!
      // But with separated readiness, treatment finishes with "completed"!
      const streamSimpleOverride = createScriptedStreamSimple(async () => {
        await new Promise((r) => setTimeout(r, 1_200));
        return { type: "text", text: "prompt finished" };
      });

      const harness = createPiHarness({ streamSimpleOverride });
      const validatorRunner = createInProcessValidatorRunner();

      const result = await runPairedEvaluation({
        evalsRoot: process.cwd(),
        repoRoot: tempRoot,
        caseSelector: "network-config-01",
        skillPath: "src/test-fixtures/skills/mcp-skill",
        mode: "fake",
        repetitions: 1,
        cliLimits: tightLimits,
        target: { provider: "google", model: "gemini-3.8-flash", thinking: "low" },
        runId: "parity-timing-test",
        runsRoot: join(tempRoot, "runs"),
        resourceNonce: "abcd1234",
        createdAt: new Date().toISOString(),
        source: { revision: "test", dirty: false },
        evaluatorBuild: "test",
        harness,
        sandbox: delayedSandbox as any,
        validatorRunner,
        workDir,
        schedulingPolicy: "overlap",
      });

      const report = await buildRunReport(result.receiptPath);
      const treatmentCond = report.pairs[0]?.conditions.find((c) => c.conditionId === "treatment");

      // Must be completed, NOT task-limit!
      expect(treatmentCond?.status, JSON.stringify(result.failures)).toBe("completed");

    } finally {
      await disposeRunWorkDir(workDir);
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("handles task stop, partial infrastructure failure, zero valid pairs, and absent telemetry", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "outcomes-test-"));
    const runId = "outcomes-run";
    const runDir = join(tempRoot, runId);
    const store = await createEvidenceStore({ runDir, guardedSecrets: [] });

    await store.writeRecord("inputs/target.json", {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      provider: "google",
      model: "scripted-model",
      thinking: "low",
      harnessId: "pi",
    });

    const plan = await writeSyntheticFrozenPlan(store, runId, 3);

    // Pair 1: Task stop on treatment (length limit, gradeable low score 0.1)
    const p1Id = `${runId}-r001`;
    const p1Dir = `pairs/${p1Id}`;
    await store.writeRecord(`${p1Dir}/baseline/condition.json`, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      conditionId: "baseline",
      status: "completed",
      gradeable: true,
      skillPaths: [],
      timing: { durationMs: 1000 },
      usage: { inputTokens: 50, outputTokens: 50 },
      cleanup: [],
    });
    await store.writeRecord(`${p1Dir}/baseline/validation.json`, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      outcome: { status: "graded", score: 0.8, fullPass: false, checks: [] },
    });
    await store.writeRecord(`${p1Dir}/treatment/condition.json`, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      conditionId: "treatment",
      status: "task-limit",
      gradeable: true,
      skillPaths: ["/skill"],
      timing: { durationMs: 1200 },
      usage: { inputTokens: 60, outputTokens: 8000 },
      cleanup: [],
    });
    await store.writeRecord(`${p1Dir}/treatment/validation.json`, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      outcome: { status: "graded", score: 0.1, fullPass: false, checks: [] },
    });

    // Pair 2: Partial infrastructure failure on treatment (ungradeable)
    const p2Id = `${runId}-r002`;
    const p2Dir = `pairs/${p2Id}`;
    await store.writeRecord(`${p2Dir}/baseline/condition.json`, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      conditionId: "baseline",
      status: "completed",
      gradeable: true,
      skillPaths: [],
      timing: { durationMs: 1000 },
      usage: { inputTokens: 50, outputTokens: 50 },
      cleanup: [],
    });
    await store.writeRecord(`${p2Dir}/baseline/validation.json`, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      outcome: { status: "graded", score: 0.9, fullPass: false, checks: [] },
    });
    await store.writeRecord(`${p2Dir}/treatment/condition.json`, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      conditionId: "treatment",
      status: "infrastructure-failure",
      gradeable: false,
      skillPaths: ["/skill"],
      timing: { durationMs: 200 },
      usage: null,
      cleanup: [],
    });
    await store.writeRecord(`${p2Dir}/treatment/validation.json`, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      outcome: null,
    });

    // Pair 3: planned but neither arm started.
    const p3Id = `${runId}-r003`;
    const p3Dir = `pairs/${p3Id}`;
    for (const conditionId of ["baseline", "treatment"] as const) {
      await store.writeRecord(`${p3Dir}/${conditionId}/condition.json`, {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        conditionId,
        status: "not-started",
        gradeable: false,
        skillPaths: conditionId === "baseline" ? [] : ["/skill"],
        timing: null,
        usage: null,
        cleanup: [{
          kind: "guest",
          name: `${p3Id}-${conditionId}`,
          status: "no-resource-journaled",
          verified: true,
        }],
      });
      await store.writeRecord(`${p3Dir}/${conditionId}/validation.json`, {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        outcome: null,
      });
    }

    await writeSyntheticPairRecord(store, p1Dir, p1Id, 1);
    await writeSyntheticPairRecord(store, p2Dir, p2Id, 2);
    await writeSyntheticPairRecord(store, p3Dir, p3Id, 3);
    const manifest = await store.sealManifest();
    const receiptPath = await store.sealReceipt({
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      runId,
      suiteId: "arbitrum-docs",
      caseSelector: "example-case",
      caseId: "example-case",
      mode: "fake",
      status: "partial",
      stopReason: "p2 infrastructure failure",
      testDouble: true,
      evidenceLabel: "TEST-DOUBLE EVIDENCE",
      createdAt: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
      planSha256: plan.planSha256,
      manifest: { treeSha256: manifest.tree.treeSha256, fileSha256: manifest.fileSha256 },
      pairs: [
        {
          pairId: p1Id,
          repetition: 1,
          path: `${p1Dir}/pair.json`,
          conditions: [
            { conditionId: "baseline", dir: `${p1Dir}/baseline` },
            { conditionId: "treatment", dir: `${p1Dir}/treatment` },
          ],
        },
        {
          pairId: p2Id,
          repetition: 2,
          path: `${p2Dir}/pair.json`,
          conditions: [
            { conditionId: "baseline", dir: `${p2Dir}/baseline` },
            { conditionId: "treatment", dir: `${p2Dir}/treatment` },
          ],
        },
        {
          pairId: p3Id,
          repetition: 3,
          path: `${p3Dir}/pair.json`,
          conditions: [
            { conditionId: "baseline", dir: `${p3Dir}/baseline` },
            { conditionId: "treatment", dir: `${p3Dir}/treatment` },
          ],
        },
      ],
      cleanup: [],
      failures: [{ code: "provider-error", failureClass: "infrastructure", message: "400 error", at: "treatment" }],
    });

    const report = await buildRunReport(receiptPath.path);

    // Pair 1 is valid (task-limit is gradeable): delta is 0.1 - 0.8 = -0.7
    // Pair 2 is invalid (infrastructure failure): delta is null
    expect(report.counts).toMatchObject({
      plannedPairs: 3,
      attemptedPairs: 2,
      notStartedPairs: 1,
      validPairs: 1,
    });
    expect(report.counts?.taskLimitCount).toBe(1);
    expect(report.counts?.infrastructureFailureCount).toBe(1);
    expect(report.summary?.baselineMean).toBe(0.8);
    expect(report.summary?.treatmentMean).toBe(0.1);
    expect(report.summary?.qualityDelta).toBeCloseTo(-0.7, 4);
    // Legacy/partial telemetry does not invent missing cache components as zero.
    expect(report.pairs[0]?.conditions[0]).toMatchObject({
      inputTokens: 50,
      outputTokens: 50,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      consumedTokens: null,
    });
    expect(report.pairs[0]?.consumedTokensDelta).toBeNull();

    // Table formats the numbers correctly
    const tableText = renderResultsTable(report);
    expect(tableText).toMatch(/0\.800\s+│\s+0\.100\s+│\s+-0\.700/);
    const text = formatRunReport(report);
    expect(text).toContain("3 planned / 2 attempted / 1 gradeable; 1 not started");
    expect(text).toContain("task-limit / NOT PASS");
    expect(text).toContain("not-started / ungraded");
    expect(text).toContain("Pair 2 excluded from averages:");
    expect(text).toContain("Pair 3 excluded from averages:");
    expect(text).toContain("[provider-error] 400 error");

    await rm(tempRoot, { recursive: true, force: true, maxRetries: 3 });
  });

  it("yields all n/a summary metrics when zero valid pairs exist", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "zero-valid-"));
    const runId = "zero-valid-run";
    const runDir = join(tempRoot, runId);
    const store = await createEvidenceStore({ runDir, guardedSecrets: [] });

    await store.writeRecord("inputs/target.json", {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      provider: "google",
      model: "scripted-model",
      thinking: "low",
      harnessId: "pi",
    });

    const plan = await writeSyntheticFrozenPlan(store, runId, 1);
    const pairId = `${runId}-r001`;
    const pDir = `pairs/${pairId}`;
    await store.writeRecord(`${pDir}/baseline/condition.json`, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      conditionId: "baseline",
      status: "infrastructure-failure",
      gradeable: false,
      skillPaths: [],
      timing: { durationMs: 100 },
      usage: null,
      cleanup: [],
    });
    await store.writeRecord(`${pDir}/baseline/validation.json`, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      outcome: null,
    });
    await store.writeRecord(`${pDir}/treatment/condition.json`, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      conditionId: "treatment",
      status: "infrastructure-failure",
      gradeable: false,
      skillPaths: ["/skill"],
      timing: { durationMs: 100 },
      usage: null,
      cleanup: [],
    });
    await store.writeRecord(`${pDir}/treatment/validation.json`, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      outcome: null,
    });

    await writeSyntheticPairRecord(store, pDir, pairId, 1);
    const manifest = await store.sealManifest();
    const receiptPath = await store.sealReceipt({
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      runId,
      suiteId: "arbitrum-docs",
      caseSelector: "example-case",
      caseId: "example-case",
      mode: "fake",
      status: "partial",
      stopReason: "infrastructure failure",
      testDouble: true,
      evidenceLabel: "TEST-DOUBLE EVIDENCE",
      createdAt: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
      planSha256: plan.planSha256,
      manifest: { treeSha256: manifest.tree.treeSha256, fileSha256: manifest.fileSha256 },
      pairs: [
        {
          pairId,
          repetition: 1,
          path: `${pDir}/pair.json`,
          conditions: [
            { conditionId: "baseline", dir: `${pDir}/baseline` },
            { conditionId: "treatment", dir: `${pDir}/treatment` },
          ],
        },
      ],
      cleanup: [],
      failures: [{ code: "provider-error", failureClass: "infrastructure", message: "fail", at: "pi" }],
    });

    const report = await buildRunReport(receiptPath.path);
    expect(report.counts?.validPairs).toBe(0);
    expect(report.summary?.baselineMean).toBeNull();
    expect(report.summary?.treatmentMean).toBeNull();
    expect(report.summary?.qualityDelta).toBeNull();
    expect(report.summary?.tokensDelta).toBeNull();
    expect(report.summary?.timeDeltaSeconds).toBeNull();

    // Table renders n/a for all metrics
    const table = renderResultsTable(report);
    expect(tableRows(table)[0]).toEqual(RESULT_COLUMNS);
    expect(tableRows(table)[1]).toEqual(["example-case", "pi", "google", "scripted-model", "n/a", "n/a", "n/a", "n/a", "n/a"]);
    const text = formatRunReport(report);
    expect(extractTables(text)).toHaveLength(1);
    expect(tableRows(extractTables(text)[0]!)[1]).toEqual([pairId, "example-case", "pi", "google", "scripted-model", "n/a", "n/a", "n/a", "n/a", "n/a"]);
    expect(text).not.toContain("Gradeable pairs:");
    expect(text).not.toContain("In averages:");
    expect(text).not.toContain("excluded from averages");
    expect(text).toContain("Pair 1 has no paired delta:");

    await rm(tempRoot, { recursive: true, force: true, maxRetries: 3 });
  });

  it("proves distinct stable outcomes for task-budget, provider error, and cancellation", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "distinct-outcomes-"));
    const workDir = join(tempRoot, "work");

    try {
      await writeOfflineSkill(tempRoot);
      // 1. Task budget stop
      const budgetHarness = createPiHarness({
        streamSimpleOverride: createScriptedStreamSimple([
          { type: "stop", stopReason: "length", text: "truncated" },
        ]),
      });
      const budgetResult = await runPairedEvaluation({
        evalsRoot: process.cwd(),
        repoRoot: tempRoot,
        caseSelector: "network-config-01",
        skillPath: "src/test-fixtures/skills/mcp-skill",
        mode: "fake",
        repetitions: 1,
        cliLimits: SAFE_DEFAULT_LIMITS,
        target: { provider: "google", model: "gemini-3.8-flash", thinking: "low" },
        runId: "budget-test-run",
        runsRoot: join(tempRoot, "runs"),
        resourceNonce: "abcd1234",
        createdAt: new Date().toISOString(),
        source: { revision: "test", dirty: false },
        evaluatorBuild: "test",
        harness: budgetHarness,
        sandbox: createFakeSandbox(),
        validatorRunner: createInProcessValidatorRunner(),
        workDir: `${workDir}-1`,
      });
      const budgetReport = await buildRunReport(budgetResult.receiptPath);
      expect(budgetReport.pairs[0]?.conditions[0]?.status, JSON.stringify(budgetResult.failures)).toBe("task-limit");

      // 2. Provider error
      const errorHarness = createPiHarness({
        streamSimpleOverride: createScriptedStreamSimple([
          { type: "error", errorMessage: "Thinking level MINIMAL is not supported (400)" },
        ]),
      });
      const errorResult = await runPairedEvaluation({
        evalsRoot: process.cwd(),
        repoRoot: tempRoot,
        caseSelector: "network-config-01",
        skillPath: "src/test-fixtures/skills/mcp-skill",
        mode: "fake",
        repetitions: 1,
        cliLimits: SAFE_DEFAULT_LIMITS,
        target: { provider: "google", model: "gemini-3.8-flash", thinking: "low" },
        runId: "error-test-run",
        runsRoot: join(tempRoot, "runs"),
        resourceNonce: "abcd1234",
        createdAt: new Date().toISOString(),
        source: { revision: "test", dirty: false },
        evaluatorBuild: "test",
        harness: errorHarness,
        sandbox: createFakeSandbox(),
        validatorRunner: createInProcessValidatorRunner(),
        workDir: `${workDir}-2`,
      });
      const errorReport = await buildRunReport(errorResult.receiptPath);
      expect(errorReport.pairs[0]?.conditions[0]?.status).toBe("infrastructure-failure");

      // 3. External cancellation
      const controller = new AbortController();
      controller.abort(new Error("caller cancelled"));
      const cancelResult = await runPairedEvaluation({
        evalsRoot: process.cwd(),
        repoRoot: tempRoot,
        caseSelector: "network-config-01",
        skillPath: "src/test-fixtures/skills/mcp-skill",
        mode: "fake",
        repetitions: 1,
        cliLimits: SAFE_DEFAULT_LIMITS,
        target: { provider: "google", model: "gemini-3.8-flash", thinking: "low" },
        runId: "cancel-test-run",
        runsRoot: join(tempRoot, "runs"),
        resourceNonce: "abcd1234",
        createdAt: new Date().toISOString(),
        source: { revision: "test", dirty: false },
        evaluatorBuild: "test",
        harness: createPiHarness({ streamSimpleOverride: createScriptedStreamSimple([{ type: "text", text: "ok" }]) }),
        sandbox: createFakeSandbox(),
        validatorRunner: createInProcessValidatorRunner(),
        workDir: `${workDir}-3`,
        signal: controller.signal,
      });
      expect(cancelResult.status).toBe("partial");
      expect(cancelResult.stopReason).toContain("caller cancelled");

    } finally {
      await disposeRunWorkDir(`${workDir}-1`).catch(() => undefined);
      await disposeRunWorkDir(`${workDir}-2`).catch(() => undefined);
      await disposeRunWorkDir(`${workDir}-3`).catch(() => undefined);
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
