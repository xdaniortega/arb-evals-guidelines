/**
 * Pure renderer of EVALS-FULL-REPORT.md: layout, variable populations, fallbacks, escaping.
 * Synthetic inputs only; no evidence, no I/O.
 */

import { describe, expect, it } from "vitest";
import { renderFullReport } from "./full-report.ts";
import type { FullReportArm, FullReportInput, FullReportPair, FullReportRow } from "./full-report.ts";

const arm = (overrides: Partial<FullReportArm> = {}): FullReportArm => ({ phrase: "completed", graded: true, scoreCell: "50/100 — 50%", ...overrides });
const composition: FullReportRow[] = [
  { label: "Alpha group", baseline: "10/80 — 13%", treatment: "40/80 — 50%" },
  { label: "Beta group", baseline: "20/20 — 100%", treatment: "10/20 — 50%" },
  { label: "Score total", baseline: "30/100 — 30%", treatment: "50/100 — 50%", bold: true },
];
const outcome = {
  rows: [
    { label: "Topic one", baseline: "5/10", treatment: "10/10" },
    { label: "Outcome total", baseline: "10/80", treatment: "40/80", bold: true },
  ] as FullReportRow[],
  unavailable: null,
};
const costLatency: FullReportRow[] = [
  { label: "Total recorded tokens, including cached input", baseline: "100", treatment: "50" },
  { label: "Time to completion or termination (ms)", baseline: "2,000 ms", treatment: "1,000 ms" },
];

const pairOf = (label: string, overrides: Partial<FullReportPair> = {}): FullReportPair => ({
  pairId: `run-1-${label}`,
  label,
  baseline: arm(),
  treatment: arm(),
  comparisonNote: null,
  composition,
  outcome,
  costLatency,
  resourcesRecorded: true,
  ...overrides,
});

function inputOf(pairs: readonly FullReportPair[], overrides: Partial<FullReportInput> = {}): FullReportInput {
  return {
    testDouble: false,
    legacyLabel: null,
    caseId: "case-x",
    caseTitle: "widget tuning",
    runId: "run-1",
    skillLabel: "widget-skill",
    agentLabel: "Pi",
    modelLabel: "Acme Model 1",
    pairs,
    aggregate: {
      mode: "scored",
      metrics: [
        { label: "Score", baseline: "30%", treatment: "50%", change: "+20%" },
        { label: "Cost: recorded tokens", baseline: "100", treatment: "50", change: "−50 (−50.0%)" },
        { label: "Latency", baseline: "2,000 ms", treatment: "1,000 ms", change: "−1,000 ms (−50.0%)" },
      ],
      scoreExplanation: "explained",
      composition,
      outcome,
      costLatency,
    },
    summaryRefusal: null,
    task: {
      scenario: "Tune the widget",
      caseVersion: "3",
      rubricVersion: "v0.2",
      allowedTools: "read, write",
      outputPath: "out.json",
      prompt: "Do the thing.",
      frozenUnavailableReason: null,
      docUrl: null,
      outcomeMax: 80,
      constraintsMax: 20,
      checks: [{ id: "c1", group: "outcome", topic: "Topic one", points: 80 }],
    },
    environment: { registeredModelId: "acme/model-1", provenance: [["Evaluator build", "evals-src@x"]] },
    integrity: { treeSha256: "a".repeat(64), fileSha256: "b".repeat(64) },
    runDir: "eval-cases/case-x/runs/run-1",
    reproduction: { caseSelector: "case-x", model: "model-1", thinking: "low", repetitions: pairs.length },
    ...overrides,
  };
}

const headingsOf = (text: string): string[] => text.split("\n").filter((l) => /^#{1,3} /.test(l));

describe("renderFullReport", () => {
  it("emits the approved section order for any population, including a single pair", () => {
    for (const n of [1, 3, 12]) {
      const pairs = Array.from({ length: n }, (_, i) => pairOf(`r${String(i + 1).padStart(3, "0")}`));
      const text = renderFullReport(inputOf(pairs));
      expect(headingsOf(text)).toEqual([
        "# Widget tuning — Full evaluation report",
        "## Results",
        "### Execution status",
        "### Score composition",
        "### Outcome Checks",
        "### Cost and latency detail",
        "## Pair explorer",
        ...pairs.map((p) => `### ${p.label}`),
        "## Task and rubric",
        "### Scoring rules and interpretation",
        "### Frozen checks and weights",
        "## Execution environment",
        "## Verify this report",
        "## Export and comparable runs",
        "### Export",
        "### Reproducibility",
      ]);
      // Index rows and detail blocks are a bijection, in recorded order.
      const indexed = [...text.matchAll(/^\| \[(r\d+)\]\(#(r\d+)\) \|/gm)].map((m) => [m[1], m[2]]);
      expect(indexed).toEqual(pairs.map((p) => [p.label, p.label]));
      expect(text.match(/<details>/g)).toHaveLength(n);
      expect(text.match(/<\/details>/g)).toHaveLength(n);
      for (const pair of pairs) expect(text.match(new RegExp(`Pair ID: \`${pair.pairId}\``, "g"))).toHaveLength(1);
      expect(text).toContain("<summary>Score, Outcome Checks, cost and latency</summary>");
      expect(text).toContain(`| Pairs | ${pairs.map((p) => p.label).join(", ")} |`);
      expect(text).not.toMatch(/Operational|Runtime r\d|toolSteps|stop cause/i);
    }
  });

  it("renders no Eval case column and no badge for a scored report", () => {
    const text = renderFullReport(inputOf([pairOf("r001"), pairOf("r002")]));
    expect(text).not.toContain("Eval case");
    expect(text).not.toMatch(/AF-Evaluation|img\.shields\.io/);
  });

  it("words the legacy Pair explorer intro without claiming grading", () => {
    const text = renderFullReport(
      inputOf([pairOf("r001"), pairOf("r002")], {
        legacyLabel: "LEGACY RESULT",
        aggregate: { mode: "legacy", metrics: null, scoreExplanation: null, composition: null, outcome: null, costLatency: null },
      }),
    );
    expect(text).toContain("These pairs were scored under an earlier rubric and are not graded under rubric v0.2");
    expect(text).not.toMatch(/All pairs are graded|The pair is graded/);
  });

  it("derives aggregate status counts from the pairs and never claims full grading when it is not", () => {
    const pairs = [
      pairOf("r001", { baseline: arm({ phrase: "task limit reached" }) }),
      pairOf("r002", { baseline: arm({ phrase: "task limit reached" }), treatment: arm({ phrase: "task limit reached" }) }),
      pairOf("r003", { baseline: arm({ phrase: "infrastructure failure", graded: false, scoreCell: "n/a" }), comparisonNote: "baseline not gradeable" }),
    ];
    const text = renderFullReport(inputOf(pairs));
    expect(text).toContain("| Baseline | Task limit reached in 2 of 3 pairs; infrastructure failure in 1 | Graded in 2 of 3 pairs |");
    expect(text).toContain("| Treatment | Completed in 2 of 3 pairs; task limit reached in 1 | All 3 graded |");
    expect(text).toContain("Grading is incomplete: Baseline is graded in 2 of 3 pairs and Treatment in 3.");
    expect(text).not.toMatch(/All pairs are graded|Means across all/);
    expect(text).toContain("2 of 3 pairs have both arms graded");
    expect(text).toContain("| [r003](#r003) | n/a | 50/100 — 50% | Infrastructure failure (not graded) | Completed |");
    expect(text).toContain("Not a valid comparison: baseline not gradeable");
  });

  it("does not claim all pairs back the token and latency means when usage or timing is missing", () => {
    const pairs = [pairOf("r001"), pairOf("r002", { resourcesRecorded: false })];
    const text = renderFullReport(inputOf(pairs));
    expect(text).not.toContain("Means across all");
    expect(text).toContain("Score and Outcome Checks are means across all two pairs.");
    expect(text).toContain("Token and latency means use only the pairs with a recorded value (1 of 2 pairs have both recorded for both arms).");
    const partial = renderFullReport(inputOf([pairOf("r001"), pairOf("r002", { baseline: arm({ graded: false }) })]));
    expect(partial).toContain("Score and Score composition are means over the graded pairs of each arm, Outcome Checks show n/a unless every pair is graded");
  });

  it("states the truthful note for one pair and for no pairs", () => {
    expect(renderFullReport(inputOf([pairOf("r001")]))).toContain("Results of the single pair r001.");
    const none = renderFullReport(
      inputOf([], {
        aggregate: { mode: "scored", metrics: null, scoreExplanation: null, composition: null, outcome: null, costLatency: null },
      }),
    );
    expect(none).toContain("No pairs were recorded for this run");
    expect(none).toContain("| Pairs | none recorded |");
    expect(none).toContain("--pair <pair>");
    expect(none).toContain("--repetitions <repetitions>");
    expect(none).not.toContain("r001");
    expect(none).not.toContain("<details>");
  });

  it("renders legacy runs without aggregates, decomposition or reweighting", () => {
    const pairs = [
      pairOf("r001", {
        baseline: arm({ scoreCell: "0.500 (original scale)" }),
        treatment: arm({ scoreCell: "0.750 (original scale)" }),
        composition: null,
        outcome: null,
      }),
    ];
    const text = renderFullReport(
      inputOf(pairs, {
        legacyLabel: "LEGACY RESULT — scored under an earlier rubric; not reweighted",
        aggregate: { mode: "legacy", metrics: null, scoreExplanation: null, composition: null, outcome: null, costLatency: null },
        task: { ...inputOf([]).task, rubricVersion: null, outcomeMax: null, constraintsMax: null, checks: null },
      }),
    );
    expect(text).toContain("> **Warning:** LEGACY RESULT");
    expect(text).toContain("| [r001](#r001) | 0.500 (original scale) | 0.750 (original scale) | Completed | Completed |");
    expect(text).toContain("Score composition is not available for this run");
    expect(text).toContain("Not available: this pair was scored under an earlier rubric");
    expect(text).not.toContain("| Metric | Baseline | Treatment | Change |");
    expect(text).not.toMatch(/AF-Evaluation|img\.shields/);
    expect(text).not.toMatch(/Outcome total/);
    expect(text).toContain("Not available: this run has no scored view of a frozen rubric v0.2.");
  });

  it("keeps the TEST-DOUBLE warning and escapes titles, labels and cells", () => {
    const text = renderFullReport(
      inputOf([pairOf("r001")], {
        testDouble: true,
        caseTitle: "a|b <script> [x](y)",
        modelLabel: "Evil | `model`",
      }),
    );
    expect(text.split("\n")[0]).toBe("> **Warning:** TEST-DOUBLE EVIDENCE — synthetic scores, not a measured result");
    expect(text).not.toContain("<script>");
    expect(text).toContain("A\\|b \\<script\\> \\[x\\](y)");
    expect(text).toContain("| LLM model | Evil \\| \\`model\\` |");
  });

  it("fences the prompt with a marker longer than any backtick run and preserves its bytes", () => {
    const prompt = "line one\n````\nnot closed ```` here\n  indented | pipe <b>";
    const text = renderFullReport(inputOf([pairOf("r001")], { task: { ...inputOf([]).task, prompt } }));
    expect(text).toContain(`\`\`\`\`\`text\n${prompt}\n\`\`\`\`\``);
  });

  it("makes anchors unique when a pair label collides with a section heading", () => {
    const text = renderFullReport(inputOf([pairOf("results"), pairOf("results")]));
    expect(text).toContain("| [results](#results-1) |");
    expect(text).toContain("| [results](#results-2) |");
    expect(text).toContain("[Results](#results)");
  });

  it("explains missing frozen inputs and unknown metadata explicitly", () => {
    const text = renderFullReport(
      inputOf([pairOf("r001")], {
        task: { ...inputOf([]).task, prompt: null, frozenUnavailableReason: "frozen input snapshot is not available", caseVersion: null, allowedTools: null, outputPath: null },
        integrity: { treeSha256: null, fileSha256: null },
      }),
    );
    expect(text).toContain("Frozen inputs unavailable: frozen input snapshot is not available.");
    expect(text).not.toContain("**Prompt (verbatim)**");
    expect(text).toContain("| Allowed tools | n/a (not recorded) |");
    expect(text).toContain("| Run hash (manifest tree sha256) | n/a (not recorded) |");
  });

  it("links the optional case documentation only when a target is supplied, and asserts no determinism", () => {
    const withDoc = renderFullReport(inputOf([pairOf("r001")], { task: { ...inputOf([]).task, docUrl: "https://github.com/o/r/blob/HEAD/eval-cases/case-x/README.md" } }));
    expect(withDoc).toContain("[Current case documentation](https://github.com/o/r/blob/HEAD/eval-cases/case-x/README.md)");
    const without = renderFullReport(inputOf([pairOf("r001")]));
    expect(without).not.toContain("Current case documentation");
    expect(without).not.toMatch(/determinis|--from|guarantee/i);
    expect(without).toContain("Answers are not expected to be identical between runs");
  });
});
