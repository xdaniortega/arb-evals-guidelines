import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scoreWithRubric } from "../runner/rubric.ts";
import type { Rubric, RubricScore } from "../runner/rubric.ts";
import {
  buildScoredReport,
  formatDuration,
  formatDurationDiff,
  formatSignedAccuracyDiff,
  formatTokenDiff,
  formatTokens,
  renderScoredJson,
  renderScoredMarkdown,
  formatSummaryScoreChange,
  renderScoredSummaryMarkdown,
  OUTCOME_CHECKS_HEADING,
  renderScoredTerminal,
  REPORT_JSON_SCHEMA_VERSION,
} from "./scored-report.ts";
import { attachConditionCheckResults, formatRunReport } from "./queries.ts";
import { buildSummaryDocument, buildSummaryEntry, projectOutcomeChecks } from "./summary-entry.ts";
import type { SummaryDocument } from "./scored-report.ts";
import type { ConditionReport, PairReport, RunReport, VerifyRunReport } from "./queries.ts";

const TOPICS = [
  { id: "chain-identity", label: "Correct network identities" },
  { id: "legacy-fallback", label: "Legacy RPC fallback configuration" },
  { id: "rpc-endpoints", label: "Public RPC and explorer endpoints" },
  { id: "sequencer-policy", label: "Sequencer routing and submission policy" },
  { id: "token-identity", label: "WETH and USDC token identities" },
  { id: "bridge-addresses", label: "Canonical bridge addresses" },
  { id: "bridge-onboarding", label: "Bridge onboarding configuration" },
  { id: "finality-policy", label: "Withdrawal finality and force-inclusion settings" },
] as const;

const MOCK_RUBRIC: Rubric = {
  rubricVersion: "v0.2",
  checks: [
    ...TOPICS.flatMap((t) => [
      { id: `p-${t.id}`, group: "outcome" as const, topic: t.id, points: 5 },
      { id: `s-${t.id}`, group: "outcome" as const, topic: t.id, points: 5 },
    ]),
    { id: "json-shape", group: "constraints", points: 10 },
    { id: "preservation", group: "constraints", points: 10 },
  ],
  topics: TOPICS.map((t) => ({ ...t, points: 10 })),
};

function mockScore(outcome: number, constraints: number, topicGot: number): RubricScore {
  return {
    rubricVersion: "v0.2",
    groups: { outcome: { got: outcome, max: 80 }, constraints: { got: constraints, max: 20 } },
    topics: TOPICS.map((t) => ({ ...t, got: topicGot, max: 10 })),
    accuracyTotal: outcome + constraints,
    score: (outcome + constraints) / 100,
    fullPass: outcome + constraints === 100,
  };
}

const VERIFIED_OK: VerifyRunReport = {
  ok: true,
  runDir: "/tmp/fake-run",
  receiptManifestSha256: "0".repeat(64),
  sealedTreeSha256: "0".repeat(64),
  recomputedTreeSha256: "0".repeat(64),
  manifestFileSha256: "0".repeat(64),
  receiptManifestFileSha256: "0".repeat(64),
  missing: [],
  extra: [],
  altered: [],
  populationIntegrity: { source: "frozen-plan", ordering: "verified" },
  failures: [],
};

function createConditionReport(
  conditionId: "baseline" | "treatment",
  overrides: Partial<ConditionReport> = {},
): ConditionReport {
  return {
    conditionId,
    status: "completed",
    gradeable: true,
    score: 0.2,
    fullPass: false,
    checksPassed: 2,
    checksTotal: 18,
    durationMs: 12_345,
    providerRequests: 1,
    toolSteps: 2,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 100,
    cacheWriteTokens: 50,
    consumedTokens: 1650,
    redactions: 0,
    redactionLocations: [],
    skillPathCount: conditionId === "treatment" ? 1 : 0,
    imageDigest: "sha256:abc",
    cleanupOutcomes: ["guest:p1=destroyed (verified)"],
    nativeSessionAvailable: false,
    stopCause: "completed",
    providerStopReason: null,
    rubricScore: conditionId === "baseline" ? mockScore(0, 20, 0) : mockScore(80, 20, 10),
    sessionDurationMs: null,
    ...overrides,
  };
}

function pairOf(baseline: ConditionReport | null, treatment: ConditionReport | null): PairReport {
  const conditions = [baseline, treatment].filter((c): c is ConditionReport => c !== null);
  const valid = baseline?.score != null && treatment?.score != null;
  return {
    pairId: "run-001-r001",
    repetition: 1,
    conditions,
    valid,
    delta: valid
      ? { gradeable: true, delta: treatment!.score! - baseline!.score!, reason: "both arms gradeable" }
      : { gradeable: false, delta: null, reason: "an arm is not gradeable" },
    baselineScore: baseline?.score ?? null,
    treatmentScore: treatment?.score ?? null,
    consumedTokensDelta: null,
    timeDeltaSeconds: null,
  };
}

function createRunReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    runId: "run-001",
    suiteId: "suite-001",
    caseSelector: "network-config-01",
    caseId: "network-config-01",
    mode: "fake",
    status: "completed",
    stopReason: null,
    testDouble: true,
    evidenceLabel: "TEST-DOUBLE EVIDENCE — synthetic scores, not a measured result",
    receiptPath: "/tmp/fake-run/receipt.json",
    runDir: "/tmp/fake-run",
    verification: VERIFIED_OK,
    pairs: [pairOf(createConditionReport("baseline"), createConditionReport("treatment", { score: 1, fullPass: true }))],
    target: { provider: "google", model: "fake-model-0", thinking: "off" },
    harnessId: "pi",
    counts: {
      plannedPairs: 1,
      attemptedPairs: 1,
      notStartedPairs: 0,
      validPairs: 1,
      tokenDenominator: 1,
      timeDenominator: 1,
      taskLimitCount: 0,
      infrastructureFailureCount: 0,
    },
    elapsedWallTime: "28.0s",
    isLegacy: false,
    rubricVersion: "v0.2",
    skillSourcePath: "skills/arbitrum-docs",
    failures: [],
    ...overrides,
  };
}

const withPair = (baseline: ConditionReport | null, treatment: ConditionReport | null, overrides: Partial<RunReport> = {}) =>
  createRunReport({ pairs: [pairOf(baseline, treatment)], ...overrides });

describe("Scored report model & renderers (rubric v0.2)", () => {
  it("terminal, Markdown and JSON show the same sections, labels and numbers", () => {
    const report = withPair(
      createConditionReport("baseline", { consumedTokens: 10_000, durationMs: 12_345 }),
      createConditionReport("treatment", { score: 1, fullPass: true, consumedTokens: 15_000, durationMs: 213_947 }),
    );
    const model = buildScoredReport(report, MOCK_RUBRIC);
    const md = renderScoredMarkdown(model, { checks: true });
    const term = renderScoredTerminal(model, { checks: true });
    const json = JSON.parse(formatRunReport({ ...report, scored: model }, { format: "json" }));

    expect(model.statusLine).toBe("Completed; graded");
    expect(md).toContain("Run: run-001 · Pair r001  \n");
    expect(term).toContain("Run:    run-001 · Pair r001\n");

    // Pillars
    expect(md).toContain("| Accuracy | 20% | 100% | +80 percentage points |");
    expect(md).toContain("| Cost: recorded tokens | 10,000 | 15,000 | +5,000 (+50.0%) |");
    expect(md).toContain("| Latency | 12,345 ms | 213,947 ms | +201,602 ms (+1633.1%) |");
    expect(term).toMatch(/│ Accuracy\s+│\s+20%\s+│\s+100%\s+│\s+\+80 percentage points\s+│/);

    // Accuracy: exactly two rows + total, no unhappy row
    expect(md).toContain("| Outcome correctness and completeness | 0/80 — 0% | 80/80 — 100% |");
    expect(md).toContain("| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |");
    expect(md).toContain("| **Accuracy total** | **20/100 — 20%** | **100/100 — 100%** |");
    expect(model.accuracyTable.rows).toHaveLength(2);
    expect(md).not.toMatch(/unhappy/i);
    expect(term).not.toMatch(/unhappy/i);
    expect(term).toContain("Outcome correctness and completeness");
    expect(term).toMatch(/├─+┼─+┼─+┤\n│ Accuracy total/);

    // Accuracy Outcome Checks
    expect(md).toContain("### Accuracy Outcome Checks");
    expect(md).toContain("| **Outcome total** | **0/80** | **80/80** |");
    expect(term).toContain("Accuracy Outcome Checks (each check covers both production and staging):");
    expect(term).toContain("Outcome total");

    // Cost and latency
    expect(md).toContain("| Time to completion or termination (ms) | 12,345 ms | 213,947 ms |");
    expect(term).toContain("213,947 ms");

    // JSON
    expect(json.schemaVersion).toBe(3);
    expect(json.scored.rubricVersion).toBe("v0.2");
    expect(json.scored.groups.outcome).toMatchObject({ label: "Outcome correctness and completeness", points: 80, baselineGot: 0, treatmentGot: 80 });
    expect(json.scored.groups.constraints).toMatchObject({ points: 20, baselineGot: 20, treatmentGot: 20 });
    expect(json.scored.groups).not.toHaveProperty("unhappy");
    expect(json.scored.accuracy).toEqual({ baseline: 20, treatment: 100, changePercentagePoints: 80 });
    expect(json.scored.latency.treatmentPrecise).toBe("213,947 ms");
    expect(json.scored.topics.find((t: { id: string }) => t.id === "chain-identity")).toEqual({
      id: "chain-identity",
      label: "Correct network identities",
      points: 10,
      baseline: "0/10",
      treatment: "10/10",
      baselineGot: 0,
      treatmentGot: 10,
    });
  });

  it("--checks toggles the outcome checks table; --details is independent", () => {
    const report = createRunReport();
    const model = buildScoredReport(report, MOCK_RUBRIC);
    expect(renderScoredMarkdown(model)).not.toContain("### Accuracy Outcome Checks");
    expect(renderScoredTerminal(model)).not.toContain("Accuracy Outcome Checks");

    const withDetails = formatRunReport({ ...report, scored: model }, { format: "markdown", details: true });
    expect(withDetails).not.toContain("### Accuracy Outcome Checks");
    expect(withDetails).toContain("## Operational details");
    const both = formatRunReport({ ...report, scored: model }, { format: "markdown", details: true, checks: true });
    expect(both).toContain("### Accuracy Outcome Checks");
    expect(both).toContain("## Operational details");
  });

  it("formats durations, signed diffs, accuracy in percentage points and token deltas", () => {
    expect(formatDuration(45_213)).toBe("45.2s");
    expect(formatDuration(45_213, { precise: true })).toBe("45.213s");
    expect(formatDuration(213_947)).toBe("3m34s");
    expect(formatDuration(213_947, { precise: true })).toBe("3m33.947s");
    expect(formatDuration(300_155)).toBe("5m00s");
    expect(formatDuration(300_155, { precise: true })).toBe("5m00.155s");
    expect(formatDuration(2_959_239)).toBe("49m19s");
    expect(formatDuration(2_959_239, { precise: true })).toBe("49m19.239s");
    expect(formatDuration(3_730_000)).toBe("1h02m10s");
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(null)).toBe("n/a");

    expect(formatDurationDiff(10_000, 15_000)).toBe("+5,000 ms (+50.0%)");
    expect(formatDurationDiff(2_959_239, 214_000)).toBe("−2,745,239 ms (−92.8%)");
    expect(formatDurationDiff(2_959_239, 214_000, { approximate: true })).toBe("−2,745,239 ms (−92.8%, approximate)");
    expect(formatDurationDiff(10_000, 10_000)).toBe("0 ms (0.0%)");
    expect(formatDurationDiff(0, 5_000)).toBe("+5,000 ms (n/a)");
    expect(formatDurationDiff(null, 5_000)).toBe("n/a");

    expect(formatSignedAccuracyDiff(60)).toBe("+60 percentage points");
    expect(formatSignedAccuracyDiff(-20)).toBe("−20 percentage points");
    expect(formatSignedAccuracyDiff(0)).toBe("0 percentage points");
    expect(formatSignedAccuracyDiff(null)).toBe("n/a");

    expect(formatTokens(12_345)).toBe("12,345");
    expect(formatTokens(null)).toBe("n/a");
    expect(formatTokenDiff(479_496, 569_516)).toBe("+90,020 (+18.8%)");
    expect(formatTokenDiff(2000, 1000)).toBe("−1,000 (−50.0%)");
    expect(formatTokenDiff(1000, 1000)).toBe("0 (0.0%)");
    expect(formatTokenDiff(0, 500)).toBe("+500 (n/a)");
  });

  it("a graded task-limit arm appears in the accuracy and outcome checks tables", () => {
    const baseline = createConditionReport("baseline", {
      status: "task-limit",
      stopCause: "wall-clock",
      score: 0.3,
      durationMs: 300_155,
      rubricScore: mockScore(10, 20, 0),
    });
    const model = buildScoredReport(withPair(baseline, createConditionReport("treatment", { score: 1 })), MOCK_RUBRIC);
    expect(model.statusLine).toBe("Without this skill: task limit reached, graded · With this skill: completed, graded");
    expect(model.accuracyTable.rows[0]!.baseline).toBe("10/80 — 13%");
    expect(model.accuracyTable.totalRow.baseline).toBe("**30/100 — 30%**");
    expect(model.checksTable!.rows[0]!.baseline).toBe("0/10");
    expect(model.checksTable!.totalRow.baseline).toBe("**10/80**");
    expect(model.pillars.latency.baseline).toBe("300,155 ms");
    expect(renderScoredMarkdown(model)).toContain(
      "Status: Without this skill: task limit reached, graded · With this skill: completed, graded\n",
    );
  });

  it("an interrupted, ungraded arm shows n/a everywhere and session-derived latency", () => {
    const baseline = createConditionReport("baseline", {
      status: "infrastructure-failure",
      stopCause: "external-cancellation",
      gradeable: false,
      score: null,
      fullPass: null,
      rubricScore: null,
      consumedTokens: 479_496,
      durationMs: null,
      sessionDurationMs: 2_959_239,
    });
    const treatment = createConditionReport("treatment", { score: 0.8, consumedTokens: 569_516, durationMs: 214_000, rubricScore: mockScore(60, 20, 5) });
    const model = buildScoredReport(withPair(baseline, treatment), MOCK_RUBRIC);

    expect(model.statusLine).toBe("Without this skill: interrupted, grading unavailable · With this skill: completed, graded");
    expect(model.pillars.accuracy.baseline).toBe("n/a");
    expect(model.pillars.accuracy.change).toBe("n/a");
    expect(model.pillars.cost.change).toBe("+90,020 (+18.8%)");
    expect(model.pillars.latency.baseline).toBe("2,959,239 ms (session-derived)");
    expect(model.pillars.latency.change).toBe("−2,745,239 ms (−92.8%, approximate)");
    expect(model.costLatencyTable.rows[1]!.baseline).toBe("2,959,239 ms (session-derived)");
    for (const row of [...model.accuracyTable.rows, ...model.checksTable!.rows]) expect(row.baseline).toBe("n/a");
    expect(model.accuracyTable.totalRow.baseline).toBe("**n/a**");
    expect(model.accuracyTable.rows[0]!.treatment).toBe("60/80 — 75%");

    const json = renderScoredJson(model) as { latency: { baselineSessionDerived: boolean; approximate: boolean } };
    expect(json.latency.baselineSessionDerived).toBe(true);
    expect(json.latency.approximate).toBe(true);
  });

  it("without session evidence the latency of an interrupted arm is n/a, never fabricated", () => {
    const baseline = createConditionReport("baseline", {
      status: "infrastructure-failure",
      stopCause: "external-cancellation",
      gradeable: false,
      score: null,
      rubricScore: null,
      durationMs: null,
      sessionDurationMs: null,
    });
    const model = buildScoredReport(withPair(baseline, createConditionReport("treatment")), MOCK_RUBRIC);
    expect(model.pillars.latency.baseline).toBe("n/a");
    expect(model.pillars.latency.change).toBe("n/a");
  });

  it("summarizes equal arm states in one phrase and handles a missing arm", () => {
    const interrupted = (id: "baseline" | "treatment") => createConditionReport(id, {
      status: "infrastructure-failure", stopCause: "external-cancellation", gradeable: false, score: null, rubricScore: null,
    });
    expect(buildScoredReport(withPair(interrupted("baseline"), interrupted("treatment")), MOCK_RUBRIC).statusLine)
      .toBe("Interrupted; grading unavailable");
    expect(buildScoredReport(withPair(null, createConditionReport("treatment")), MOCK_RUBRIC).statusLine)
      .toBe("Without this skill: missing, grading unavailable · With this skill: completed, graded");
  });

  it("a legacy run (non-v0.2 frozen rubric) keeps the original scalar score and is never reweighted", () => {
    const report = withPair(
      createConditionReport("baseline", { score: 0.111, rubricScore: null }),
      createConditionReport("treatment", { score: 0.778, rubricScore: null }),
      { isLegacy: true, rubricVersion: undefined },
    );
    const model = buildScoredReport(report, null);
    expect(model.isLegacy).toBe(true);
    expect(model.legacyLabel).toBe("LEGACY RESULT — scored under an earlier rubric; not reweighted");
    expect(model.pillars.accuracy.baseline).toBe("11%");
    expect(model.pillars.accuracy.change).toBe("+67 percentage points");
    for (const row of model.accuracyTable.rows) expect(row.baseline).toBe("n/a (legacy run)");
    expect(model.accuracyTable.totalRow.treatment).toBe("**78/100 — 78%**");
    expect(renderScoredTerminal(model)).toContain("LEGACY RESULT");
    expect(renderScoredMarkdown(model)).toContain("LEGACY RESULT");
    const json = renderScoredJson(model);
    expect(json.isLegacy).toBe(true);
    expect(json.rubricVersion).toBeNull();
  });

  it("JSON schema version is 3 across success and verify-fail shapes", () => {
    const report = createRunReport();
    const scored = buildScoredReport(report, MOCK_RUBRIC);
    expect(REPORT_JSON_SCHEMA_VERSION).toBe(3);
    expect(JSON.parse(formatRunReport({ ...report, scored }, { format: "json" })).schemaVersion).toBe(3);
    const failReport: RunReport = {
      ...report,
      verification: {
        ...VERIFIED_OK,
        ok: false,
        failures: [{ code: "evidence-invalid", failureClass: "infrastructure", message: "hash mismatch", at: "manifest.json" }],
      },
    };
    const failJson = JSON.parse(formatRunReport(failReport, { format: "json" }));
    expect(failJson.schemaVersion).toBe(3);
    expect(failJson.success).toBe(false);
  });

  it("terminal report puts operational data in a footer after the scored sections", () => {
    const report = createRunReport();
    const text = formatRunReport({ ...report, scored: buildScoredReport(report, MOCK_RUBRIC) }, { format: "table" });
    const lines = text.split("\n");
    expect(lines[0]).toBe("network-config-01");
    expect(lines[1]).toBe("Agent:  Pi · google/fake-model-0");
    expect(text.indexOf("Cost and latency:")).toBeLessThan(text.indexOf("limits "));
    expect(text).toMatch(/\nreceipt\s+\/tmp\/fake-run\/receipt\.json\n/);
    expect(text).toContain("export    pnpm eval:export --receipt /tmp/fake-run/receipt.json");
  });

  it("derives skill label, title and scenario without fabricating", () => {
    expect(buildScoredReport(createRunReport({ skillSourcePath: "skills/custom-skill" }), MOCK_RUBRIC).skillLabel).toBe("custom-skill");
    expect(buildScoredReport(createRunReport({ skillSourcePath: undefined }), MOCK_RUBRIC).skillLabel).toBe("n/a");

    const display = { title: "network configuration migration", scenario: "Migrate production and staging network configuration to Arbitrum" };
    const md = renderScoredMarkdown(buildScoredReport(createRunReport(), { ...MOCK_RUBRIC, display }));
    expect(md).not.toMatch(/AF-Evaluation|img\.shields/);
    expect(md).toContain("# EVALS.MD: network configuration migration");
    expect(md).toContain("## Scenario: Migrate production and staging network configuration to Arbitrum");

    const fallback = buildScoredReport(createRunReport({ caseSelector: "other-case-02", caseId: "other-case-02" }), MOCK_RUBRIC);
    expect(fallback.caseTitle).toBe("other-case-02");
    expect(fallback.caseScenario).toBe("other-case-02");
  });

  describe("mean mode aggregates status and derived durations across pairs", () => {
    const pairN = (n: number, baseline: ConditionReport, treatment: ConditionReport): PairReport => ({
      ...pairOf(baseline, treatment),
      pairId: `run-001-r00${n}`,
      repetition: n,
    });

    it("keeps the single-arm wording when every pair agrees", () => {
      const pairs = [1, 2, 3].map((n) => pairN(n, createConditionReport("baseline"), createConditionReport("treatment")));
      const model = buildScoredReport(createRunReport({ pairs }), MOCK_RUBRIC, { mode: "mean", pairs });
      expect(model.statusLine).toBe("Completed; graded");
      expect(model.pillars.latency.treatment).not.toContain("session-derived");
    });

    it("reports per-pair status counts when pairs differ (B3)", () => {
      const pairs = [
        pairN(1, createConditionReport("baseline"), createConditionReport("treatment")),
        pairN(2, createConditionReport("baseline", { status: "task-limit", stopCause: "wall-clock" }), createConditionReport("treatment")),
        pairN(3, createConditionReport("baseline"), createConditionReport("treatment", { status: "task-limit", stopCause: "wall-clock" })),
      ];
      const model = buildScoredReport(createRunReport({ pairs }), MOCK_RUBRIC, { mode: "mean", pairs });
      expect(model.statusLine).toBe(
        "Completed in 2 of 3 pairs, task limit reached in 1; graded",
      );
    });

    it("labels a mean mixing recorded and session-derived durations with the pair count (B4)", () => {
      const derived = { durationMs: null, sessionDurationMs: 30_000 };
      const pairs = [
        pairN(1, createConditionReport("baseline"), createConditionReport("treatment", { durationMs: 10_000 })),
        pairN(2, createConditionReport("baseline"), createConditionReport("treatment", derived)),
        pairN(3, createConditionReport("baseline"), createConditionReport("treatment", { durationMs: 20_000 })),
      ];
      const model = buildScoredReport(createRunReport({ pairs }), MOCK_RUBRIC, { mode: "mean", pairs });
      expect(model.pillars.latency.treatment).toBe("20,000 ms (session-derived in 1 of 3 pairs)");
      expect(model.pillars.latency.baseline).not.toContain("session-derived");
      expect(model.pillars.latency.change).toContain("approximate");
    });
  });
});

describe("renderScoredSummaryMarkdown", () => {
  const DETAILS_URL = "https://github.com/example/evals/blob/HEAD/eval-cases/network-config-01/runs/run-001/EVALS-FULL-REPORT.md";
  const RUN_HASH = "ab".repeat(32);
  const golden = (name: string, actual: string): void => {
    const path = new URL(`./__golden__/${name}`, import.meta.url);
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(path, actual);
    expect(actual).toBe(readFileSync(path, "utf8"));
  };

  /** Builds a verified-shaped report whose arms are scored for real from per-pair passed-check sets. */
  interface FixtureOptions {
    readonly caseId: string;
    readonly title?: string;
    readonly skill?: string;
    readonly rubric: Rubric;
    readonly pairs: readonly { readonly baseline: readonly string[]; readonly treatment: readonly string[] }[];
    readonly target?: { provider: string; model: string; thinking: string };
    readonly selected?: string;
    readonly testDouble?: boolean;
    readonly runId?: string;
    readonly treeHash?: string;
    /** Overrides the treatment arm's usage/timing (e.g. missing tokens, session-derived latency). */
    readonly treatment?: Partial<ConditionReport>;
  }
  function fixture(options: FixtureOptions): { report: RunReport; scored: ReturnType<typeof buildScoredReport> } {
    const runId = options.runId ?? `run-${options.caseId}`;
    const arm = (id: "baseline" | "treatment", passed: ReadonlySet<string>, tokens: number): ConditionReport => {
      const results = options.rubric.checks.map((c) => ({ id: c.id, passed: passed.has(c.id) }));
      const rubricScore = scoreWithRubric(options.rubric, results.map((r) => ({ ...r, message: "" })));
      return attachConditionCheckResults(
        createConditionReport(id, { rubricScore, score: rubricScore.score, consumedTokens: tokens, durationMs: tokens * 10, ...(id === "treatment" ? (options.treatment ?? {}) : {}) }),
        results,
      );
    };
    const pairs: PairReport[] = options.pairs.map((p, i) => ({
      ...pairOf(arm("baseline", new Set(p.baseline), 1000), arm("treatment", new Set(p.treatment), 400)),
      pairId: `${runId}-r${String(i + 1).padStart(3, "0")}`,
      repetition: i + 1,
    }));
    const report = createRunReport({
      runId,
      caseId: options.caseId,
      caseSelector: options.caseId,
      pairs,
      testDouble: options.testDouble ?? false,
      target: (options.target ?? { provider: "google", model: "gemini-3.8-flash", thinking: "low" }) as RunReport["target"],
      skillSourcePath: `skills/${options.skill ?? "ops-skill"}`,
      runDir: `/tmp/${runId}`,
      receiptManifest: { treeSha256: options.treeHash ?? "cd".repeat(32), fileSha256: "ef".repeat(32) },
      caseTitle: options.title ?? `${options.caseId} title`,
      caseScenario: `${options.caseId} scenario`,
    });
    const selection =
      options.selected !== undefined
        ? { mode: "single" as const, pair: pairs.find((p) => p.pairId.endsWith(options.selected!))! }
        : pairs.length === 1
          ? { mode: "single" as const, pair: pairs[0]! }
          : { mode: "mean" as const, pairs };
    return { report, scored: buildScoredReport(report, options.rubric, selection) };
  }
  const documentOf = (...inputs: ReturnType<typeof fixture>[]): SummaryDocument => ({
    skillLabel: inputs[0]!.scored.skillLabel,
    entries: inputs.map(({ report, scored }) =>
      buildSummaryEntry({
        report,
        scored,
        frozenPrompt: `Prompt of ${report.caseId}.`,
        reportUrl: `https://github.com/example/evals/blob/HEAD/eval-cases/${report.caseId}/runs/${report.runId}/EVALS-FULL-REPORT.md`,
      }),
    ),
  });

  // Rubric A: three topics with their own labels/weights plus two ungrouped constraints.
  const RUBRIC_A: Rubric = {
    rubricVersion: "v0.2",
    checks: [
      { id: "a1", group: "outcome", topic: "zones", points: 15 },
      { id: "a2", group: "outcome", topic: "zones", points: 15 },
      { id: "b1", group: "outcome", topic: "ttl", points: 20 },
      { id: "c1", group: "outcome", topic: "failover", points: 30 },
      { id: "k1", group: "constraints", points: 10 },
      { id: "k2", group: "constraints", points: 10 },
    ],
    topics: [
      { id: "zones", label: "Zone records", points: 30 },
      { id: "ttl", label: "TTL policy", points: 20 },
      { id: "failover", label: "Failover", points: 30 },
    ],
  };
  /** The same weights without topics (a valid topic-less rubric: checks carry no topic). */
  const FLAT_A: Rubric = { rubricVersion: "v0.2", checks: RUBRIC_A.checks.map(({ id, group, points }) => ({ id, group, points })) };
  const ALL_A = ["a1", "a2", "b1", "c1", "k1", "k2"];

  it("matches the single-pair golden: skill title, index, case section, results, outcome checks and full reports", () => {
    const out = renderScoredSummaryMarkdown(documentOf(fixture({ caseId: "network-config-01", skill: "arbitrum-docs", rubric: MOCK_RUBRIC, testDouble: true, runId: "run-001", pairs: [{ baseline: ["json-shape", "preservation"], treatment: MOCK_RUBRIC.checks.map((c) => c.id) }] })));
    expect(out).not.toMatch(/Hash:|Run:|Agent:|Status:|AF-Evaluation|img\.shields|Mean Score|Execution|Run details/);
    expect(out).not.toContain("### Accuracy\n");
    expect(out.startsWith("> **Warning:** TEST-DOUBLE EVIDENCE")).toBe(true);
    expect(out).toContain("# arbitrum-docs — Evaluation cases\n\n## Case index\n\nScore in this index is the Treatment score.\n");
    golden("evals-summary.single.md", out);
  });

  it("matches the mean golden over three pairs and has no test-double warning for measured evidence", () => {
    const pass = MOCK_RUBRIC.checks.map((c) => c.id);
    const out = renderScoredSummaryMarkdown(
      documentOf(fixture({ caseId: "network-config-01", skill: "arbitrum-docs", rubric: MOCK_RUBRIC, runId: "run-001", pairs: [1, 2, 3].map(() => ({ baseline: ["json-shape", "preservation"], treatment: pass })) })),
    );
    expect(out).not.toContain("Warning");
    expect(out).toContain("Metrics are means across all three pairs.");
    golden("evals-summary.mean.md", out);
  });

  it("renders a score change as the signed arithmetic difference (20% to 69% is +49%), never relative growth", () => {
    expect(formatSummaryScoreChange(49)).toBe("+49%");
    expect(formatSummaryScoreChange(-12)).toBe("−12%");
    expect(formatSummaryScoreChange(0)).toBe("0%");
    expect(formatSummaryScoreChange(48.96)).toBe("+49%");
    expect(formatSummaryScoreChange(12.34)).toBe("+12.3%");
    expect(formatSummaryScoreChange(-0.04)).toBe("0%");
    expect(formatSummaryScoreChange(null)).toBe("n/a");
    // 20 -> 69: baseline passes k1+k2 (20), treatment passes 69 points' worth is not representable
    // with 5-point granularity, so use 25 -> 70 and check the difference, not (70-25)/25.
    const rubric: Rubric = { rubricVersion: "v0.2", checks: [
      { id: "o1", group: "outcome", points: 40 }, { id: "o2", group: "outcome", points: 40 },
      { id: "c1", group: "constraints", points: 20 } ] };
    const { scored } = fixture({ caseId: "x", rubric, pairs: [{ baseline: ["c1"], treatment: ["o1", "o2", "c1"] }] });
    expect(scored.pillars.accuracy.baseline).toBe("20%");
    expect(scored.pillars.accuracy.treatment).toBe("100%");
    const md = renderScoredSummaryMarkdown(documentOf(fixture({ caseId: "x", rubric, pairs: [{ baseline: ["c1"], treatment: ["o1", "c1"] }] })));
    expect(md).toContain("| Score | Google Gemini 3.8 Flash | 20% | 60% | +40% |");
  });

  it("renders its own skill, case, task, model, rubric labels, weights and pair counts (1, 3 and 4 pairs)", () => {
    for (const pairCount of [1, 3, 4]) {
      const pair = { baseline: ["k1"], treatment: ALL_A };
      const out = renderScoredSummaryMarkdown(
        documentOf(fixture({
          caseId: "dns-migration-02", title: "dns zone migration", skill: "ops-skill", rubric: RUBRIC_A,
          target: { provider: "anthropic", model: "claude-sonnet-4-5", thinking: "off" },
          pairs: Array.from({ length: pairCount }, () => pair),
        })),
      );
      expect(out).toContain("# ops-skill — Evaluation cases");
      expect(out).toContain("| [dns-migration-02](#dns-migration-02) | Anthropic Claude Sonnet 4.5 | Dns zone migration | 100% |");
      expect(out).toContain("Prompt of dns-migration-02.");
      expect(out).toContain("| `dns-migration-02` | Zone records | Anthropic Claude Sonnet 4.5 | 0/30 | 30/30 |");
      expect(out).toContain("| `dns-migration-02` | TTL policy | Anthropic Claude Sonnet 4.5 | 0/20 | 20/20 |");
      expect(out).toContain("| `dns-migration-02` | Failover | Anthropic Claude Sonnet 4.5 | 0/30 | 30/30 |");
      expect(out).toContain("| `dns-migration-02` | **Outcome total** | Anthropic Claude Sonnet 4.5 | **0/80** | **80/80** |");
      expect(out).toContain(pairCount === 1 ? "Metrics are from a single pair." : `Metrics are means across all ${["", "", "", "three", "four"][pairCount]} pairs.`);
      expect(out).not.toMatch(/arbitrum|network-config|Gemini|ten pairs/i);
      expect((out.match(/Zone records/g) ?? []).length).toBe(1);
    }
  });

  it("uses mean points over rendered pairs, not pass counts", () => {
    const out = renderScoredSummaryMarkdown(documentOf(fixture({
      caseId: "dns-migration-02", rubric: RUBRIC_A,
      pairs: [
        { baseline: [], treatment: ["a1", "b1", "c1"] },
        { baseline: [], treatment: ["a1", "a2", "b1", "c1"] },
        { baseline: [], treatment: ["b1", "c1"] },
      ],
    })));
    // zones: (15 + 30 + 0) / 3 = 15; ttl and failover pass in all pairs.
    expect(out).toMatch(/\| Zone records \| [^|]+ \| 0\/30 \| 15\/30 \|/);
    expect(out).toMatch(/\*\*0\/80\*\* \| \*\*65\/80\*\*/);
  });

  it("selects an explicit pair and says so", () => {
    const out = renderScoredSummaryMarkdown(documentOf(fixture({
      caseId: "dns-migration-02", rubric: RUBRIC_A, selected: "r002",
      pairs: [{ baseline: [], treatment: ALL_A }, { baseline: [], treatment: ["b1"] }, { baseline: [], treatment: ALL_A }],
    })));
    expect(out).toContain("Metrics are from the explicitly selected pair r002 of 3.");
    expect(out).toMatch(/\*\*0\/80\*\* \| \*\*20\/80\*\*/);
    expect(out).not.toContain("means across");
  });

  it("projects only outcome checks: mixed topics by individual check, constraint-only topics excluded, Score keeps both groups", () => {
    const rubric: Rubric = {
      rubricVersion: "v0.2",
      checks: [
        { id: "x1", group: "outcome", topic: "mixed", points: 30 },
        { id: "y1", group: "constraints", topic: "mixed", points: 10 },
        { id: "z1", group: "outcome", topic: "pure", points: 50 },
        { id: "p1", group: "constraints", topic: "keep", points: 10 },
      ],
      topics: [
        { id: "mixed", label: "Mixed topic", points: 40 },
        { id: "pure", label: "Outcome topic", points: 50 },
        { id: "keep", label: "Preservation", points: 10 },
      ],
    };
    const input = fixture({ caseId: "mixed-01", rubric, pairs: [
      { baseline: ["y1", "p1"], treatment: ["x1", "y1", "z1"] },
      { baseline: ["y1", "p1"], treatment: ["z1", "y1", "p1"] },
    ] });
    const out = renderScoredSummaryMarkdown(documentOf(input));
    expect(out).toContain("| `mixed-01` | x1 | Google Gemini 3.8 Flash | 0/30 | 15/30 |");
    expect(out).toContain("| `mixed-01` | Outcome topic | Google Gemini 3.8 Flash | 0/50 | 50/50 |");
    expect(out).toContain("**0/80** | **65/80**");
    expect(out).not.toMatch(/Mixed topic|Preservation|y1|p1/);
    // Score is the full accuracy: baseline 20, treatment mean of 90 and 70 points.
    expect(out).toContain("| Score | Google Gemini 3.8 Flash | 20% | 80% | +60% |");
  });

  it("projects ungrouped outcome checks and rubrics without topics, with declared IDs as labels", () => {
    const rubric: Rubric = { rubricVersion: "v0.2", checks: [
      { id: "has-file", group: "outcome", points: 50 }, { id: "right-keys", group: "outcome", points: 30 },
      { id: "no-extra", group: "constraints", points: 20 } ] };
    const { report } = fixture({ caseId: "plain-01", rubric, pairs: [{ baseline: [], treatment: ["has-file", "no-extra"] }] });
    const rows = projectOutcomeChecks(rubric, report.pairs);
    expect(rows.rows.map((r) => [r.label, r.baseline, r.treatment, r.max])).toEqual([["has-file", 0, 50, 50], ["right-keys", 0, 0, 30]]);
    expect(rows.totals).toEqual({ baseline: 0, treatment: 50 });
    expect(rows.max).toBe(80);
  });

  it("fails closed rather than redistributing points when checks disagree with the sealed group total", () => {
    const flat = FLAT_A;
    const { report } = fixture({ caseId: "dns-migration-02", rubric: flat, pairs: [{ baseline: [], treatment: ["a1", "b1"] }] });
    const treatment = report.pairs[0]!.conditions.find((c) => c.conditionId === "treatment")!;
    // Tamper in memory: the verified check results claim c1 passed, but the sealed score says it did not.
    attachConditionCheckResults(treatment, flat.checks.map((c) => ({ id: c.id, passed: ["a1", "b1", "c1"].includes(c.id) })));
    expect(() => projectOutcomeChecks(flat, report.pairs)).toThrow(/do not agree/);
  });

  it("keeps unavailable data factual: no check results show n/a, and a missing model/task stay explicit", () => {
    const { report, scored } = fixture({ caseId: "dns-migration-02", rubric: FLAT_A, pairs: [{ baseline: [], treatment: ALL_A }] });
    const entry = buildSummaryEntry({ report: { ...report, target: undefined, caseScenario: undefined }, scored, frozenPrompt: null, reportUrl: "https://github.com/example/evals/blob/HEAD/x" });
    const out = renderScoredSummaryMarkdown({ skillLabel: "ops-skill", entries: [entry] });
    expect(out).toContain("Task description unavailable");
    expect(out).toContain("| Score | n/a |");
    // Without recorded check results individual rows cannot be shown faithfully: n/a, not guessed.
    const bare = createConditionReport("treatment", { rubricScore: scoreWithRubric(RUBRIC_A, RUBRIC_A.checks.map((c) => ({ id: c.id, passed: true, message: "" }))) });
    expect(projectOutcomeChecks(FLAT_A, [pairOf(null, bare)]).rows[0]!.treatment).toBeNull();
  });

  it("renders several distinct entries in the given order with their own metrics, links and provenance, and no overall score", () => {
    const one = fixture({ caseId: "dns-migration-02", skill: "ops-skill", rubric: RUBRIC_A, treeHash: "11".repeat(32), pairs: [{ baseline: [], treatment: ALL_A }] });
    const two = fixture({
      caseId: "alpha-case", skill: "ops-skill", rubric: RUBRIC_A, treeHash: "22".repeat(32),
      target: { provider: "openai", model: "gpt-5", thinking: "off" },
      pairs: [{ baseline: ["k1"], treatment: ["a1", "k1"] }, { baseline: ["k1"], treatment: ["a1", "k1"] }],
    });
    const out = renderScoredSummaryMarkdown(documentOf(one, two));
    expect(out.indexOf("## dns-migration-02")).toBeLessThan(out.indexOf("## alpha-case"));
    expect(out).toContain("| [dns-migration-02](#dns-migration-02) | Google Gemini 3.8 Flash | Dns-migration-02 title | 100% |");
    expect(out).toContain("| [alpha-case](#alpha-case) | OpenAI GPT 5 | Alpha-case title | 25% |");
    expect(out).toContain("Prompt of alpha-case.");
    expect(out).toContain("Metrics are from a single pair.");
    expect(out).toContain("Metrics are means across all two pairs.");
    expect(out).toContain("| dns-migration-02 | [View full report](https://github.com/example/evals/blob/HEAD/eval-cases/dns-migration-02/runs/run-dns-migration-02/EVALS-FULL-REPORT.md) |");
    expect(out).toContain("| alpha-case | [View full report](https://github.com/example/evals/blob/HEAD/eval-cases/alpha-case/runs/run-alpha-case/EVALS-FULL-REPORT.md) |");
    expect(out).toMatch(new RegExp(`case=dns-migration-02 run=run-dns-migration-02 selection=single pairs=\\S+ treeSha256=${"11".repeat(32)} -->`));
    expect(out).toMatch(new RegExp(`case=alpha-case run=run-alpha-case selection=mean pairs=run-alpha-case-r001,run-alpha-case-r002 treeSha256=${"22".repeat(32)} -->`));
    expect(out).not.toContain("treeSha256=" + "cd".repeat(32));
    expect(out).not.toMatch(/overall|average score|Mean Score/i);
    // Full reports is the last visible section.
    const visible = out.replace(/<!--[\s\S]*?-->/g, "");
    expect(visible.lastIndexOf("## Full reports")).toBeGreaterThan(visible.lastIndexOf("### Outcome Checks"));
  });

  it("index links resolve to real section anchors, even for ids that collide with fixed headings", () => {
    const ids = ["task", "results", "dns-migration-02", "case-index"];
    const out = renderScoredSummaryMarkdown(documentOf(...ids.map((id) => fixture({ caseId: id, rubric: RUBRIC_A, pairs: [{ baseline: [], treatment: ALL_A }] }))));
    // Reproduce GitHub's anchor assignment over the rendered headings.
    const seen = new Map<string, number>();
    const anchors: string[] = [];
    for (const line of out.split("\n").filter((l) => /^#{1,3} /.test(l))) {
      const base = line.replace(/^#+ /, "").toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replaceAll(" ", "-");
      let slug = base;
      let n = seen.get(base) ?? 0;
      while (anchors.includes(slug)) slug = `${base}-${++n}`;
      seen.set(base, n);
      anchors.push(slug);
    }
    const linked = [...out.matchAll(/\| \[([^\]]+)\]\(#([^)]+)\) \|/g)].map((m) => [m[1]!, m[2]!]);
    expect(linked.map(([id]) => id)).toEqual(ids);
    const headingLines = out.split("\n").filter((l) => /^#{1,3} /.test(l));
    for (const [id, anchor] of linked) {
      const at = anchors.indexOf(anchor!);
      expect(at, `anchor ${anchor} must exist`).toBeGreaterThanOrEqual(0);
      expect(headingLines[at]).toBe(`## ${id}`);
    }
    expect(new Set(linked.map(([, a]) => a)).size).toBe(ids.length);
  });

  it("escapes pipes, line breaks and Markdown/HTML metacharacters in task text, labels and models", () => {
    const rubric: Rubric = { rubricVersion: "v0.2", checks: [
      { id: "o1", group: "outcome", topic: "t", points: 80 }, { id: "c1", group: "constraints", points: 20 } ],
      topics: [{ id: "t", label: "Pipe | <b>bold</b> *star*\nline", points: 80 }] };
    const input = fixture({ caseId: "esc-01", rubric, pairs: [{ baseline: [], treatment: ["o1", "c1"] }], target: { provider: "weird", model: "a|b<c>", thinking: "off" } });
    const doc = documentOf(input);
    const out = renderScoredSummaryMarkdown({ ...doc, skillLabel: "my_skill <x>", entries: [{ ...doc.entries[0]!, taskText: "Do `this` | <script>alert(1)</script>\nsecond line\n\n- not a list\n# not a heading", caseTitle: "t|<i>" }] });
    expect(out).toContain("# my\\_skill \\<x\\> — Evaluation cases");
    expect(out).toContain("Pipe \\| \\<b\\>bold\\</b\\> \\*star\\* line");
    expect(out).toContain("Do \\`this\\` \\| \\<script\\>alert(1)\\</script\\>  \nsecond line");
    expect(out).toContain("\\- not a list  \n\\# not a heading");
    expect(out).not.toMatch(/<script>|<b>/);
    expect(out).toContain("weird/a\\|b\\<c\\>");
    for (const row of out.split("\n").filter((l) => l.startsWith("| `esc-01`"))) expect(row.replace(/\\\|/g, "").split("|").length).toBe(7);
  });

  it("binds the exact tree hash to its entry in a comment that cannot be broken out of", () => {
    const input = fixture({ caseId: "weird--id>-->x", rubric: RUBRIC_A, runId: "run--1 -->", pairs: [{ baseline: [], treatment: ALL_A }] });
    const out = renderScoredSummaryMarkdown(documentOf(input));
    const comments = [...out.matchAll(/<!--(.*?)-->/g)];
    expect(comments).toHaveLength(1);
    const body = comments[0]![1]!;
    expect(body).not.toContain("--");
    expect(body).not.toContain(">");
    expect(body).toContain(`treeSha256=${"cd".repeat(32)}`);
    expect(decodeURIComponent(/case=(\S+)/.exec(body)![1]!)).toBe("weird--id>-->x");
    expect(decodeURIComponent(/run=(\S+)/.exec(body)![1]!)).toBe("run--1 -->");
    expect(out).not.toContain("AF-EVAL");
    expect(out.endsWith(`-->\n`)).toBe(true);
  });

  it("does not throw on float drift when per-unit means are summed (12 pairs, x.25 / x.x5 means)", () => {
    const rubric: Rubric = { rubricVersion: "v0.2", checks: [
      { id: "a", group: "outcome", points: 1 }, { id: "b", group: "outcome", points: 1 },
      { id: "c", group: "outcome", points: 1 }, { id: "d", group: "outcome", points: 77 },
      { id: "k", group: "constraints", points: 20 } ] };
    // a passes in 3 pairs, b in 4, c in 2: unit means sum to 0.7499999999999999 while the group mean is 0.75.
    const pairs = Array.from({ length: 12 }, (_, i) => ({
      baseline: [] as string[],
      treatment: [...(i < 3 ? ["a"] : []), ...(i < 4 ? ["b"] : []), ...(i < 2 ? ["c"] : [])],
    }));
    const input = fixture({ caseId: "drift-01", rubric, pairs });
    const out = renderScoredSummaryMarkdown(documentOf(input));
    expect(out).toContain("**0/80** | **0.8/80**");
    expect(out).toContain("| a | Google Gemini 3.8 Flash | 0/1 | 0.3/1 |");
  });

  it("fails closed in the verified adapter when the receipt carries no tree hash", () => {
    const { report, scored } = fixture({ caseId: "dns-migration-02", rubric: RUBRIC_A, pairs: [{ baseline: [], treatment: ALL_A }] });
    const { receiptManifest: _omit, ...without } = report;
    expect(() => buildSummaryEntry({ report: without as RunReport, scored, frozenPrompt: "p", reportUrl: DETAILS_URL })).toThrow(/no manifest tree hash/);
  });

  it("keeps n/a tokens and session-derived / approximate annotations in the Results table", () => {
    const out = renderScoredSummaryMarkdown(documentOf(fixture({
      caseId: "dns-migration-02", rubric: RUBRIC_A,
      pairs: [{ baseline: [], treatment: ALL_A }],
      treatment: { consumedTokens: null, durationMs: null, sessionDurationMs: 7_000 },
    })));
    expect(out).toContain("| Cost: recorded tokens | Google Gemini 3.8 Flash | 1,000 | n/a | n/a |");
    expect(out).toContain("| Latency | Google Gemini 3.8 Flash | 10,000 ms | 7,000 ms (session-derived) | −3,000 ms (−30.0%, approximate) |");
  });

  it("neutralizes setext underline lines in task text", () => {
    const doc = documentOf(fixture({ caseId: "dns-migration-02", rubric: RUBRIC_A, pairs: [{ baseline: [], treatment: ALL_A }] }));
    const out = renderScoredSummaryMarkdown({ ...doc, entries: [{ ...doc.entries[0]!, taskText: "Title\n---\nOther\n===\n-" }] });
    expect(out).toContain("Title  \n\\---  \nOther  \n\\===  \n\\-");
  });

  it("buildSummaryDocument yields one entry labelled with the frozen skill", () => {
    const { report, scored } = fixture({ caseId: "dns-migration-02", skill: "ops-skill", rubric: RUBRIC_A, pairs: [{ baseline: [], treatment: ALL_A }] });
    const doc = buildSummaryDocument({ report, scored, frozenPrompt: "p", reportUrl: DETAILS_URL });
    expect(doc.skillLabel).toBe("ops-skill");
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0]!.treeSha256).toBe(RUN_HASH.replaceAll("ab", "cd"));
  });
});
