/**
 * Read-model and verification proof.
 *
 * A report is only worth reading if it recomputed what it claims. These tests seal a real
 * run, prove `verifyRun` accepts it, then damage exactly one byte of exactly one evidence
 * file in a COPY and prove verification fails and names that file. They also prove the
 * read models refuse to surface a delta for an ungradeable pair, and that verification
 * itself mutates nothing.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildAllowlistedEnv } from "../test-guards.ts";
import { runIdFor, sha256Hex } from "../core/experiment.ts";
import type { PartialLimits } from "../core/types.ts";
import { EVIDENCE_SCHEMA_VERSION } from "../core/types.ts";
import { createEvidenceStore, isChainExcludedPath } from "./store.ts";
import { createFakeHarness } from "../harnesses/fake.ts";
import type { FakeHarnessScript } from "../harnesses/fake.ts";
import { createFakeSandbox } from "../sandboxes/fake.ts";
import { createInProcessValidatorRunner } from "../runner/validation.ts";
import { disposeRunWorkDir, runPairedEvaluation } from "../runner/run.ts";
import type { RunResult } from "../runner/run.ts";
import type { ConditionReport, PairReport, RunReport } from "./queries.ts";
import {
  buildRunReport,
  compareRunsChronologically,
  deriveSessionDurationMs,
  formatInspectResult,
  formatLatestRun,
  formatRunReport,
  inspectCondition,
  listRunHistory,
  parseRunTimestamp,
  readNativeSession,
  resolveLatestRun,
  verifyRun,
} from "./queries.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const evalsRoot = repoRoot;

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

async function sealRun(script?: FakeHarnessScript, repetitions: number = 1, cliLimits: PartialLimits = {}): Promise<RunResult> {
  const root = await mkdtemp(join(tmpdir(), "eval-query-test-"));
  tempRoots.push(root);
  const workDir = await mkdtemp(join(tmpdir(), "eval-query-work-"));
  workDirs.push(workDir);
  return runPairedEvaluation({
    evalsRoot,
    repoRoot,
    caseSelector: "network-config-01",
    skillPath: "src/test-fixtures/skills/mcp-skill",
    mode: "fake",
    repetitions,
    cliLimits,
    target: { provider: "google", model: "fake-model-0", thinking: "off" },
    runId: runIdFor(new Date(0), "abcdef12"),
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
  });
}

/** A byte-for-byte copy, so the original sealed run is never touched by a test. */
async function copyRun(runDir: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eval-query-copy-"));
  tempRoots.push(root);
  const copy = join(root, "run");
  await cp(runDir, copy, { recursive: true });
  return copy;
}

async function collectChainFiles(runDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string[]): Promise<void> => {
    const dir = rel.length === 0 ? runDir : join(runDir, ...rel);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relPath = [...rel, entry.name].join("/");
      if (isChainExcludedPath(relPath)) continue;
      if (entry.isDirectory()) await walk([...rel, entry.name]);
      else out.push(relPath);
    }
  };
  await walk([]);
  return out;
}

/**
 * Re-seals a real sealed run into a fresh directory, applying `mutate` to every
 * condition.json. Every other file (including inputs/plan.json and pair.json) is copied
 * byte-for-byte, so the frozen-plan population still verifies; only the manifest/receipt
 * hash bindings are recomputed. This lets a test model historical (schema-v1-style) or
 * refined sealed evidence WITHOUT weakening verification.
 */
async function resealConditions(
  runDir: string,
  mutate: (conditionDir: string, condition: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ runDir: string; receiptPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "eval-query-reseal-"));
  tempRoots.push(root);
  const dest = join(root, "run");
  const store = await createEvidenceStore({ runDir: dest });
  const originalReceipt = JSON.parse(await readFile(join(runDir, "receipt.json"), "utf8")) as Record<string, unknown>;
  for (const rel of await collectChainFiles(runDir)) {
    if (/^pairs\/[^/]+\/(baseline|treatment)\/condition\.json$/.test(rel)) {
      const parsed = JSON.parse(await readFile(join(runDir, rel), "utf8")) as Record<string, unknown>;
      await store.writeRecord(rel, mutate(dirname(rel), parsed));
    } else {
      await store.writeFile(rel, await readFile(join(runDir, rel)));
    }
  }
  const manifest = await store.sealManifest();
  const sealed = await store.sealReceipt({
    ...originalReceipt,
    manifest: { treeSha256: manifest.tree.treeSha256, fileSha256: manifest.fileSha256 },
  });
  return { runDir: dest, receiptPath: sealed.path };
}

describe("verifyRun", () => {
  it("accepts a sealed run and mutates nothing", async () => {
    const result = await sealRun();
    const before = await stat(join(result.runDir, "manifest.json"));
    const report = await verifyRun(result.runDir);

    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.extra).toEqual([]);
    expect(report.altered).toEqual([]);
    expect(report.recomputedTreeSha256).toBe(report.sealedTreeSha256);
    expect(report.receiptManifestSha256).toBe(report.sealedTreeSha256);
    expect(report.receiptManifestFileSha256).toBe(report.manifestFileSha256);
    expect(report.populationIntegrity).toEqual({ source: "frozen-plan", ordering: "verified" });

    const after = await stat(join(result.runDir, "manifest.json"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });

  it("fails and names the file when one byte of one evidence file is altered", async () => {
    const result = await sealRun();
    const copy = await copyRun(result.runDir);
    const target = join(copy, `pairs/${result.runId}-r001/treatment/candidate.json`);

    const original = await readFile(target);
    await chmod(target, 0o644);
    const mutated = Buffer.from(original);
    // Flip exactly one byte in the middle of the file.
    const index = Math.floor(mutated.length / 2);
    mutated[index] = (mutated[index] ?? 0) ^ 0x01;
    await writeFile(target, mutated);
    expect(sha256Hex(mutated)).not.toBe(sha256Hex(original));
    expect(mutated.length).toBe(original.length);

    const report = await verifyRun(copy);
    expect(report.ok).toBe(false);
    expect(report.altered).toEqual([`pairs/${result.runId}-r001/treatment/candidate.json`]);
    expect(report.failures.map((failure) => failure.message).join(" ")).toContain(
      `pairs/${result.runId}-r001/treatment/candidate.json`,
    );
    expect(report.recomputedTreeSha256).not.toBe(report.sealedTreeSha256);

    // The untouched original still verifies: the damage was local to the copy.
    expect((await verifyRun(result.runDir)).ok).toBe(true);
  });

  it("names a missing evidence file", async () => {
    const result = await sealRun();
    const copy = await copyRun(result.runDir);
    // Duplicate messages.json / tool-steps.json are replaced by canonical session.json
    const relative = `pairs/${result.runId}-r001/baseline/session.json`;
    await rm(join(copy, relative));

    const report = await verifyRun(copy);
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual([relative]);
  });

  it("names an unmanifested extra file", async () => {
    const result = await sealRun();
    const copy = await copyRun(result.runDir);
    await writeFile(join(copy, "inputs/smuggled.json"), "{}\n");

    const report = await verifyRun(copy);
    expect(report.ok).toBe(false);
    expect(report.extra).toEqual(["inputs/smuggled.json"]);
  });

  it("fails when manifest.json itself is altered, even though every chained file is intact", async () => {
    const result = await sealRun();
    const copy = await copyRun(result.runDir);
    const manifestPath = join(copy, "manifest.json");
    const original = await readFile(manifestPath, "utf8");
    await chmod(manifestPath, 0o644);
    // Still parses to exactly the same manifest tree: only the BYTES differ. The tree
    // comparison therefore cannot catch this, and only the receipt's fileSha256 binding
    // can, which is precisely the comparison under test.
    await writeFile(manifestPath, `${original}\n`);

    const report = await verifyRun(copy);
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual([]);
    expect(report.extra).toEqual([]);
    expect(report.altered).toEqual([]);
    expect(report.recomputedTreeSha256).toBe(report.sealedTreeSha256);
    expect(report.receiptManifestSha256).toBe(report.sealedTreeSha256);
    expect(report.manifestFileSha256).not.toBe(report.receiptManifestFileSha256);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.code).toBe("evidence-invalid");
    expect(report.failures[0]?.message).toContain("manifest.json file hash");
  });

  it("ignores views/, which are regenerable and outside the hash chain", async () => {
    const result = await sealRun();
    const copy = await copyRun(result.runDir);
    await writeFile(join(copy, "views/summary.txt"), "regenerated differently\n");
    expect((await verifyRun(copy)).ok).toBe(true);
  });

  it.each([
    ["mode", "measured"], ["testDouble", false], ["evidenceLabel", "MEASURED EVIDENCE"],
    ["caseId", "different-case"], ["runId", "different-run"], ["schemaVersion", 1],
  ])("rejects receipt-only %s identity or evidence-label edits", async (field, value) => {
    const run = await sealRun();
    const copy = await copyRun(run.runDir);
    const receiptPath = join(copy, "receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt[field as string] = value;
    await chmod(receiptPath, 0o644);
    await writeFile(receiptPath, JSON.stringify(receipt));
    const verification = await verifyRun(copy);
    expect(verification.ok).toBe(false);
    expect(verification.altered).toEqual([]);
    const report = await buildRunReport(receiptPath);
    expect(report.pairs).toEqual([]);
    expect(report.summary).toBeUndefined();
  });

  it.each([
    ["omitted", (pairs: unknown[]) => pairs.slice(0, 1)],
    ["duplicated", (pairs: unknown[]) => [pairs[0], pairs[0]]],
    ["extra", (pairs: unknown[]) => [...pairs, {
      pairId: "invented-r003",
      repetition: 3,
      path: "pairs/invented-r003/pair.json",
      conditions: [
        { conditionId: "baseline", dir: "pairs/invented-r003/baseline" },
        { conditionId: "treatment", dir: "pairs/invented-r003/treatment" },
      ],
    }]],
    ["reordered", (pairs: unknown[]) => [...pairs].reverse()],
    ["condition-aliased", (pairs: unknown[]) => {
      const altered = structuredClone(pairs) as Array<{ conditions: Array<{ dir: string }> }>;
      altered[0]!.conditions[1]!.dir = altered[0]!.conditions[0]!.dir;
      return altered;
    }],
  ])("rejects a receipt-only %s pair population and suppresses every numeric result", async (_attack, alter) => {
    const result = await sealRun(undefined, 2);
    const copy = await copyRun(result.runDir);
    const receiptPath = join(copy, "receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as { pairs: unknown[] };
    receipt.pairs = alter(receipt.pairs);
    await chmod(receiptPath, 0o644);
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);

    const verification = await verifyRun(copy);
    expect(verification.ok).toBe(false);
    expect(verification.missing).toEqual([]);
    expect(verification.extra).toEqual([]);
    expect(verification.altered).toEqual([]);
    expect(verification.failures.map((failure) => failure.message).join(" ")).toMatch(/receipt|pair population/);

    const report = await buildRunReport(receiptPath);
    expect(report.pairs).toEqual([]);
    expect(report.summary).toBeUndefined();
    const human = formatRunReport(report);
    expect(human).toContain("REFUSED");
    expect(human).not.toContain("┌─");
    expect(human).not.toContain("score=");
    const json = JSON.parse(formatRunReport(report, { format: "json" })) as {
      receipt: unknown;
      summary: unknown;
      pairs?: unknown;
    };
    expect(json.receipt).toBeNull();
    expect(json.summary).toBeNull();
    expect(json.pairs).toBeUndefined();
  });
});

describe("current-schema frozen-plan requirement", () => {
  it.each([false, true])("requires a frozen plan for nonempty population=%s", async (hasPairs) => {
    const root = await mkdtemp(join(tmpdir(), "planless-evidence-"));
    tempRoots.push(root);
    const store = await createEvidenceStore({ runDir: root });
    const conditions = ["baseline", "treatment"].map((conditionId) => ({ conditionId, dir: `pairs/p1/${conditionId}` }));
    if (hasPairs) {
      await store.writeRecord("pairs/p1/pair.json", { schemaVersion: EVIDENCE_SCHEMA_VERSION, pairId: "p1", repetition: 1, conditions });
      for (const condition of conditions) {
        await store.writeRecord(`${condition.dir}/condition.json`, { schemaVersion: EVIDENCE_SCHEMA_VERSION, conditionId: condition.conditionId, status: "completed", gradeable: true });
        await store.writeRecord(`${condition.dir}/validation.json`, { schemaVersion: EVIDENCE_SCHEMA_VERSION, outcome: { status: "graded", score: 1, fullPass: true, checks: [] } });
      }
    }
    await store.writeRecord("cleanup.json", { schemaVersion: EVIDENCE_SCHEMA_VERSION, sweep: [] });
    const manifest = await store.sealManifest();
    const receipt = await store.sealReceipt({
      schemaVersion: EVIDENCE_SCHEMA_VERSION, runId: "planless-current", suiteId: "synthetic", caseSelector: "case", caseId: "case", caseVersion: 1,
      mode: "fake", status: "partial", stopReason: "image unavailable before plan", testDouble: true, evidenceLabel: "TEST-DOUBLE EVIDENCE",
      createdAt: new Date(0).toISOString(), planSha256: "", manifest: { treeSha256: manifest.tree.treeSha256, fileSha256: manifest.fileSha256 },
      pairs: hasPairs ? [{ pairId: "p1", repetition: 1, path: "pairs/p1/pair.json", conditions }] : [], cleanup: [],
      failures: [{ code: "platform-unsupported", failureClass: "infrastructure", message: "synthetic image failure", at: "image" }],
    });
    const verification = await verifyRun(root);
    expect(verification.missing).toEqual([]);
    expect(verification.altered).toEqual([]);
    expect(verification.ok).toBe(!hasPairs);
    if (hasPairs) expect(verification.failures.some((failure) => failure.message.includes("manifest-bound inputs/plan.json"))).toBe(true);
    else expect(verification.populationIntegrity).toEqual({ source: "pre-plan-failure", ordering: "not-applicable-empty" });
    const report = await buildRunReport(receipt.path);
    expect(report.pairs).toEqual([]);
    expect(report.summary?.baselineMean ?? null).toBeNull();
    if (!hasPairs) {
      expect(report.elapsedWallTime).toBe("n/a");
      expect(report.target).toBeUndefined();
      expect(formatRunReport(report)).toContain("n/a (not recorded)");
    }
  });
});

describe("sealed stop-cause compatibility (schema v2, additive)", () => {
  it("maps a historical condition with no stopCause/providerStopReason to unknown/null without fabricating defaults", async () => {
    const run = await sealRun();
    // Model schema-v1 evidence sealed before the fields existed: simply omit them.
    const { receiptPath } = await resealConditions(run.runDir, (_dir, condition) => {
      const { stopCause: _s, providerStopReason: _p, ...rest } = condition;
      return rest;
    });

    const report = await buildRunReport(receiptPath);
    expect(report.verification.ok).toBe(true);
    // A finite/recorded budget is never retro-reinterpreted into a stop cause.
    for (const pair of report.pairs) {
      for (const condition of pair.conditions) {
        expect(condition.stopCause).toBe("unknown");
        expect(condition.providerStopReason).toBeNull();
      }
    }

    const details = formatRunReport(report, { details: true });
    expect(details).toContain("stopCause=unknown");
    expect(details).not.toContain("providerStop=");

    const json = JSON.parse(formatRunReport(report, { format: "json" })) as { pairs: Array<{ conditions: Array<{ stopCause: string; providerStopReason: unknown }> }> };
    const conditions = json.pairs.flatMap((pair) => pair.conditions);
    expect(conditions.length).toBeGreaterThan(0);
    expect(conditions.every((c) => c.stopCause === "unknown" && c.providerStopReason === null)).toBe(true);
  });

  it("distinguishes a harness cumulative-output cap from a provider-native length truncation in sealed evidence", async () => {
    const run = await sealRun();
    const { receiptPath } = await resealConditions(run.runDir, (conditionDir, condition) =>
      conditionDir.endsWith("/baseline")
        ? { ...condition, stopCause: "cumulative-output-tokens", providerStopReason: "MAX_TOKENS" }
        : { ...condition, stopCause: "provider-response-length", providerStopReason: "MAX_TOKENS" });

    const report = await buildRunReport(receiptPath);
    const pair = report.pairs[0]!;
    const baseline = pair.conditions.find((c) => c.conditionId === "baseline")!;
    const treatment = pair.conditions.find((c) => c.conditionId === "treatment")!;
    expect(baseline.stopCause).toBe("cumulative-output-tokens");
    expect(treatment.stopCause).toBe("provider-response-length");
    // The RAW provider reason is preserved verbatim alongside the structured cause.
    expect(baseline.providerStopReason).toBe("MAX_TOKENS");
    expect(treatment.providerStopReason).toBe("MAX_TOKENS");

    const details = formatRunReport(report, { details: true });
    expect(details).toContain("stopCause=cumulative-output-tokens providerStop=MAX_TOKENS");
    expect(details).toContain("stopCause=provider-response-length providerStop=MAX_TOKENS");

    const json = JSON.parse(formatRunReport(report, { format: "json" })) as { pairs: Array<{ conditions: Array<{ stopCause: string }> }> };
    expect(json.pairs[0]!.conditions.map((c) => c.stopCause).sort()).toEqual(["cumulative-output-tokens", "provider-response-length"]);
  });

  it("never passes through an unrecognized stopCause or coerces a non-string raw reason", async () => {
    const run = await sealRun();
    const { receiptPath } = await resealConditions(run.runDir, (_dir, condition) => ({
      ...condition,
      stopCause: "totally-made-up",
      providerStopReason: 123,
    }));

    const report = await buildRunReport(receiptPath);
    for (const pair of report.pairs) {
      for (const condition of pair.conditions) {
        expect(condition.stopCause).toBe("unknown");
        expect(condition.providerStopReason).toBeNull();
      }
    }
  });
});

describe("run report", () => {
  it.each(["table", "markdown"] as const)("groups pair resources by run_id after averages in %s", async (format) => {
    const result = await sealRun();
    const sealedReport = await buildRunReport(result.receiptPath);
    const template = sealedReport.pairs[0]!;
    const condition = (conditionId: "baseline" | "treatment", overrides: Partial<ConditionReport>): ConditionReport => ({
      ...template.conditions.find((entry) => entry.conditionId === conditionId)!,
      status: "completed",
      ...overrides,
    });
    const pair = (repetition: number, overrides: Partial<PairReport>): PairReport => ({
      ...template,
      pairId: `renderer-pair-${repetition}`,
      repetition,
      ...overrides,
    });
    // Rendering starts from the read model: cache tokens are already included in
    // consumedTokens. Distinct pair deltas catch accidentally reusing the mean row.
    const report: RunReport = {
      ...sealedReport,
      pairs: [
        pair(1, {
          conditions: [
            condition("baseline", { score: 0.2, fullPass: false, inputTokens: 100, outputTokens: 50, cacheReadTokens: 3_000, cacheWriteTokens: 50, consumedTokens: 3_200, durationMs: 5_000 }),
            condition("treatment", { score: 1, fullPass: true, inputTokens: 200, outputTokens: 100, cacheReadTokens: 1_000, cacheWriteTokens: 100, consumedTokens: 1_400, durationMs: 2_500 }),
          ],
          valid: true, baselineScore: 0.2, treatmentScore: 1,
          delta: { gradeable: true, delta: 0.8, reason: "both arms graded" },
          consumedTokensDelta: -1_800, timeDeltaSeconds: -2.5,
        }),
        pair(2, {
          conditions: [
            condition("baseline", { score: 0.8, fullPass: false, inputTokens: 100, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 100, consumedTokens: 500, durationMs: 1_000 }),
            condition("treatment", { score: 0.4, fullPass: false, inputTokens: 1_000, outputTokens: 300, cacheReadTokens: 1_400, cacheWriteTokens: 200, consumedTokens: 2_900, durationMs: 9_500 }),
          ],
          valid: true, baselineScore: 0.8, treatmentScore: 0.4,
          delta: { gradeable: true, delta: -0.4, reason: "both arms graded" },
          consumedTokensDelta: 2_400, timeDeltaSeconds: 8.5,
        }),
        pair(3, {
          conditions: (["baseline", "treatment"] as const).map((conditionId) => condition(conditionId, {
            score: 0.5, fullPass: false, inputTokens: null, outputTokens: null,
            cacheReadTokens: null, cacheWriteTokens: null, consumedTokens: null, durationMs: null,
          })),
          valid: true, baselineScore: 0.5, treatmentScore: 0.5,
          delta: { gradeable: true, delta: 0, reason: "both arms graded" },
          consumedTokensDelta: null, timeDeltaSeconds: null,
        }),
      ],
      summary: { baselineMean: 0.5, treatmentMean: 1.9 / 3, qualityDelta: 0.4 / 3, tokensDelta: 300, timeDeltaSeconds: 3 },
      counts: { plannedPairs: 3, attemptedPairs: 3, notStartedPairs: 0, validPairs: 3, tokenDenominator: 2, timeDenominator: 2, taskLimitCount: 0, infrastructureFailureCount: 0 },
    };
    const text = formatRunReport(report, { format });
    const delimiter = format === "markdown" ? "|" : "│";
    const rows = text.split("\n")
      .filter((line) => line.startsWith(delimiter))
      .map((line) => line.split(delimiter).slice(1, -1).map((cell) => cell.trim()))
      .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
    const headers = ["Case", "Harness", "Provider", "Model", "Baseline", "Treatment", "Delta", "Tokens Δ", "Time Δ"];
    const context = ["network-config-01", "fake", "google", "fake-model-0"];
    expect(rows).toEqual([
      headers, [...context, "0.500", "0.633", "+0.133", "+300", "+3.0s"],
      ["run_id", ...headers],
      ["renderer-pair-1", ...context, "0.200", "1.000", "+0.800", "-1,800", "-2.5s"],
      ["renderer-pair-2", ...context, "0.800", "0.400", "-0.400", "+2,400", "+8.5s"],
      ["renderer-pair-3", ...context, "0.500", "0.500", "0.000", "n/a", "n/a"],
    ]);
    const sectionPrefix = format === "markdown" ? "## " : "";
    expect(text.split("\n").filter((line) => /^(?:#{2,3} )?(?:Pair outcomes|Pair \d+|Averages)$/.test(line)))
      .toEqual([`${sectionPrefix}Averages`, `${sectionPrefix}Pair outcomes`]);
    expect(text).toContain("Gradeable pairs: 3");
    expect(text).toContain("Tokens Δ uses 2 pair(s); Time Δ uses 2 pair(s) with both measurements.");

    const json = JSON.parse(formatRunReport(report, { format: "json" }));
    expect(json.pairs).toEqual(report.pairs);
    expect(json.counts).toEqual(report.counts);
    expect(json.summary).toEqual({ baseline: 0.5, treatment: 1.9 / 3, delta: 0.4 / 3, tokensDelta: 300, timeDeltaSeconds: 3 });
  });

  it.each([300_000, 600_000, null])("reports the recorded arm limit %s without changing other budgets", async (wallClockMs) => {
    const result = await sealRun(undefined, 1, { wallClockMs, maxToolSteps: 17 });
    const report = await buildRunReport(result.receiptPath);
    expect(report.limits).toMatchObject({ wallClockMs, maxToolSteps: 17 });
    const timeLabel = wallClockMs === null ? "unlimited" : `${wallClockMs / 1000}s`;
    for (const format of ["table", "markdown"] as const) {
      const text = formatRunReport(report, { format });
      expect(text).toContain(`per arm: time=${timeLabel}`);
      expect(text).toContain("tool steps=17");
      expect(text).toContain(`${report.elapsedWallTime} wall time`);
    }
    const json = JSON.parse(formatRunReport(report, { format: "json" }));
    expect(json.limits.wallClockMs).toBe(wallClockMs);
    expect(json.elapsedWallTime).toBe(report.elapsedWallTime);
  });

  it("renders unlimited (null) output/tool/request budgets as 'unlimited', not 'n/a'", async () => {
    const result = await sealRun(undefined, 1, {
      wallClockMs: null,
      maxOutputTokens: null,
      maxToolSteps: null,
      maxProviderRequests: null,
    });
    const report = await buildRunReport(result.receiptPath);
    for (const format of ["table", "markdown"] as const) {
      const text = formatRunReport(report, { format });
      expect(text).toContain("time=unlimited");
      expect(text).toContain("output tokens=unlimited");
      expect(text).toContain("tool steps=unlimited");
      expect(text).toContain("provider requests=unlimited");
    }
    const json = JSON.parse(formatRunReport(report, { format: "json" }));
    expect(json.limits.maxOutputTokens).toBeNull();
    expect(json.limits.maxToolSteps).toBeNull();
    expect(json.limits.maxProviderRequests).toBeNull();
  });

  it("reports per-pair scores, gradeability, timing, usage, and a delta", async () => {
    const result = await sealRun();
    const report = await buildRunReport(result.receiptPath);

    expect(report.verification.ok).toBe(true);
    expect(report.mode).toBe("fake");
    expect(report.testDouble).toBe(true);
    expect(report.pairs).toHaveLength(1);

    const pair = report.pairs[0];
    expect(pair?.conditions.map((condition) => condition.conditionId)).toEqual(["baseline", "treatment"]);
    expect(pair?.conditions[0]?.skillPathCount).toBe(0);
    expect(pair?.conditions[1]?.skillPathCount).toBe(1);
    expect(pair?.conditions[0]?.checksTotal).toBe(18);
    expect(pair?.conditions.every((condition) => condition.gradeable)).toBe(true);
    expect(pair?.conditions.every((condition) => typeof condition.score === "number")).toBe(true);
    expect(pair?.conditions.every((condition) => condition.cleanupOutcomes.length === 2)).toBe(true);
    expect(pair?.delta.gradeable).toBe(true);
    expect(typeof pair?.delta.delta).toBe("number");

    const text = formatRunReport(report);
    expect(text.split("\n")[0]).toBe("network configuration migration");
    expect(text).not.toMatch(/^(mode|evidence|chain)\s+/m);
    expect(text).toContain("not a measured result");
    expect(text).not.toContain(`pair ${pair?.pairId} (repetition`);
    expect(text).not.toContain("score=");

    const detailed = formatRunReport(report, { details: true });
    expect(detailed).toContain(`pair ${pair?.pairId}`);
    expect(detailed).toMatch(/score=\d+\.\d{3}\b/);
    expect(detailed).toMatch(/delta\s+[+-]?\d+\.\d{3}\b/);
  });

  it("refuses to produce or print any score or delta over a broken hash chain", async () => {
    const result = await sealRun();
    const copy = await copyRun(result.runDir);
    const relative = `pairs/${result.runId}-r001/baseline/validation.json`;
    const target = join(copy, relative);
    const original = await readFile(target);
    await chmod(target, 0o644);
    const mutated = Buffer.from(original);
    const index = Math.floor(mutated.length / 2);
    mutated[index] = (mutated[index] ?? 0) ^ 0x01;
    await writeFile(target, mutated);

    const report = await buildRunReport(join(copy, "receipt.json"));
    expect(report.verification.ok).toBe(false);
    expect(report.verification.altered).toEqual([relative]);
    // The read model itself refuses; a caller cannot print what was never computed.
    expect(report.pairs).toEqual([]);

    const text = formatRunReport(report, { details: true });
    expect(text).toContain("verification FAILED");
    expect(text).toContain(relative);
    expect(text).toContain("REFUSED");
    expect(text).not.toContain("score=");
    expect(text).not.toMatch(/delta\s+[+-]?\d/);
  });

  it("refuses to print a number when either arm is ungradeable", async () => {
    const result = await sealRun((request) =>
      request.conditionId === "baseline"
        ? { outcome: "infrastructure-failure", assistantText: "guest died" }
        : { outcome: "completed", assistantText: "done" },
    );
    const report = await buildRunReport(result.receiptPath);
    const pair = report.pairs[0];

    expect(pair?.delta.gradeable).toBe(false);
    expect(pair?.delta.delta).toBeNull();
    expect(pair?.delta.reason).toContain("baseline");
    expect(pair?.conditions[0]?.score).toBeNull();

    const text = formatRunReport(report, { details: true });
    expect(text).toContain("score=n/a");
    expect(text).toContain("delta     none —");
    expect(text).not.toMatch(/delta\s+[+-]\d/);
  });

  it("omits report and inspect suggestions from automatic table and markdown output while preserving receipt and table commands", async () => {
    const result = await sealRun();
    const report = await buildRunReport(result.receiptPath);

    // Terminal table format
    const tableText = formatRunReport(report);
    expect(tableText).not.toMatch(/^report\s+/m);
    expect(tableText).not.toContain("--view candidate");
    expect(tableText).toMatch(/^receipt\s+/m);
    expect(tableText).toMatch(/^inspect\s+(pnpm eval:inspect .*--view session --export both|n\/a)/m);
    expect(tableText).not.toMatch(/^(mode|evidence|chain)\s+/m);

    // Markdown format
    const mdText = formatRunReport(report, { format: "markdown" });
    expect(mdText).not.toContain("- Report:");
    expect(mdText).not.toContain("--view candidate");
    expect(mdText).toContain("- Inspect/export:");
    expect(mdText).toContain("- **Receipt:**");

    // Structured JSON schema remains untouched
    const jsonText = formatRunReport(report, { format: "json" });
    const json = JSON.parse(jsonText);
    expect(json.commands.report).toContain("pnpm eval:report --receipt");
    expect(json.commands.inspect).toContain("pnpm eval:inspect --receipt");
    expect(json.commands.exportNative).toContain("--view session --export both");
    expect(json.commands.reproduceDryRun).toBeUndefined();
  });
});

describe("inspect", () => {
  it("shows every view of the treatment condition from sealed evidence", async () => {
    const result = await sealRun();
    for (const view of ["condition", "messages", "tools", "workspace", "candidate", "validation", "errors", "runtime", "session"] as const) {
      const inspected = await inspectCondition({
        receiptPath: result.receiptPath,
        conditionId: "treatment",
        view,
      });
      expect(inspected.verified).toBe(true);
      expect(inspected.conditionId).toBe("treatment");
      expect(inspected.content).toBeDefined();
      expect(formatInspectResult(inspected)).toContain("chain     VERIFIED");
    }
  });

  it("maps the condition view to the complete sealed condition.json record", async () => {
    const result = await sealRun();
    const inspected = await inspectCondition({
      receiptPath: result.receiptPath,
      conditionId: "treatment",
      view: "condition",
    });
    expect(inspected.file).toBe(`pairs/${result.runId}-r001/treatment/condition.json`);
    expect((inspected.content as { conditionId: string }).conditionId).toBe("treatment");
    expect(formatInspectResult(inspected)).toContain("condition.json");
  });

  it("executes --view condition through the real inspect CLI", async () => {
    const result = await sealRun();
    const inspectScript = resolve(repoRoot, "scripts/inspect.ts");
    const stdout = execFileSync(
      process.execPath,
      ["--experimental-strip-types", inspectScript, "--receipt", result.receiptPath, "--condition", "baseline", "--view", "condition"],
      { cwd: repoRoot, encoding: "utf8", env: buildAllowlistedEnv(tmpdir()) },
    );
    expect(stdout).toContain("view      condition");
    expect(stdout).toContain("condition.json");
    expect(stdout).toContain('"conditionId": "baseline"');
  });

  it("does not invent a header for older session records that contain only tree entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "headerless-session-"));
    tempRoots.push(root);
    const store = await createEvidenceStore({ runDir: root });
    const message = { type: "message", id: "old-entry", parentId: null, message: { role: "user", content: "old" } };
    await store.writeRecord("pairs/p1/baseline/session.json", {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      conditionId: "baseline",
      available: true,
      entries: [message],
    });

    const session = await readNativeSession(root, "pairs/p1/baseline");
    expect(session.available).toBe(true);
    expect(session.header).toBeNull();
    expect(session.treeEntries).toEqual([message]);
    expect(session.entries).toEqual([message]);
  });

  it("renders the treatment workspace as readable text, not base64", async () => {
    const result = await sealRun();
    const inspected = await inspectCondition({
      receiptPath: result.receiptPath,
      conditionId: "treatment",
      view: "workspace",
    });
    const text = formatInspectResult(inspected);
    expect(text).toContain("----- config.json -----");
    expect(text).toContain("treasury-console");
  });

  it("shows the runtime identity, including the exact guest and network destroyed", async () => {
    const result = await sealRun();
    const inspected = await inspectCondition({
      receiptPath: result.receiptPath,
      conditionId: "treatment",
      view: "runtime",
    });
    const content = inspected.content as {
      runtime: { skillPaths: string[]; testDouble: boolean };
      guestName: string;
      cleanup: Array<{ status: string; verified: boolean }>;
    };
    expect(content.runtime.skillPaths).toEqual(["/opt/skills/network-config-01"]);
    expect(content.runtime.testDouble).toBe(true);
    expect(content.guestName).toContain("-treatment-");
    expect(content.cleanup.every((entry) => entry.verified)).toBe(true);
  });

  it("rejects an unknown pair or condition rather than guessing", async () => {
    const result = await sealRun();
    await expect(
      inspectCondition({
        receiptPath: result.receiptPath,
        conditionId: "treatment",
        view: "messages",
        pairId: "no-such-pair",
      }),
    ).rejects.toMatchObject({ code: "input-invalid" });
  });

  it("executes the emitted inspection command against a synthetic receipt via the real inspect CLI", async () => {
    const result = await sealRun();
    const report = await buildRunReport(result.receiptPath);
    const reportText = formatRunReport(report);

    // Verify Task A: reportText no longer prints auto-suggested inspect or report lines
    expect(reportText).not.toContain("--view candidate");
    expect(reportText).not.toMatch(/^report\s+/m);
    expect(reportText).toMatch(/^receipt\s+/m);
    expect(reportText).toMatch(/^inspect\s+(pnpm eval:inspect .*--view session --export both|n\/a)/m);
    expect(reportText).not.toMatch(/^from\s+/m);

    // Verify structured JSON schema still exposes inspection commands
    const reportJson = JSON.parse(formatRunReport(report, { format: "json" }));
    expect(reportJson.commands.inspect).toContain("--condition treatment");
    expect(reportJson.commands.inspect).toContain("--view candidate");

    const cmdArgs = [
      "--receipt",
      report.receiptPath,
      "--pair",
      report.pairs[0]!.pairId,
      "--condition",
      "treatment",
      "--view",
      "candidate",
    ];

    const inspectScript = resolve(repoRoot, "scripts/inspect.ts");
    const stdout = execFileSync(
      process.execPath,
      ["--experimental-strip-types", inspectScript, ...cmdArgs],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: buildAllowlistedEnv(tmpdir()),
      },
    );

    expect(stdout).toContain("chain     VERIFIED");
    expect(stdout).toContain("candidate.json");
    // Universal reader resolves candidate bytes from workspace: assert actual synthetic content
    expect(stdout).toContain("treasury-console");
    expect(stdout).toContain("Ethereum Mainnet");
    expect(stdout).not.toContain("(referenced in workspace or omitted from capture)");
    expect(stdout).not.toContain("(ref: ");
  });

  it("renders binary candidate content appropriately in generated inspect command subprocess", async () => {
    const script: FakeHarnessScript = () => ({
      outcome: "completed",
      writes: [{ path: "config.json", text: "\x00\x01\x02\x03\x09\x0a" }],
    });

    const result = await sealRun(script);
    const report = await buildRunReport(result.receiptPath);
    const reportText = formatRunReport(report);

    expect(reportText).not.toContain("--view candidate");
    expect(reportText).not.toMatch(/^report\s+/m);

    const cmdArgs = [
      "--receipt",
      result.receiptPath,
      "--pair",
      report.pairs[0]!.pairId,
      "--condition",
      "treatment",
      "--view",
      "candidate",
    ];

    const inspectScript = resolve(repoRoot, "scripts/inspect.ts");
    const stdout = execFileSync(
      process.execPath,
      ["--experimental-strip-types", inspectScript, ...cmdArgs],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: buildAllowlistedEnv(tmpdir()),
      },
    );

    expect(stdout).toContain("chain     VERIFIED");
    expect(stdout).toContain("candidate.json");
    expect(stdout).toContain("[binary data: 6 bytes, hex: 00010203090a]");
    expect(stdout).not.toContain("(referenced in workspace or omitted from capture)");
  });

  it("renders empty candidate content appropriately in generated inspect command subprocess without missing placeholder", async () => {
    const script: FakeHarnessScript = () => ({
      outcome: "completed",
      writes: [{ path: "config.json", text: "" }],
    });

    const result = await sealRun(script);
    const report = await buildRunReport(result.receiptPath);
    const reportText = formatRunReport(report);

    expect(reportText).not.toContain("--view candidate");
    expect(reportText).not.toMatch(/^report\s+/m);

    const cmdArgs = [
      "--receipt",
      result.receiptPath,
      "--pair",
      report.pairs[0]!.pairId,
      "--condition",
      "treatment",
      "--view",
      "candidate",
    ];

    const inspectScript = resolve(repoRoot, "scripts/inspect.ts");
    const stdout = execFileSync(
      process.execPath,
      ["--experimental-strip-types", inspectScript, ...cmdArgs],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: buildAllowlistedEnv(tmpdir()),
      },
    );

    expect(stdout).toContain("chain     VERIFIED");
    expect(stdout).toContain("candidate.json");
    expect(stdout).toContain("----- config.json -----");
    expect(stdout).toContain("(empty file)");
    expect(stdout).not.toContain("(referenced in workspace or omitted from capture)");
    expect(stdout).not.toContain("(ref: ");
    expect(stdout).not.toContain("[MISSING / ABSENT]");
  });

  it("distinguishes resolved zero-byte candidate from absent workspace ref", () => {
    const inspected = {
      runId: "run-test",
      pairId: "pair-1",
      conditionId: "treatment" as const,
      view: "candidate" as const,
      file: "candidate.json",
      verified: true,
      content: {
        files: [
          {
            path: "empty.txt",
            base64: "",
            bytes: 0,
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            workspaceRef: "empty.txt",
            workspaceRefResolved: true,
            present: true,
          },
          {
            path: "missing-ref.txt",
            base64: "",
            bytes: 0,
            sha256: "",
            workspaceRef: "missing-ref.txt",
            workspaceRefResolved: false,
            present: true,
          },
        ],
      },
    };
    const rendered = formatInspectResult(inspected);
    expect(rendered).toContain("----- empty.txt -----\n(empty file)");
    expect(rendered).toContain("----- missing-ref.txt (ref: missing-ref.txt) -----\n(referenced in workspace or omitted from capture)");
  });

  it("supports explicit pair selection across multiple repetitions in inspect CLI", async () => {
    let callCount = 0;
    const script: FakeHarnessScript = (request) => {
      callCount += 1;
      return {
        outcome: "completed",
        writes: [
          {
            path: "config.json",
            text: JSON.stringify({ repetitionMarker: `call-${callCount}`, arm: request.conditionId }),
          },
        ],
      };
    };

    const result = await sealRun(script, 2);
    const report = await buildRunReport(result.receiptPath);
    expect(report.pairs).toHaveLength(2);
    const pair1Id = report.pairs[0]!.pairId;
    const pair2Id = report.pairs[1]!.pairId;

    const inspectScript = resolve(repoRoot, "scripts/inspect.ts");

    // Inspect pair-1 explicitly
    const stdoutPair1 = execFileSync(
      process.execPath,
      ["--experimental-strip-types", inspectScript, "--receipt", result.receiptPath, "--pair", pair1Id, "--condition", "treatment", "--view", "candidate"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: buildAllowlistedEnv(tmpdir()),
      },
    );
    expect(stdoutPair1).toContain(`pair      ${pair1Id}`);
    expect(stdoutPair1).toContain("call-2");

    // Inspect pair-2 explicitly
    const stdoutPair2 = execFileSync(
      process.execPath,
      ["--experimental-strip-types", inspectScript, "--receipt", result.receiptPath, "--pair", pair2Id, "--condition", "treatment", "--view", "candidate"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: buildAllowlistedEnv(tmpdir()),
      },
    );
    expect(stdoutPair2).toContain(`pair      ${pair2Id}`);
    expect(stdoutPair2).toContain("call-4");

    // Default inspection without --pair targets pair-1
    const stdoutDefault = execFileSync(
      process.execPath,
      ["--experimental-strip-types", inspectScript, "--receipt", result.receiptPath, "--condition", "treatment", "--view", "candidate"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: buildAllowlistedEnv(tmpdir()),
      },
    );
    expect(stdoutDefault).toContain(`pair      ${pair1Id}`);
    expect(stdoutDefault).toContain("call-2");
  });
});

async function sealCustomRun(options: {
  runsBaseDir: string;
  namespace: string;
  date: Date;
  nonce: string;
  caseSelector?: string;
  script?: FakeHarnessScript;
  repetitions?: number;
}): Promise<RunResult> {
  const workDir = await mkdtemp(join(tmpdir(), "eval-query-work-"));
  workDirs.push(workDir);
  const runsRoot = join(options.runsBaseDir, "eval-cases", "skill-a", options.namespace, "runs");
  return runPairedEvaluation({
    evalsRoot,
    repoRoot,
    caseSelector: options.caseSelector ?? "network-config-01",
    skillPath: "src/test-fixtures/skills/mcp-skill",
    mode: "fake",
    repetitions: options.repetitions ?? 1,
    cliLimits: {},
    target: { provider: "google", model: "fake-model-0", thinking: "off" },
    runId: runIdFor(options.date, options.nonce),
    resourceNonce: options.nonce,
    createdAt: options.date.toISOString(),
    source: { revision: "0".repeat(40), dirty: false },
    evaluatorBuild: "evals-src@test",
    harness: createFakeHarness(options.script === undefined ? {} : { script: options.script }),
    sandbox: createFakeSandbox(),
    validatorRunner: createInProcessValidatorRunner(),
    workDir,
    runsRoot,
    stateDir: join(options.runsBaseDir, ".state"),
  });
}

describe("latest run resolver", () => {
  it("parses run timestamps and orders entries chronologically with stable tiebreak", () => {
    const stamp1 = parseRunTimestamp("20260907T100000Z-aaaaaaaa");
    const stamp2 = parseRunTimestamp("20260907T123045Z-bbbbbbbb");
    expect(stamp1).toBe(Date.UTC(2026, 8, 7, 10, 0, 0));
    expect(stamp2).toBe(Date.UTC(2026, 8, 7, 12, 30, 45));
    expect(parseRunTimestamp("invalid-run-id")).toBeNull();

    const older = { runId: "20260907T100000Z-aaaaaaaa", namespace: "alpha" };
    const newer = { runId: "20260907T120000Z-bbbbbbbb", namespace: "zeta" };
    expect(compareRunsChronologically(older, newer)).toBeGreaterThan(0);
    expect(compareRunsChronologically(newer, older)).toBeLessThan(0);

    // Identical timestamp tiebreaks by runId descending
    const tie1 = { runId: "20260907T100000Z-aaaaaaaa", namespace: "ns" };
    const tie2 = { runId: "20260907T100000Z-bbbbbbbb", namespace: "ns" };
    expect(compareRunsChronologically(tie1, tie2)).toBeGreaterThan(0);
    expect(compareRunsChronologically(tie2, tie1)).toBeLessThan(0);
  });

  it("selects the newest run chronologically across namespaces even when alphabetical namespace ordering is inverted", async () => {
    const fakeEvalsRoot = await mkdtemp(join(tmpdir(), "eval-latest-order-"));
    tempRoots.push(fakeEvalsRoot);

    // Run A: in "alpha-ns", created at 10:00:00 (earlier)
    const runA = await sealCustomRun({
      runsBaseDir: fakeEvalsRoot,
      namespace: "alpha-ns",
      date: new Date("2026-09-07T10:00:00Z"),
      nonce: "aaaaaaaa",
    });

    // Run B: in "zeta-ns", created at 12:00:00 (later)
    const runB = await sealCustomRun({
      runsBaseDir: fakeEvalsRoot,
      namespace: "zeta-ns",
      date: new Date("2026-09-07T12:00:00Z"),
      nonce: "bbbbbbbb",
    });

    // Alphabetical enumeration visits "alpha-ns" first:
    const history = await listRunHistory(fakeEvalsRoot);
    expect(history[0]!.namespace).toBe("skill-a/alpha-ns");
    expect(history[0]!.runId).toBe(runA.runId);

    // resolveLatestRun MUST pick run B because 12:00:00 > 10:00:00
    const latest1 = await resolveLatestRun(fakeEvalsRoot);
    expect(latest1.runId).toBe(runB.runId);
    expect(latest1.namespace).toBe("skill-a/zeta-ns");

    // Add Run C in "alpha-ns" created at 14:00:00 (even later)
    const runC = await sealCustomRun({
      runsBaseDir: fakeEvalsRoot,
      namespace: "alpha-ns",
      date: new Date("2026-09-07T14:00:00Z"),
      nonce: "cccccccc",
    });

    const latest2 = await resolveLatestRun(fakeEvalsRoot);
    expect(latest2.runId).toBe(runC.runId);
    expect(latest2.namespace).toBe("skill-a/alpha-ns");
  });

  it("rejects an ambiguous newest run retained at canonical and historical paths", async () => {
    const fakeEvalsRoot = await mkdtemp(join(tmpdir(), "eval-latest-ambiguous-"));
    tempRoots.push(fakeEvalsRoot);

    const run = await sealCustomRun({
      runsBaseDir: fakeEvalsRoot,
      namespace: "canonical-ns",
      date: new Date("2026-09-07T12:00:00Z"),
      nonce: "aaaaaaaa",
    });
    const historicalRunDir = join(fakeEvalsRoot, "historical-ns", "runs", run.runId);
    await mkdir(dirname(historicalRunDir), { recursive: true });
    await cp(run.runDir, historicalRunDir, { recursive: true });

    const historicalReceiptPath = join(historicalRunDir, "receipt.json");
    await expect(resolveLatestRun(fakeEvalsRoot)).rejects.toMatchObject({
      code: "evidence-invalid",
      message: expect.stringContaining(`the latest run ${run.runId} is ambiguous`),
    });
    await expect(resolveLatestRun(fakeEvalsRoot)).rejects.toMatchObject({
      message: expect.stringContaining(run.receiptPath),
    });
    await expect(resolveLatestRun(fakeEvalsRoot)).rejects.toMatchObject({
      message: expect.stringContaining(historicalReceiptPath),
    });
  });

  it("filters latest run correctly by case selector", async () => {
    const fakeEvalsRoot = await mkdtemp(join(tmpdir(), "eval-latest-case-"));
    tempRoots.push(fakeEvalsRoot);

    const run1 = await sealCustomRun({
      runsBaseDir: fakeEvalsRoot,
      namespace: "ns-1",
      date: new Date("2026-09-07T10:00:00Z"),
      nonce: "11111111",
      caseSelector: "network-config-01",
    });

    const run2 = await sealCustomRun({
      runsBaseDir: fakeEvalsRoot,
      namespace: "ns-2",
      date: new Date("2026-09-07T12:00:00Z"),
      nonce: "22222222",
      caseSelector: "network-config-01",
    });

    // Selecting by short case id
    const resolvedShort = await resolveLatestRun(fakeEvalsRoot, { caseSelector: "network-config-01" });
    expect(resolvedShort.runId).toBe(run2.runId);

    // Selecting by full case selector
    const resolvedFull = await resolveLatestRun(fakeEvalsRoot, { caseSelector: "chain-info/network-config-01" });
    expect(resolvedFull.runId).toBe(run2.runId);
  });

  it("surfaces clear and distinct errors for no-matching-run", async () => {
    const fakeEvalsRoot = await mkdtemp(join(tmpdir(), "eval-latest-missing-"));
    tempRoots.push(fakeEvalsRoot);

    // Root with zero runs
    await expect(resolveLatestRun(fakeEvalsRoot)).rejects.toMatchObject({
      code: "input-invalid",
      message: "no matching run found",
    });

    // Root with runs but none matching case
    await sealCustomRun({
      runsBaseDir: fakeEvalsRoot,
      namespace: "ns-1",
      date: new Date("2026-09-07T10:00:00Z"),
      nonce: "11111111",
      caseSelector: "network-config-01",
    });

    await expect(resolveLatestRun(fakeEvalsRoot, { caseSelector: "nonexistent-case" })).rejects.toMatchObject({
      code: "input-invalid",
      message: 'no matching run found for case "nonexistent-case"',
    });
  });

  it("surfaces incomplete latest run and never falls back to an older verified run", async () => {
    const fakeEvalsRoot = await mkdtemp(join(tmpdir(), "eval-latest-incomplete-"));
    tempRoots.push(fakeEvalsRoot);

    // Older verified run
    const olderRun = await sealCustomRun({
      runsBaseDir: fakeEvalsRoot,
      namespace: "ns-1",
      date: new Date("2026-09-07T10:00:00Z"),
      nonce: "11111111",
    });

    // Newer incomplete run (directory exists with timestamp 12:00:00 but no receipt.json)
    const incompleteRunId = "20260907T120000Z-incomplete";
    const incompleteRunDir = join(fakeEvalsRoot, "eval-cases", "skill-a", "ns-1", "runs", incompleteRunId);
    await mkdir(incompleteRunDir, { recursive: true });

    // resolveLatestRun MUST surface the incomplete run rather than falling back to olderRun
    await expect(resolveLatestRun(fakeEvalsRoot)).rejects.toMatchObject({
      code: "evidence-invalid",
      message: expect.stringContaining(`the latest run ${incompleteRunId} is incomplete`),
    });
  });

  it("surfaces corrupt latest run and never falls back to an older verified run", async () => {
    const fakeEvalsRoot = await mkdtemp(join(tmpdir(), "eval-latest-corrupt-"));
    tempRoots.push(fakeEvalsRoot);

    // Older verified run
    const olderRun = await sealCustomRun({
      runsBaseDir: fakeEvalsRoot,
      namespace: "ns-1",
      date: new Date("2026-09-07T10:00:00Z"),
      nonce: "11111111",
    });

    // Newer run that is corrupt (tampered byte in validation.json)
    const newerRun = await sealCustomRun({
      runsBaseDir: fakeEvalsRoot,
      namespace: "ns-1",
      date: new Date("2026-09-07T12:00:00Z"),
      nonce: "22222222",
    });

    const target = join(newerRun.runDir, `pairs/${newerRun.runId}-r001/baseline/validation.json`);
    const original = await readFile(target);
    await chmod(target, 0o644);
    const mutated = Buffer.from(original);
    mutated[0] = (mutated[0] ?? 0) ^ 0x01;
    await writeFile(target, mutated);

    // resolveLatestRun MUST surface the corrupt run rather than falling back to olderRun
    await expect(resolveLatestRun(fakeEvalsRoot)).rejects.toMatchObject({
      code: "evidence-invalid",
      message: expect.stringContaining(`the latest run ${newerRun.runId} is corrupt`),
    });
  });

  it("formats latest run output in table and json formats with all required metadata", async () => {
    const fakeEvalsRoot = await mkdtemp(join(tmpdir(), "eval-latest-fmt-"));
    tempRoots.push(fakeEvalsRoot);

    const run = await sealCustomRun({
      runsBaseDir: fakeEvalsRoot,
      namespace: "test-ns",
      date: new Date("2026-09-07T10:00:00Z"),
      nonce: "12345678",
      repetitions: 2,
    });

    const resolved = await resolveLatestRun(fakeEvalsRoot);
    expect(resolved.pairs).toHaveLength(2);
    expect(resolved.pairs[0]!.repetition).toBe(1);
    expect(resolved.pairs[1]!.repetition).toBe(2);

    const tableText = formatLatestRun(resolved, "table");
    expect(tableText).toContain(`run       ${run.runId}`);
    expect(tableText).toContain(`receipt   ${run.receiptPath}`);
    expect(tableText).toContain(`case      ${resolved.caseSelector}`);
    expect(tableText).toContain(`skill     ${resolved.skill}`);
    expect(tableText).toContain(`status    ${resolved.status}`);
    expect(tableText).toContain(`evidence  ${resolved.evidenceLabel}`);
    expect(tableText).toContain(`- ${resolved.pairs[0]!.pairId} (repetition 1)`);
    expect(tableText).toContain(`- ${resolved.pairs[1]!.pairId} (repetition 2)`);

    const jsonText = formatLatestRun(resolved, "json");
    const json = JSON.parse(jsonText);
    expect(json.schemaVersion).toBe(1);
    expect(json.runId).toBe(run.runId);
    expect(json.receiptPath).toBe(run.receiptPath);
    expect(json.caseSelector).toBe(resolved.caseSelector);
    expect(json.skill).toBe(resolved.skill);
    expect(json.status).toBe(resolved.status);
    expect(json.evidenceLabel).toBe(resolved.evidenceLabel);
    expect(json.pairs).toHaveLength(2);
  });

  it("rejects --latest combined with --receipt in inspect and history CLIs", () => {
    const inspectScript = resolve(repoRoot, "scripts/inspect.ts");
    const historyScript = resolve(repoRoot, "scripts/history.ts");

    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          inspectScript,
          "--latest",
          "--receipt",
          "dummy/receipt.json",
          "--condition",
          "treatment",
          "--view",
          "candidate",
        ],
        { cwd: repoRoot, encoding: "utf8", env: buildAllowlistedEnv(tmpdir()) },
      ),
    ).toThrow(/--latest cannot be combined with --receipt/);

    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          historyScript,
          "--latest",
          "--receipt",
          "dummy/receipt.json",
        ],
        { cwd: repoRoot, encoding: "utf8", env: buildAllowlistedEnv(tmpdir()) },
      ),
    ).toThrow(/--latest cannot be combined with --receipt/);
  });

  describe("isolated synthetic case CLI execution", () => {
    const nonce = randomBytes(4).toString("hex");
    const syntheticCase = `query-latest-${nonce}`;
    const syntheticDir = join(evalsRoot, "eval-cases", "arbitrum-docs", syntheticCase);
    const syntheticStateDir = join(tmpdir(), `eval-latest-state-${nonce}`);
    const cleanupExit = (): void => {
      rmSync(syntheticDir, { recursive: true, force: true });
      rmSync(syntheticStateDir, { recursive: true, force: true });
    };

    beforeAll(async () => {
      process.once("exit", cleanupExit);
      try {
        await mkdir(syntheticDir, { recursive: true });
        await cp(join(evalsRoot, "eval-cases", "arbitrum-docs", "network-config-01", "fixture"), join(syntheticDir, "fixture"), { recursive: true });
        await cp(join(evalsRoot, "eval-cases", "arbitrum-docs", "network-config-01", "oracle.json"), join(syntheticDir, "oracle.json"));
        await cp(join(evalsRoot, "eval-cases", "arbitrum-docs", "network-config-01", "validator.ts"), join(syntheticDir, "validator.ts"));
        const caseConfig = JSON.parse(await readFile(join(evalsRoot, "eval-cases", "arbitrum-docs", "network-config-01", "case.json"), "utf8")) as Record<string, unknown>;
        caseConfig.id = syntheticCase;
        await writeFile(join(syntheticDir, "case.json"), JSON.stringify(caseConfig, null, 2), "utf8");

        const workDir = await mkdtemp(join(tmpdir(), "eval-latest-work-"));
        workDirs.push(workDir);
        await runPairedEvaluation({
          evalsRoot,
          repoRoot,
          caseSelector: syntheticCase,
          skillPath: "src/test-fixtures/skills/mcp-skill",
          mode: "fake",
          repetitions: 1,
          cliLimits: {},
          target: { provider: "google", model: "fake-model-0", thinking: "off" },
          runId: runIdFor(new Date(1000), nonce),
          resourceNonce: nonce,
          createdAt: new Date(1000).toISOString(),
          source: { revision: "0".repeat(40), dirty: false },
          evaluatorBuild: "evals-src@test",
          harness: createFakeHarness(),
          sandbox: createFakeSandbox(),
          validatorRunner: createInProcessValidatorRunner(),
          workDir,
          runsRoot: join(syntheticDir, "runs"),
          stateDir: syntheticStateDir,
        });
      } catch (error) {
        process.removeListener("exit", cleanupExit);
        await rm(syntheticDir, { recursive: true, force: true });
        await rm(syntheticStateDir, { recursive: true, force: true });
        throw error;
      }
    });

    afterAll(async () => {
      process.removeListener("exit", cleanupExit);
      await rm(syntheticDir, { recursive: true, force: true });
      await rm(syntheticStateDir, { recursive: true, force: true });
    });

    it("inspects latest run with first-pair default and visible run and pair IDs in output", () => {
      const inspectScript = resolve(repoRoot, "scripts/inspect.ts");

      // Inspect with --latest, omitting --pair (defaults to first pair)
      const stdout = execFileSync(
        process.execPath,
        ["--experimental-strip-types", inspectScript, "--latest", "--case", syntheticCase, "--condition", "treatment", "--view", "candidate"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: buildAllowlistedEnv(tmpdir()),
        },
      );

      // Resolved run ID and pair ID must be visible in output
      expect(stdout).toMatch(/^run\s+\S+/m);
      expect(stdout).toMatch(/^pair\s+\S+-r001\b/m);
      expect(stdout).toContain("condition treatment");
      expect(stdout).toContain("view      candidate");
      expect(stdout).toContain("chain     VERIFIED");
    });

    it("executes eval:history --latest against retained runs", () => {
      const historyScript = resolve(repoRoot, "scripts/history.ts");

      const stdoutTable = execFileSync(
        process.execPath,
        ["--experimental-strip-types", historyScript, "--latest", "--case", syntheticCase],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: buildAllowlistedEnv(tmpdir()),
        },
      );

      expect(stdoutTable).toMatch(/^run\s+/m);
      expect(stdoutTable).toMatch(/^receipt\s+/m);
      expect(stdoutTable).toMatch(/^case\s+/m);
      expect(stdoutTable).toMatch(/^skill\s+/m);
      expect(stdoutTable).toMatch(/^status\s+/m);
      expect(stdoutTable).toMatch(/^evidence\s+/m);
      expect(stdoutTable).toMatch(/^pairs/m);

      const stdoutJson = execFileSync(
        process.execPath,
        ["--experimental-strip-types", historyScript, "--latest", "--case", syntheticCase, "--format", "json"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: buildAllowlistedEnv(tmpdir()),
        },
      );

      const parsed = JSON.parse(stdoutJson);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.runId).toBeDefined();
      expect(parsed.receiptPath).toBeDefined();
      expect(parsed.pairs).toBeInstanceOf(Array);
    });
  });
});

describe("session-derived latency", () => {
  it("measures from the first user prompt to the last recorded message", () => {
    expect(deriveSessionDurationMs([
      { type: "session", timestamp: "2026-09-19T20:36:05.842Z" },
      { type: "message", timestamp: "2026-09-19T20:36:06.000Z", message: { role: "assistant" } },
      { type: "message", timestamp: "2026-09-19T20:36:10.000Z", message: { role: "user" } },
      { type: "message", timestamp: "2026-09-19T20:37:00.500Z", message: { role: "assistant" } },
      { type: "model_change", timestamp: "2026-09-19T21:00:00.000Z" },
    ])).toBe(50_500);
  });

  it("falls back to message timestamps and returns null without evidence", () => {
    expect(deriveSessionDurationMs([
      { type: "message", message: { role: "user", timestamp: 1_000 } },
      { type: "message", message: { role: "assistant", timestamp: 4_500 } },
    ])).toBe(3_500);
    expect(deriveSessionDurationMs([])).toBeNull();
    expect(deriveSessionDurationMs([{ type: "message", message: { role: "assistant", timestamp: 1 } }])).toBeNull();
  });
});
