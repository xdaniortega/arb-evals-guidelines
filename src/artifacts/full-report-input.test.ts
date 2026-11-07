/**
 * Adapter-level tests of the full-report input: legacy and zero-pair branches, dynamic rubrics
 * (unequal weights, mixed topics, fail-closed outcome checks), score-change wording, missing
 * arms and session-derived latency. Runs are sealed with the fake harness/sandbox only.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runIdFor } from "../core/experiment.ts";
import { createFakeHarness } from "../harnesses/fake.ts";
import { createFakeSandbox } from "../sandboxes/fake.ts";
import { createInProcessValidatorRunner } from "../runner/validation.ts";
import { disposeRunWorkDir, runPairedEvaluation } from "../runner/run.ts";
import type { Rubric, RubricScore } from "../runner/rubric.ts";
import { renderFullReport } from "./full-report.ts";
import { buildFullReportInput, buildProvenance, caseDocUrl, renderFullReportForRun, scoreExplanation } from "./full-report-input.ts";
import { buildRunReport } from "./queries.ts";
import type { ConditionReport, PairReport, RunReport } from "./queries.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_URL = "https://github.com/example/evals";
const ctx = (report: RunReport) => ({
  repoUrl: REPO_URL,
  runDir: `eval-cases/${report.caseId}/runs/${report.runId}`,
  summaryRefusal: null,
});
const tempRoots: string[] = [];
const workDirs: string[] = [];

afterAll(async () => {
  for (const dir of workDirs) await disposeRunWorkDir(dir).catch(() => {});
  for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function sealed(repetitions = 1): Promise<{ receiptPath: string; report: RunReport }> {
  const root = await mkdtemp(join(tmpdir(), "eval-full-report-input-"));
  tempRoots.push(root);
  const workDir = await mkdtemp(join(tmpdir(), "eval-full-report-input-work-"));
  workDirs.push(workDir);
  const result = await runPairedEvaluation({
    evalsRoot: repoRoot,
    repoRoot,
    caseSelector: "network-config-01",
    skillPath: "src/test-fixtures/skills/mcp-skill",
    mode: "fake",
    repetitions,
    cliLimits: {},
    target: { provider: "google", model: "fake-model-0", thinking: "off" },
    runId: runIdFor(new Date(0), "abcdef12"),
    resourceNonce: "0a1b2c3d",
    createdAt: new Date(0).toISOString(),
    source: { revision: "0".repeat(40), dirty: false },
    evaluatorBuild: "evals-src@test",
    harness: createFakeHarness({}),
    sandbox: createFakeSandbox(),
    validatorRunner: createInProcessValidatorRunner(),
    workDir,
    runsRoot: join(root, "runs"),
    stateDir: join(root, ".state"),
  });
  return { receiptPath: result.receiptPath, report: await buildRunReport(result.receiptPath) };
}

const arm = (pair: PairReport, id: "baseline" | "treatment"): ConditionReport => pair.conditions.find((c) => c.conditionId === id)!;
const withCondition = (pair: PairReport, id: "baseline" | "treatment", patch: Partial<ConditionReport>): PairReport => ({
  ...pair,
  conditions: pair.conditions.map((c) => (c.conditionId === id ? { ...c, ...patch } : c)),
});

describe("buildFullReportInput: legacy and empty runs", () => {
  it("renders a legacy report with original scalar scores and no v0.2 decomposition", async () => {
    const { receiptPath, report } = await sealed(2);
    const legacy: RunReport = { ...report, isLegacy: true, scored: null, rubricVersion: undefined };
    const input = await buildFullReportInput(receiptPath, legacy, ctx(legacy));
    expect(input.aggregate.mode).toBe("legacy");
    expect(input.legacyLabel).toMatch(/^LEGACY RESULT/);
    expect(input.pairs.map((p) => p.pairId)).toEqual(report.pairs.map((p) => p.pairId));
    for (const [index, pair] of report.pairs.entries()) {
      const rendered = input.pairs[index]!;
      for (const id of ["baseline", "treatment"] as const) {
        const score = arm(pair, id).score;
        expect(score).not.toBeNull();
        expect(rendered[id].scoreCell).toBe(`${score!.toFixed(3)} (original scale)`);
      }
      expect(rendered.composition).toBeNull();
      expect(rendered.outcome).toBeNull();
      expect(rendered.costLatency.length).toBeGreaterThan(0);
    }
    const text = await renderFullReportForRun(receiptPath, legacy, ctx(legacy));
    expect(text).toContain("> **Warning:** LEGACY RESULT");
    expect(text).toContain("scored under an earlier rubric");
    for (const pair of report.pairs) expect(text).toContain(`Pair ID: \`${pair.pairId}\``);
    expect(text).not.toMatch(/Outcome total|Score total|img\.shields|percentage point|\| Metric \| Baseline \| Treatment \| Change \|/);
    expect(text).toContain("Score composition is not available for this run");
    expect(text).toContain("| Rubric version | n/a (not recorded) |");
    expect(text).toContain("Not available: this run has no scored view of a frozen rubric v0.2.");
  });

  it("keeps a run with no recorded pair honest", async () => {
    const { receiptPath, report } = await sealed();
    const empty: RunReport = { ...report, pairs: [], scored: null, counts: undefined };
    const text = await renderFullReportForRun(receiptPath, empty, ctx(empty));
    expect(text).toContain("| Pairs | none recorded |");
    expect(text).toContain("No pairs were recorded for this run");
    expect(text).toContain("| Repetitions | 0 |");
    expect(text).not.toContain("<details>");
    expect(text).not.toContain("r001");
    expect(text).toContain("No pairs were recorded for this run, so there are no results to aggregate.");
    expect(text).toContain("No executions were recorded.");
    expect(text).toContain("No pairs were recorded for this run.\n");
    expect(text).toContain("Not available: no aggregate exists for this run.");
  });

  it("says legacy pairs are not graded under rubric v0.2 and never that they are graded", async () => {
    const { receiptPath, report } = await sealed();
    const legacy: RunReport = { ...report, isLegacy: true, scored: null };
    const text = await renderFullReportForRun(receiptPath, legacy, ctx(legacy));
    expect(text).toContain("This pair was scored under an earlier rubric and is not graded under rubric v0.2");
    expect(text).not.toMatch(/The pair is graded|All pairs are graded/);
  });

  it("renders Elapsed as bare n/a when the wall time is not recorded", async () => {
    const { receiptPath, report } = await sealed();
    const notRecorded: RunReport = { ...report, elapsedWallTime: "n/a" };
    const text = await renderFullReportForRun(receiptPath, notRecorded, ctx(notRecorded));
    expect(text).toContain("| Elapsed | n/a |");
    expect(text).not.toContain("n/a wall time");
    const recorded: RunReport = { ...report, elapsedWallTime: "1m 05s" };
    expect(await renderFullReportForRun(receiptPath, recorded, ctx(recorded))).toContain("| Elapsed | 1m 05s wall time |");
  });

  it("uses the planned repetition count, falling back to the recorded pair count", async () => {
    const { receiptPath, report } = await sealed();
    const counts = report.counts!;
    const interrupted: RunReport = { ...report, counts: { ...counts, plannedPairs: 3 } };
    const text = await renderFullReportForRun(receiptPath, interrupted, ctx(interrupted));
    expect(text).toContain("| Repetitions | 3 |");
    expect(text).toContain("--repetitions 3");
    const unplanned: RunReport = { ...report, counts: undefined };
    const fallback = await renderFullReportForRun(receiptPath, unplanned, ctx(unplanned));
    expect(fallback).toContain("| Repetitions | 1 |");
    expect(fallback).toContain("--repetitions 1");
  });

  it("has no Eval case column and renders no badge", async () => {
    const { receiptPath, report } = await sealed();
    const text = await renderFullReportForRun(receiptPath, report, ctx(report));
    expect(text).not.toContain("Eval case");
    expect(text).not.toMatch(/AF-Evaluation|img\.shields\.io/);
  });

  it("renders the bare refusal reason once", async () => {
    const { receiptPath, report } = await sealed();
    const text = await renderFullReportForRun(receiptPath, report, {
      ...ctx(report),
      summaryRefusal: "pair r002 has ungraded arm(s): baseline",
    });
    expect(text).toContain("> EVALS.md was not generated: pair r002 has ungraded arm(s): baseline.\n");
  });
});

describe("buildFullReportInput: dynamic rubric", () => {
  const rubric: Rubric = {
    rubricVersion: "v0.2",
    checks: [
      { id: "a1", group: "outcome", points: 10, topic: "T1" },
      { id: "a2", group: "outcome", points: 20, topic: "T1" },
      { id: "m1", group: "outcome", points: 15, topic: "Tm" },
      { id: "m2", group: "constraints", points: 5, topic: "Tm" },
      { id: "u1", group: "outcome", points: 35 },
      { id: "c1", group: "constraints", points: 15 },
    ],
    topics: [
      { id: "T1", label: "Alpha topic", points: 30 },
      { id: "Tm", label: "Mixed topic", points: 20 },
    ],
  };

  const scoreWith = (base: RubricScore, outcomeGot: number, topics: RubricScore["topics"]): RubricScore => ({
    ...base,
    groups: { ...base.groups, outcome: { got: outcomeGot, max: 80 } },
    topics,
  });

  async function withRubric(custom: Rubric, outcomeGot: number, topicGot: number): Promise<{ receiptPath: string; report: RunReport }> {
    const { receiptPath, report } = await sealed();
    const pair = report.pairs[0]!;
    const patchArm = (id: "baseline" | "treatment"): Partial<ConditionReport> => ({
      rubricScore: scoreWith(arm(pair, id).rubricScore!, outcomeGot, [{ id: "T1", label: "Alpha topic", got: topicGot, max: 30 }]),
    });
    const patched = withCondition(withCondition(pair, "baseline", patchArm("baseline")), "treatment", patchArm("treatment"));
    return { receiptPath, report: { ...report, pairs: [patched], scored: { ...report.scored!, rubric: custom } } };
  }

  it("projects unequal weights, a mixed topic and ungrouped checks from the frozen rubric", async () => {
    const { receiptPath, report } = await withRubric(rubric, 12, 12);
    const input = await buildFullReportInput(receiptPath, report, ctx(report));
    expect(input.task.outcomeMax).toBe(80);
    expect(input.task.constraintsMax).toBe(20);
    expect(input.task.checks).toEqual([
      { id: "a1", group: "outcome", topic: "Alpha topic", points: 10 },
      { id: "a2", group: "outcome", topic: "Alpha topic", points: 20 },
      { id: "m1", group: "outcome", topic: "Mixed topic", points: 15 },
      { id: "m2", group: "constraints", topic: "Mixed topic", points: 5 },
      { id: "u1", group: "outcome", topic: "", points: 35 },
      { id: "c1", group: "constraints", topic: "", points: 15 },
    ]);
    // Pure topic -> one row; mixed topic -> its individual outcome checks; ungrouped follow. No fixed topic count.
    const outcome = input.pairs[0]!.outcome!;
    expect(outcome.unavailable).toBeNull();
    expect(outcome.rows.map((r) => r.label)).toEqual(["Alpha topic", "m1", "u1", "Outcome total"]);
    expect(outcome.rows[0]).toMatchObject({ baseline: "12/30", treatment: "12/30" });
    // Checks without verified per-check results stay unavailable rather than zero.
    expect(outcome.rows[1]).toMatchObject({ baseline: "n/a", treatment: "n/a" });
    expect(outcome.rows[3]).toMatchObject({ label: "Outcome total", baseline: "12/80", treatment: "12/80", bold: true });
    const text = renderFullReport(input);
    expect(text).toContain("outcome points (up to 80) plus constraints and preservation points (up to 20)");
    expect(text).toContain("| m2 | constraints | Mixed topic | 5 |");
    expect(text).toContain("| c1 | constraints |  | 15 |");
  });

  it("fails closed with an explicit message when check rows disagree with the sealed Outcome total", async () => {
    const pure: Rubric = {
      rubricVersion: "v0.2",
      checks: [
        { id: "a1", group: "outcome", points: 80, topic: "T1" },
        { id: "c1", group: "constraints", points: 20 },
      ],
      topics: [{ id: "T1", label: "Alpha topic", points: 80 }],
    };
    const { receiptPath, report } = await withRubric(pure, 12, 10);
    const input = await buildFullReportInput(receiptPath, report, ctx(report));
    const outcome = input.pairs[0]!.outcome!;
    expect(outcome.rows).toEqual([]);
    expect(outcome.unavailable).toBe("outcome checks (10) do not agree with the sealed baseline Outcome total (12)");
    expect(renderFullReport(input)).toContain("Outcome Checks are unavailable: outcome checks (10) do not agree with the sealed baseline Outcome total (12).");
  });
});

describe("buildFullReportInput: arms and latency", () => {
  it("lists a pair with a missing arm with unavailable cells", async () => {
    const { receiptPath, report } = await sealed();
    const pair = report.pairs[0]!;
    const lone: RunReport = { ...report, pairs: [{ ...pair, conditions: [arm(pair, "baseline")], valid: false }] };
    const input = await buildFullReportInput(receiptPath, lone, ctx(lone));
    const rendered = input.pairs[0]!;
    expect(rendered.treatment).toEqual({ phrase: "missing", graded: false, scoreCell: "n/a" });
    expect(rendered.baseline.graded).toBe(true);
    expect(rendered.resourcesRecorded).toBe(false);
    expect(rendered.comparisonNote).toBe(pair.delta.reason);
    const text = renderFullReport(input);
    expect(text).toContain("Treatment: missing, grading unavailable");
    expect(text).toMatch(/\| \[r001\]\(#r001\) \| [^|]+ \| n\/a \| [^|]+ \| Missing \(not graded\) \|/);
  });

  it("labels session-derived latency and counts it as recorded", async () => {
    const { receiptPath, report } = await sealed();
    const pair = withCondition(
      withCondition(report.pairs[0]!, "baseline", { durationMs: null, sessionDurationMs: 7_000, consumedTokens: 100 }),
      "treatment",
      { durationMs: 5_000, sessionDurationMs: null, consumedTokens: 50 },
    );
    const derived: RunReport = { ...report, pairs: [pair] };
    const input = await buildFullReportInput(receiptPath, derived, ctx(derived));
    const rendered = input.pairs[0]!;
    expect(rendered.resourcesRecorded).toBe(true);
    expect(rendered.costLatency).toEqual([
      { label: "Total recorded tokens, including cached input", baseline: "100", treatment: "50" },
      { label: "Time to completion or termination (ms)", baseline: "7,000 ms (session-derived)", treatment: "5,000 ms" },
    ]);
  });
});

describe("scoreExplanation", () => {
  const acc = (baseline: string, treatment: string, changeRaw: number | null) => ({ baseline, treatment, changeRaw });

  it("explains an increase in percentage points", () => {
    expect(scoreExplanation(acc("20%", "69%", 49), true)).toContain(
      "**+49%**, meaning an increase of **49 percentage points** (69% − 20%). This is the arithmetic score difference, not relative percentage growth.",
    );
  });

  it("explains a decrease", () => {
    const text = scoreExplanation(acc("50%", "38%", -12), true);
    expect(text).toContain("**−12%**, meaning a decrease of **12 percentage points** (38% − 50%)");
  });

  it("keeps one decimal for a fractional change and uses the singular for one point", () => {
    expect(scoreExplanation(acc("50%", "52.5%", 2.5), true)).toContain("**+2.5%**, meaning an increase of **2.5 percentage points**");
    const one = scoreExplanation(acc("50%", "51%", 1), true);
    expect(one).toContain("an increase of **1 percentage point** (51% − 50%)");
    expect(one).not.toContain("1 percentage points");
  });

  it("states zero, unavailable and incomplete-grading cases without a delta", () => {
    expect(scoreExplanation(acc("20%", "20%", 0), true)).toContain("**0%**, meaning **0 percentage points**");
    expect(scoreExplanation(acc("n/a", "20%", null), true)).toBe("The Score change is unavailable because an arm has no verified Score.");
    const incomplete = scoreExplanation(acc("20%", "40%", 20), false);
    expect(incomplete).toContain("not shown because grading is incomplete");
    expect(incomplete).not.toContain("percentage points");
  });
});

describe("caseDocUrl", () => {
  const caseReport = async (caseId = "case-x"): Promise<{ report: RunReport; caseDir: string }> => {
    const root = await mkdtemp(join(tmpdir(), "eval-case-doc-"));
    tempRoots.push(root);
    const caseDir = join(root, caseId);
    const runDir = join(caseDir, "runs", "run-1");
    await mkdir(runDir, { recursive: true });
    return { report: { caseId: "case-x", runDir } as RunReport, caseDir };
  };

  it("links a regular README.md", async () => {
    const { report, caseDir } = await caseReport();
    await writeFile(join(caseDir, "README.md"), "doc\n");
    expect(await caseDocUrl(report, REPO_URL)).toBe(`${REPO_URL}/blob/HEAD/eval-cases/case-x/README.md`);
  });

  it("returns null when the README is absent", async () => {
    const { report } = await caseReport();
    expect(await caseDocUrl(report, REPO_URL)).toBeNull();
  });

  it("returns null when the README is a symlink", async () => {
    const { report, caseDir } = await caseReport();
    await writeFile(join(caseDir, "real.md"), "doc\n");
    await symlink(join(caseDir, "real.md"), join(caseDir, "README.md"));
    expect(await caseDocUrl(report, REPO_URL)).toBeNull();
  });

  it("returns null when the case folder name does not match the case id", async () => {
    const { report, caseDir } = await caseReport("other-case");
    await writeFile(join(caseDir, "README.md"), "doc\n");
    expect(await caseDocUrl(report, REPO_URL)).toBeNull();
  });
});

describe("buildProvenance", () => {
  const field = (rows: readonly (readonly [string, string])[], key: string): string => rows.find(([k]) => k === key)![1];
  const condition = (imageDigest: string | null) => ({ imageDigest }) as unknown as ConditionReport;

  it("falls back to n/a (not recorded) for every missing field", () => {
    const rows = buildProvenance({ pairs: [], limits: undefined } as unknown as RunReport);
    for (const key of ["Evaluator source revision", "Evaluator build", "Image digest(s)", "Skill snapshot tree sha256", "SKILL.md sha256", "Provider", "Model", "Thinking level"]) {
      expect(field(rows, key)).toBe("n/a (not recorded)");
    }
    expect(field(rows, "Repetitions")).toBe("0");
    expect(field(rows, "Elapsed")).toBe("n/a (not recorded)");
  });

  it("deduplicates image digests, sorts them and skips null digests", () => {
    const pairs = [
      { conditions: [condition("sha256:bbb"), condition(null)] },
      { conditions: [condition("sha256:aaa"), condition("sha256:bbb")] },
    ] as unknown as PairReport[];
    const rows = buildProvenance({ pairs } as unknown as RunReport);
    expect(field(rows, "Image digest(s)")).toBe("sha256:aaa, sha256:bbb");
  });

  it("annotates the source revision with the working-tree state", () => {
    const dirty = buildProvenance({ pairs: [], source: { revision: "abc", dirty: true } } as unknown as RunReport);
    const clean = buildProvenance({ pairs: [], source: { revision: "abc", dirty: false } } as unknown as RunReport);
    const unknown = buildProvenance({ pairs: [], source: { revision: "abc" } } as unknown as RunReport);
    expect(field(dirty, "Evaluator source revision")).toBe("abc (dirty working tree)");
    expect(field(clean, "Evaluator source revision")).toBe("abc (clean)");
    expect(field(unknown, "Evaluator source revision")).toBe("abc");
  });
});
