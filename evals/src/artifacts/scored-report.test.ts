import { describe, expect, it } from "vitest";
import type { Rubric, RubricScore } from "../runner/rubric.ts";
import {
  buildScoredReport,
  formatDuration,
  formatDurationDiff,
  formatSignedAccuracyDiff,
  formatTokenDiff,
  formatTokens,
  generateBadge,
  renderScoredJson,
  renderScoredMarkdown,
  renderScoredTerminal,
  REPORT_JSON_SCHEMA_VERSION,
} from "./scored-report.ts";
import { formatRunReport } from "./queries.ts";
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
    expect(md).toContain("| Latency | 12.3s | 3m34s | +3m22s (+1633.1%) |");
    expect(term).toMatch(/│ Accuracy\s+│\s+20% │\s+100% │ \+80 percentage points │/);

    // Accuracy: exactly two rows + total, no unhappy row
    expect(md).toContain("| Outcome correctness and completeness | 0/80 — 0% | 80/80 — 100% |");
    expect(md).toContain("| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |");
    expect(md).toContain("| **Accuracy total** | **20/100 — 20%** | **100/100 — 100%** |");
    expect(model.accuracyTable.rows).toHaveLength(2);
    expect(md).not.toMatch(/unhappy/i);
    expect(term).not.toMatch(/unhappy/i);
    expect(term).toContain("Outcome correctness and completeness");
    expect(term).toMatch(/├─+┼─+┼─+┤\n│ Accuracy total/);

    // Outcome checks
    expect(md).toContain("### Outcome checks");
    expect(md).toContain("| **Outcome total** | **0/80** | **80/80** |");
    expect(term).toContain("Outcome checks (each check covers both production and staging):");
    expect(term).toContain("Outcome total");

    // Cost and latency
    expect(md).toContain("| Time to completion or termination | 12.345s | 3m33.947s |");
    expect(term).toContain("3m33.947s");

    // JSON
    expect(json.schemaVersion).toBe(3);
    expect(json.scored.rubricVersion).toBe("v0.2");
    expect(json.scored.groups.outcome).toMatchObject({ label: "Outcome correctness and completeness", points: 80, baselineGot: 0, treatmentGot: 80 });
    expect(json.scored.groups.constraints).toMatchObject({ points: 20, baselineGot: 20, treatmentGot: 20 });
    expect(json.scored.groups).not.toHaveProperty("unhappy");
    expect(json.scored.accuracy).toEqual({ baseline: 20, treatment: 100, changePercentagePoints: 80 });
    expect(json.scored.latency.treatmentPrecise).toBe("3m33.947s");
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
    expect(renderScoredMarkdown(model)).not.toContain("### Outcome checks");
    expect(renderScoredTerminal(model)).not.toContain("Outcome checks");

    const withDetails = formatRunReport({ ...report, scored: model }, { format: "markdown", details: true });
    expect(withDetails).not.toContain("### Outcome checks");
    expect(withDetails).toContain("## Operational details");
    const both = formatRunReport({ ...report, scored: model }, { format: "markdown", details: true, checks: true });
    expect(both).toContain("### Outcome checks");
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

    expect(formatDurationDiff(10_000, 15_000)).toBe("+5.0s (+50.0%)");
    expect(formatDurationDiff(2_959_239, 214_000)).toBe("−45m45s (−92.8%)");
    expect(formatDurationDiff(2_959_239, 214_000, { approximate: true })).toBe("−45m45s (−92.8%, approximate)");
    expect(formatDurationDiff(10_000, 10_000)).toBe("0.0s (0.0%)");
    expect(formatDurationDiff(0, 5_000)).toBe("+5.0s (n/a)");
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
    expect(model.pillars.latency.baseline).toBe("5m00s");
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
    expect(model.pillars.latency.baseline).toBe("49m19s (session-derived)");
    expect(model.pillars.latency.change).toBe("−45m45s (−92.8%, approximate)");
    expect(model.costLatencyTable.rows[1]!.baseline).toBe("49m19.239s (session-derived)");
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
    expect(text).toContain("publish   pnpm eval:publish --receipt /tmp/fake-run/receipt.json --checks");
  });

  it("derives skill label, title and scenario without fabricating", () => {
    expect(buildScoredReport(createRunReport({ skillSourcePath: "skills/custom-skill" }), MOCK_RUBRIC).skillLabel).toBe("custom-skill");
    expect(buildScoredReport(createRunReport({ skillSourcePath: undefined }), MOCK_RUBRIC).skillLabel).toBe("n/a");

    const display = { title: "network configuration migration", scenario: "Migrate production and staging network configuration to Arbitrum" };
    const md = renderScoredMarkdown(buildScoredReport(createRunReport(), { ...MOCK_RUBRIC, display }));
    expect(md).toContain("# EVALS.MD: network configuration migration");
    expect(md).toContain("## Scenario: Migrate production and staging network configuration to Arbitrum");

    const fallback = buildScoredReport(createRunReport({ caseSelector: "other-case-02", caseId: "other-case-02" }), MOCK_RUBRIC);
    expect(fallback.caseTitle).toBe("other-case-02");
    expect(fallback.caseScenario).toBe("other-case-02");
  });

  it("generates non-certifying badges describing the treatment status and accuracy", () => {
    const completed = createConditionReport("treatment");
    expect(generateBadge(completed, "completed", 85)).toEqual({
      url: "https://img.shields.io/badge/AF--Evaluation-completed%20%C2%B7%2085%25-blue",
      alt: "AF-Evaluation: completed · 85%",
    });
    expect(generateBadge(completed, "completed", null).url).toBe("https://img.shields.io/badge/AF--Evaluation-completed-blue");
    expect(generateBadge(createConditionReport("treatment", { status: "task-limit" }), "", 40).url)
      .toBe("https://img.shields.io/badge/AF--Evaluation-task%20limit%20%C2%B7%2040%25-yellow");
    expect(generateBadge(createConditionReport("treatment", { status: "infrastructure-failure", stopCause: "infrastructure-error" }), "", null).url)
      .toBe("https://img.shields.io/badge/AF--Evaluation-infrastructure%20failure-red");
    expect(generateBadge(createConditionReport("treatment", { status: "infrastructure-failure", stopCause: "external-cancellation" }), "", null).url)
      .toBe("https://img.shields.io/badge/AF--Evaluation-interrupted-orange");
  });

  describe("mean mode aggregates status and derived durations across pairs", () => {
    const pairN = (n: number, baseline: ConditionReport, treatment: ConditionReport): PairReport => ({
      ...pairOf(baseline, treatment),
      pairId: `run-001-r00${n}`,
      repetition: n,
    });

    it("keeps the single-arm wording and badge when every pair agrees", () => {
      const pairs = [1, 2, 3].map((n) => pairN(n, createConditionReport("baseline"), createConditionReport("treatment")));
      const model = buildScoredReport(createRunReport({ pairs }), MOCK_RUBRIC, { mode: "mean", pairs });
      expect(model.statusLine).toBe("Completed; graded");
      expect(model.badgeUrl).toContain("-completed%20%C2%B7%20");
      expect(model.pillars.latency.treatment).not.toContain("session-derived");
    });

    it("reports per-pair status counts and a mixed badge when pairs differ (B3)", () => {
      const pairs = [
        pairN(1, createConditionReport("baseline"), createConditionReport("treatment")),
        pairN(2, createConditionReport("baseline", { status: "task-limit", stopCause: "wall-clock" }), createConditionReport("treatment")),
        pairN(3, createConditionReport("baseline"), createConditionReport("treatment", { status: "task-limit", stopCause: "wall-clock" })),
      ];
      const model = buildScoredReport(createRunReport({ pairs }), MOCK_RUBRIC, { mode: "mean", pairs });
      expect(model.statusLine).toBe(
        "Completed in 2 of 3 pairs, task limit reached in 1; graded",
      );
      expect(model.badgeUrl).toMatch(/AF--Evaluation-mixed%20%C2%B7%20\d+%25-yellow$/);
    });

    it("labels a mean mixing recorded and session-derived durations with the pair count (B4)", () => {
      const derived = { durationMs: null, sessionDurationMs: 30_000 };
      const pairs = [
        pairN(1, createConditionReport("baseline"), createConditionReport("treatment", { durationMs: 10_000 })),
        pairN(2, createConditionReport("baseline"), createConditionReport("treatment", derived)),
        pairN(3, createConditionReport("baseline"), createConditionReport("treatment", { durationMs: 20_000 })),
      ];
      const model = buildScoredReport(createRunReport({ pairs }), MOCK_RUBRIC, { mode: "mean", pairs });
      expect(model.pillars.latency.treatment).toBe("20.0s (session-derived in 1 of 3 pairs)");
      expect(model.pillars.latency.baseline).not.toContain("session-derived");
      expect(model.pillars.latency.change).toContain("approximate");
    });
  });
});
