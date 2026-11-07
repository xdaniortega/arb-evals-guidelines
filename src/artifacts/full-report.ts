/**
 * Pure renderer of `EVALS-FULL-REPORT.md`: the results-first document of one verified run.
 *
 * It consumes a typed `FullReportInput` assembled by `full-report-input.ts` from verified
 * evidence and formats it; it performs no I/O, never parses Markdown and never loads a
 * template. Every section is always emitted (with an explicit note when its data is not
 * available) so that anchors are deterministic. The operational record of each execution is
 * deliberately not part of this document; it stays in the sealed evidence and in
 * `eval:report --details`.
 */

import { TEST_DOUBLE_WARNING, countWord, escapeMarkdownText, uniqueSlugs } from "./scored-report.ts";

const NA = "n/a";
const NA_RECORDED = "n/a (not recorded)";

/** One display row of a two-arm table; values are final display cells, not yet escaped. */
export interface FullReportRow {
  readonly label: string;
  readonly baseline: string;
  readonly treatment: string;
  /** Rendered in bold (totals). */
  readonly bold?: boolean;
}

export interface FullReportMetricRow extends FullReportRow {
  readonly change: string;
}

export interface FullReportArm {
  /** Readable execution phrase, e.g. `task limit reached`, `completed`, `missing`. */
  readonly phrase: string;
  /** Whether the arm has a verified grade. */
  readonly graded: boolean;
  /** Score cell for the pair index (`20/100 — 20%`, a legacy scalar, or `n/a`). */
  readonly scoreCell: string;
}

export interface FullReportOutcome {
  /** Rows including the final total row; empty when `unavailable` is set. */
  readonly rows: readonly FullReportRow[];
  readonly unavailable: string | null;
}

export interface FullReportPair {
  readonly pairId: string;
  readonly label: string;
  readonly baseline: FullReportArm;
  readonly treatment: FullReportArm;
  /** Why the pair is not a valid comparison; `null` when it is. */
  readonly comparisonNote: string | null;
  /** Score composition rows with the total row last; `null` when there is no rubric score model (legacy). */
  readonly composition: readonly FullReportRow[] | null;
  readonly outcome: FullReportOutcome | null;
  readonly costLatency: readonly FullReportRow[];
  /** Whether both arms have recorded tokens and a duration (recorded or session-derived). */
  readonly resourcesRecorded: boolean;
}

export interface FullReportAggregate {
  /** `scored`: rubric v0.2 results; `legacy`: earlier scoring, never reweighted or averaged. */
  readonly mode: "scored" | "legacy";
  /** Score, cost and latency rows; `null` when no aggregate exists. */
  readonly metrics: readonly FullReportMetricRow[] | null;
  readonly scoreExplanation: string | null;
  readonly composition: readonly FullReportRow[] | null;
  readonly outcome: FullReportOutcome | null;
  /** Aggregate cost and latency rows; `null` when no aggregate exists. */
  readonly costLatency: readonly FullReportRow[] | null;
}

export interface FullReportTask {
  readonly scenario: string | null;
  readonly caseVersion: string | null;
  readonly rubricVersion: string | null;
  readonly allowedTools: string | null;
  readonly outputPath: string | null;
  /** Frozen prompt, verbatim; `null` when unavailable. */
  readonly prompt: string | null;
  readonly frozenUnavailableReason: string | null;
  /** Link to the current case README when one exists; explanatory only. */
  readonly docUrl: string | null;
  readonly outcomeMax: number | null;
  readonly constraintsMax: number | null;
  readonly checks: readonly { readonly id: string; readonly group: string; readonly topic: string; readonly points: number }[] | null;
}

export interface FullReportEnvironment {
  readonly registeredModelId: string | null;
  /** `Execution / provenance field | Recorded value` rows. */
  readonly provenance: readonly (readonly [string, string])[];
}

export interface FullReportInput {
  readonly testDouble: boolean;
  readonly legacyLabel: string | null;
  readonly caseId: string;
  readonly caseTitle: string;
  readonly runId: string;
  readonly skillLabel: string | null;
  /** Harness identity (separate from the model). */
  readonly agentLabel: string;
  readonly modelLabel: string;
  /** Every recorded pair, in recorded order. */
  readonly pairs: readonly FullReportPair[];
  readonly aggregate: FullReportAggregate;
  /** Why EVALS.md was not generated, or `null`. */
  readonly summaryRefusal: string | null;
  readonly task: FullReportTask;
  readonly environment: FullReportEnvironment;
  readonly integrity: { readonly treeSha256: string | null; readonly fileSha256: string | null };
  /** Repository-relative run folder. */
  readonly runDir: string;
  readonly reproduction: {
    readonly caseSelector: string;
    readonly model: string | null;
    readonly thinking: string | null;
    readonly repetitions: number;
  };
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

const text = (value: string): string => escapeMarkdownText(value);

function codeSpan(value: string): string {
  if (/[`\r\n]/.test(value)) return escapeMarkdownText(value);
  return `\`${value.replaceAll("|", "\\|")}\``;
}

/** Fence longer than any backtick run in the text, preserving its literal bytes. */
function fence(body: string): string[] {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const marker = "`".repeat(longest + 1);
  return [`${marker}text`, body, marker];
}

function table(headers: readonly string[], aligns: readonly ("left" | "right")[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${headers.join(" | ")} |`,
    `|${aligns.map((a) => (a === "right" ? "---:" : "---")).join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

const boldCell = (value: string, bold: boolean | undefined): string => (bold === true ? `**${value}**` : value);

function rowsTable(first: string, rows: readonly FullReportRow[]): string[] {
  return table(
    [first, "Baseline", "Treatment"],
    ["left", "right", "right"],
    rows.map((row) => [
      boldCell(text(row.label), row.bold),
      boldCell(text(row.baseline), row.bold),
      boldCell(text(row.treatment), row.bold),
    ]),
  );
}

const capitalize = (value: string): string => `${value.charAt(0).toUpperCase()}${value.slice(1)}`;

function plural(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}

// ---------------------------------------------------------------------------
// Aggregated status (derived from the pairs, never from a rendered text)
// ---------------------------------------------------------------------------

type ArmKey = "baseline" | "treatment";

function executionSummary(pairs: readonly FullReportPair[], arm: ArmKey): string {
  if (pairs.length === 0) return NA;
  const counts = new Map<string, number>();
  for (const pair of pairs) counts.set(pair[arm].phrase, (counts.get(pair[arm].phrase) ?? 0) + 1);
  if (pairs.length === 1) return capitalize(pairs[0]![arm].phrase);
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length === 1) return `${capitalize(entries[0]![0])} in all ${pairs.length} pairs`;
  return entries
    .map(([phrase, n], index) => (index === 0 ? `${capitalize(phrase)} in ${n} of ${pairs.length} pairs` : `${phrase} in ${n}`))
    .join("; ");
}

function gradingSummary(pairs: readonly FullReportPair[], arm: ArmKey): string {
  if (pairs.length === 0) return NA;
  const graded = pairs.filter((pair) => pair[arm].graded).length;
  if (pairs.length === 1) return graded === 1 ? "Graded" : "Grading unavailable";
  if (graded === pairs.length) return `All ${pairs.length} graded`;
  if (graded === 0) return `Grading unavailable in all ${pairs.length} pairs`;
  return `Graded in ${graded} of ${pairs.length} pairs`;
}

const pairFullyGraded = (pair: FullReportPair): boolean => pair.baseline.graded && pair.treatment.graded;

function armStatusLine(arm: FullReportArm): string {
  return `${arm.phrase}, ${arm.graded ? "graded" : "grading unavailable"}`;
}

function armIndexStatus(arm: FullReportArm): string {
  return arm.graded ? capitalize(arm.phrase) : `${capitalize(arm.phrase)} (not graded)`;
}

function resultsNote(input: FullReportInput): string {
  const { pairs, aggregate } = input;
  const unit = "Recorded token totals include cached input. Latency is the time to completion or termination; a shorter duration does not by itself mean a higher Score.";
  if (pairs.length === 0) return "No pairs were recorded for this run, so there are no results to aggregate.";
  if (aggregate.mode === "legacy") {
    return `This run was scored under an earlier rubric. Aggregates are not computed and nothing is reweighted; each pair keeps its original recorded score in the Pair explorer. ${unit}`;
  }
  const complete = pairs.every(pairFullyGraded);
  if (pairs.length === 1) {
    return complete
      ? `Results of the single pair ${text(pairs[0]!.label)}. ${unit}`
      : `Results of the single pair ${text(pairs[0]!.label)}; an arm is not graded, so its Score cells show ${NA}. ${unit}`;
  }
  const recorded = pairs.filter((p) => p.resourcesRecorded).length;
  const resources =
    recorded === pairs.length
      ? ""
      : ` Token and latency means use only the pairs with a recorded value (${recorded} of ${pairs.length} pairs have both recorded for both arms).`;
  if (complete) {
    return resources === ""
      ? `Means across all ${countWord(pairs.length)} pairs. ${unit}`
      : `Score and Outcome Checks are means across all ${countWord(pairs.length)} pairs.${resources} ${unit}`;
  }
  const baseline = pairs.filter((p) => p.baseline.graded).length;
  const treatment = pairs.filter((p) => p.treatment.graded).length;
  return (
    `Grading is incomplete: Baseline is graded in ${baseline} of ${pairs.length} pairs and Treatment in ${treatment}. ` +
    "Score and Score composition are means over the graded pairs of each arm, Outcome Checks show n/a unless every pair is graded, and no Score change is computed. " +
    `Open the Pair explorer for each pair.${resources} ` +
    unit
  );
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const SECTION_HEADINGS = {
  results: "Results",
  status: "Execution status",
  composition: "Score composition",
  outcome: "Outcome Checks",
  costLatency: "Cost and latency detail",
  explorer: "Pair explorer",
  task: "Task and rubric",
  rules: "Scoring rules and interpretation",
  checks: "Frozen checks and weights",
  environment: "Execution environment",
  verify: "Verify this report",
  exportAndRuns: "Export and comparable runs",
  exportSub: "Export",
  repro: "Reproducibility",
} as const;

function outcomeLines(outcome: FullReportOutcome | null, unavailableFallback: string): string[] {
  if (outcome === null) return [unavailableFallback, ""];
  if (outcome.unavailable !== null) return [`Outcome Checks are unavailable: ${text(outcome.unavailable)}.`, ""];
  return [...rowsTable("Check", outcome.rows), ""];
}

function compositionLines(rows: readonly FullReportRow[] | null): string[] {
  if (rows === null) return ["Score composition is not available for this run: it was not scored under the current rubric.", ""];
  return [...rowsTable("Check", rows), ""];
}

function pairDetail(pair: FullReportPair, legacy: boolean): string[] {
  const lines = [
    `### ${text(pair.label)}`,
    "",
    "<details>",
    "<summary>Score, Outcome Checks, cost and latency</summary>",
    "",
    `Pair ID: ${codeSpan(pair.pairId)}`,
    "",
    `Status: Baseline: ${text(armStatusLine(pair.baseline))} · Treatment: ${text(armStatusLine(pair.treatment))}`,
    "",
  ];
  if (pair.comparisonNote !== null) lines.push(`Not a valid comparison: ${text(pair.comparisonNote)}`, "");
  lines.push("**Score composition**", "");
  if (pair.composition !== null) lines.push(...rowsTable("Check", pair.composition), "");
  else {
    lines.push(
      legacy
        ? "Not available: this pair was scored under an earlier rubric. Original recorded scores are listed in the Pair explorer table."
        : "Not available for this pair.",
      "",
    );
  }
  lines.push("**Outcome Checks**", "");
  lines.push(...outcomeLines(pair.outcome, "Not available for this pair."));
  lines.push("**Cost and latency**", "", ...rowsTable("Metric", pair.costLatency), "", "</details>", "");
  return lines;
}

/** Renders the full report; deterministic, no timestamps, no host paths. */
export function renderFullReport(input: FullReportInput): string {
  const { pairs, aggregate, task, environment, integrity } = input;
  const legacy = aggregate.mode === "legacy";
  const titleText = `${capitalize(input.caseTitle)} — Full evaluation report`;

  const headings = [
    titleText,
    SECTION_HEADINGS.results,
    SECTION_HEADINGS.status,
    SECTION_HEADINGS.composition,
    SECTION_HEADINGS.outcome,
    SECTION_HEADINGS.costLatency,
    SECTION_HEADINGS.explorer,
    ...pairs.map((pair) => pair.label),
    SECTION_HEADINGS.task,
    SECTION_HEADINGS.rules,
    SECTION_HEADINGS.checks,
    SECTION_HEADINGS.environment,
    SECTION_HEADINGS.verify,
    SECTION_HEADINGS.exportAndRuns,
    SECTION_HEADINGS.exportSub,
    SECTION_HEADINGS.repro,
  ];
  const slugs = uniqueSlugs(headings);
  const slugOf = (index: number): string => slugs[index]!;
  const SLUG = {
    results: slugOf(1),
    explorer: slugOf(6),
  };
  const afterPairs = 7 + pairs.length;
  const nav = [
    ["Results", SLUG.results],
    ["Pair explorer", SLUG.explorer],
    ["Task and rubric", slugOf(afterPairs)],
    ["Execution environment", slugOf(afterPairs + 3)],
    ["Verify this report", slugOf(afterPairs + 4)],
    ["Export and comparable runs", slugOf(afterPairs + 5)],
  ]
    .map(([label, slug]) => `[${label}](#${slug})`)
    .join(" · ");

  const lines: string[] = [];
  if (input.testDouble) lines.push(`> **Warning:** ${TEST_DOUBLE_WARNING}`, "");
  if (input.legacyLabel !== null) lines.push(`> **Warning:** ${text(input.legacyLabel)}`, "");

  lines.push(`# ${text(titleText)}`, "");
  lines.push(
    ...table(
      ["Run context", "Recorded value"],
      ["left", "left"],
      [
        ["Case", `${codeSpan(input.caseId)} — ${text(input.caseTitle)}`],
        ["Run", codeSpan(input.runId)],
        ["Skill", input.skillLabel === null ? NA_RECORDED : codeSpan(input.skillLabel)],
        ["Agent", text(input.agentLabel)],
        ["LLM model", text(input.modelLabel)],
        ["Pairs", pairs.length === 0 ? "none recorded" : pairs.map((p) => text(p.label)).join(", ")],
      ],
    ),
    "",
  );
  lines.push(
    `**Baseline** runs without the skill; **Treatment** runs with ${input.skillLabel === null ? "the evaluated skill" : codeSpan(input.skillLabel)}.`,
    "",
    nav,
    "",
  );

  // Results ---------------------------------------------------------------
  lines.push(`## ${SECTION_HEADINGS.results}`, "", resultsNote(input), "");
  if (input.summaryRefusal !== null) lines.push(`> EVALS.md was not generated: ${text(input.summaryRefusal)}.`, "");
  if (aggregate.metrics !== null) {
    lines.push(
      ...table(
        ["Metric", "Baseline", "Treatment", "Change"],
        ["left", "right", "right", "right"],
        aggregate.metrics.map((m) => [
          boldCell(text(m.label), m.bold),
          boldCell(text(m.baseline), m.bold),
          boldCell(text(m.treatment), m.bold),
          boldCell(text(m.change), m.bold),
        ]),
      ),
      "",
    );
    if (aggregate.scoreExplanation !== null) lines.push(aggregate.scoreExplanation, "");
  }

  lines.push(`### ${SECTION_HEADINGS.status}`, "");
  if (pairs.length === 0) lines.push("No executions were recorded.", "");
  else {
    lines.push(
      ...table(
        ["Condition", "Execution status", "Grading"],
        ["left", "left", "left"],
        (["baseline", "treatment"] as const).map((arm) => [
          capitalize(arm),
          text(executionSummary(pairs, arm)),
          text(gradingSummary(pairs, arm)),
        ]),
      ),
      "",
    );
  }

  lines.push(`### ${SECTION_HEADINGS.composition}`, "");
  lines.push(...compositionLines(aggregate.composition));

  lines.push(`### ${SECTION_HEADINGS.outcome}`, "");
  if (aggregate.outcome !== null && aggregate.outcome.unavailable === null) {
    const oneRun = pairs.length === 1;
    lines.push(
      oneRun
        ? "Points earned by each check in the single pair. Each row sums its frozen checks."
        : "Mean points earned by each check across the pairs. Each row sums its frozen checks; a row shows `n/a` unless every pair has a verified result for it.",
      "",
    );
  }
  lines.push(...outcomeLines(aggregate.outcome, "Outcome Checks are not available for this run."));

  lines.push(`### ${SECTION_HEADINGS.costLatency}`, "");
  if (aggregate.costLatency === null) lines.push("Not available: no aggregate exists for this run.", "");
  else lines.push(...rowsTable("Metric", aggregate.costLatency), "");

  // Pair explorer -----------------------------------------------------------
  lines.push(`## ${SECTION_HEADINGS.explorer}`, "");
  if (pairs.length === 0) {
    lines.push("No pairs were recorded for this run.", "");
  } else {
    const gradedPairs = pairs.filter(pairFullyGraded).length;
    lines.push(
      legacy
        ? `${pairs.length === 1 ? "This pair was" : "These pairs were"} scored under an earlier rubric and ${pairs.length === 1 ? "is" : "are"} not graded under rubric v0.2; each keeps its original recorded score. Open a pair for its status and resource tables.`
        : gradedPairs === pairs.length
        ? `${pairs.length === 1 ? "The pair is" : "All pairs are"} graded. Open a pair for its full scoring and resource tables.`
        : `${gradedPairs} of ${pairs.length} ${plural(pairs.length, "pair has", "pairs have")} both arms graded; ungraded arms show ${NA}. Open a pair for its status and resource tables.`,
      "",
    );
    lines.push(
      ...table(
        ["Pair", "Baseline Score", "Treatment Score", "Baseline status", "Treatment status"],
        ["left", "left", "left", "left", "left"],
        pairs.map((pair, index) => [
          `[${text(pair.label)}](#${slugOf(7 + index)})`,
          text(pair.baseline.scoreCell),
          text(pair.treatment.scoreCell),
          text(armIndexStatus(pair.baseline)),
          text(armIndexStatus(pair.treatment)),
        ]),
      ),
      "",
    );
    for (const pair of pairs) lines.push(...pairDetail(pair, legacy));
  }

  // Task and rubric ---------------------------------------------------------
  lines.push(`## ${SECTION_HEADINGS.task}`, "");
  if (task.scenario !== null) lines.push(`**Scenario:** ${text(task.scenario)}`, "");
  if (task.frozenUnavailableReason !== null) {
    lines.push(`Frozen inputs unavailable: ${text(task.frozenUnavailableReason)}.`, "");
  }
  lines.push(
    ...table(
      ["Case definition", "Recorded value"],
      ["left", "left"],
      [
        ["Case", `${text(input.caseId)}, version ${text(task.caseVersion ?? NA_RECORDED)}`],
        ["Rubric version", text(task.rubricVersion ?? NA_RECORDED)],
        ["Allowed tools", text(task.allowedTools ?? NA_RECORDED)],
        ["Output path", text(task.outputPath ?? NA_RECORDED)],
      ],
    ),
    "",
  );
  if (task.prompt !== null) lines.push("**Prompt (verbatim)**", "", ...fence(task.prompt), "");
  lines.push(
    task.docUrl === null
      ? "The frozen inputs above are authoritative. This section is explanatory only and is not evidence."
      : `[Current case documentation](${task.docUrl.replace(/[\s()<>]/g, (ch) => encodeURIComponent(ch).replace("(", "%28").replace(")", "%29"))}); the frozen inputs above are authoritative. This section is explanatory only and is not evidence.`,
    "",
  );

  lines.push(`### ${SECTION_HEADINGS.rules}`, "");
  if (task.outcomeMax === null || task.constraintsMax === null) {
    lines.push(
      "Score is the presentation name for the original Accuracy metric. This run has no scored view of a frozen rubric v0.2, so no point decomposition is available.",
      "",
    );
  } else {
    const aggregateScope =
      pairs.length > 1
        ? "Aggregate results are means over the recorded pairs; individual-pair tables report that pair only. "
        : "";
    lines.push(
      `Score is the presentation name for the original Accuracy metric: outcome points (up to ${task.outcomeMax}) plus constraints and preservation points (up to ${task.constraintsMax}). ` +
        aggregateScope +
        "Outcome Check fractions are points earned, not counts of successful runs.",
      "",
    );
  }

  lines.push(`### ${SECTION_HEADINGS.checks}`, "");
  if (task.checks === null) lines.push("Not available: this run has no scored view of a frozen rubric v0.2.", "");
  else {
    lines.push(
      ...table(
        ["Check", "Group", "Topic", "Points"],
        ["left", "left", "left", "left"],
        task.checks.map((check) => [text(check.id), text(check.group), text(check.topic), String(check.points)]),
      ),
      "",
    );
  }

  // Execution environment -----------------------------------------------------
  lines.push(`## ${SECTION_HEADINGS.environment}`, "");
  lines.push(
    ...table(
      ["Model field", "Recorded value"],
      ["left", "left"],
      [
        ["LLM model", text(input.modelLabel)],
        ["Registered model ID", environment.registeredModelId === null ? NA_RECORDED : codeSpan(environment.registeredModelId)],
      ],
    ),
    "",
  );
  lines.push(
    ...table(
      ["Execution / provenance field", "Recorded value"],
      ["left", "left"],
      environment.provenance.map(([field, value]) => [text(field), text(value)]),
    ),
    "",
  );

  // Verify --------------------------------------------------------------------
  const receipt = `${input.runDir}/receipt.json`;
  lines.push(`## ${SECTION_HEADINGS.verify}`, "");
  lines.push(
    "This file is generated and is not part of the sealed hash chain. It is tied to its run by the hashes below, which come from `receipt.json`.",
    "",
  );
  lines.push(
    ...table(
      ["Integrity field", "Recorded value"],
      ["left", "left"],
      [
        ["Run hash (manifest tree sha256)", integrity.treeSha256 === null ? NA_RECORDED : codeSpan(integrity.treeSha256)],
        ["Receipt manifest file sha256", integrity.fileSha256 === null ? NA_RECORDED : codeSpan(integrity.fileSha256)],
      ],
    ),
    "",
  );
  lines.push(
    "Recompute the evidence chain and compare the tree hash it prints with the one above:",
    "",
    ...fence(`pnpm eval:report -- --receipt ${receipt} --checks`),
    "",
  );

  // Export and comparable runs ---------------------------------------------------
  const examplePair = pairs[0]?.label ?? "<pair>";
  lines.push(`## ${SECTION_HEADINGS.exportAndRuns}`, "", `### ${SECTION_HEADINGS.exportSub}`, "");
  lines.push(
    "The first command (re)generates `EVALS.md` and `EVALS-FULL-REPORT.md` inside this run folder. `--to` additionally copies the summary into a directory. **`EVALS.md` is the file to export or copy into the skills repository.** `EVALS-FULL-REPORT.md` stays in this repository.",
    "",
    ...fence(
      [
        `pnpm eval:export -- --receipt ${receipt}`,
        `pnpm eval:export -- --receipt ${receipt} --to <output_dir>`,
        `pnpm eval:export -- --receipt ${receipt} --to <output_dir> --pair ${examplePair}`,
      ].join("\n"),
    ),
    "",
  );
  const repro = input.reproduction;
  lines.push(`### ${SECTION_HEADINGS.repro}`, "", "A comparable new run:", "");
  lines.push(
    ...fence(
      `pnpm eval -- --case ${repro.caseSelector} --skill <path_to_skill> --model ${repro.model ?? "<model>"} --thinking ${repro.thinking ?? "<thinking>"} --repetitions ${repro.repetitions > 0 ? repro.repetitions : "<repetitions>"}`,
    ),
    "",
  );
  lines.push(
    "Answers are not expected to be identical between runs; a new run measures the same task again and is compared with this one, not matched to it.",
    "",
  );

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
