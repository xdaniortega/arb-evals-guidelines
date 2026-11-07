/**
 * Verified-input adapter for the skill summary (`EVALS.md`).
 *
 * The one place where a verified `RunReport` (plus its frozen task text) becomes the typed
 * `SummaryDocument` consumed by the pure renderer. Both the run-folder export and `--to`
 * publication go through it, so they cannot drift apart. The only I/O is the verified
 * `readFrozenInputs` reader, supplied by the caller as an already-read value.
 */

import type { Rubric, RubricCheck, RubricScore } from "../runner/rubric.ts";
import { formatModelLabel } from "./model-label.ts";
import { conditionCheckResults } from "./queries.ts";
import type { ConditionReport, PairReport, RunReport } from "./queries.ts";
import { formatSummaryScoreChange } from "./scored-report.ts";
import type { ScoredReportModel, SummaryDocument, SummaryEntry, SummaryOutcomeRow } from "./scored-report.ts";

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Mean of the values, or `null` when any value is unavailable (a missing pair is never dropped). */
function meanOrNull(values: readonly (number | null)[]): number | null {
  if (values.length === 0 || values.some((v) => v === null || !Number.isFinite(v))) return null;
  return (values as number[]).reduce((a, b) => a + b, 0) / values.length;
}

interface OutcomeUnit {
  readonly label: string;
  readonly max: number;
  /** Points one arm of one rendered pair earned for this unit, or `null` when not verifiable. */
  readonly pointsOf: (condition: ConditionReport) => number | null;
}

const scoreOf = (condition: ConditionReport | undefined): RubricScore | null =>
  condition !== undefined && condition.gradeable ? (condition.rubricScore ?? null) : null;

function checkUnit(check: RubricCheck): OutcomeUnit {
  return {
    label: check.id,
    max: check.points,
    pointsOf: (condition) => {
      const result = conditionCheckResults(condition)?.find((r) => r.id === check.id);
      return result === undefined ? null : result.passed ? check.points : 0;
    },
  };
}

/**
 * Display units of the Outcome Checks table, in rubric order: a topic whose declared checks
 * are all outcome checks is one row (its frozen label and points); a mixed topic contributes
 * its individual outcome checks; constraint-only topics are excluded; ungrouped outcome checks
 * follow, one row each. Individual checks keep their declared ID as the label.
 */
function outcomeUnits(rubric: Rubric): OutcomeUnit[] {
  const units: OutcomeUnit[] = [];
  for (const topic of rubric.topics ?? []) {
    const members = rubric.checks.filter((c) => c.topic === topic.id);
    const outcome = members.filter((c) => c.group === "outcome");
    if (outcome.length === 0) continue;
    if (outcome.length === members.length) {
      units.push({
        label: topic.label,
        max: topic.points,
        pointsOf: (condition) => scoreOf(condition)?.topics.find((t) => t.id === topic.id)?.got ?? null,
      });
    } else {
      units.push(...outcome.map(checkUnit));
    }
  }
  units.push(...rubric.checks.filter((c) => c.group === "outcome" && c.topic === undefined).map(checkUnit));
  return units;
}

function conditionOf(pair: PairReport, armId: "baseline" | "treatment"): ConditionReport | undefined {
  return pair.conditions.find((c) => c.conditionId === armId);
}

/** Mean points per unit for one arm across the rendered pairs, plus the unrounded unit sum. */
function armOutcome(
  units: readonly OutcomeUnit[],
  pairs: readonly PairReport[],
  armId: "baseline" | "treatment",
): { readonly points: (number | null)[]; readonly sum: number | null } {
  const points = units.map((unit) =>
    meanOrNull(
      pairs.map((pair) => {
        const condition = conditionOf(pair, armId);
        return condition === undefined ? null : unit.pointsOf(condition);
      }),
    ),
  );
  return { points, sum: points.some((p) => p === null) ? null : (points as number[]).reduce((a, b) => a + b, 0) };
}

/**
 * Projects the verified outcome checks of the rendered pairs. Fails closed when the rows do
 * not agree with the sealed Outcome group total: points are never redistributed to force a sum.
 */
export function projectOutcomeChecks(
  rubric: Rubric,
  pairs: readonly PairReport[],
): { readonly rows: readonly SummaryOutcomeRow[]; readonly totals: { readonly baseline: number | null; readonly treatment: number | null }; readonly max: number } {
  const units = outcomeUnits(rubric);
  const arms = { baseline: armOutcome(units, pairs, "baseline"), treatment: armOutcome(units, pairs, "treatment") };
  const max = rubric.checks.filter((c) => c.group === "outcome").reduce((sum, c) => sum + c.points, 0);
  const totalOf = (armId: "baseline" | "treatment"): number | null => {
    const group = meanOrNull(pairs.map((pair) => scoreOf(conditionOf(pair, armId))?.groups.outcome.got ?? null));
    const sum = arms[armId].sum;
    // Absolute tolerance: per-unit means and the group mean differ only by float drift.
    if (group !== null && sum !== null && Math.abs(group - sum) > 1e-9) {
      throw new Error(`outcome checks (${round1(sum)}) do not agree with the sealed ${armId} Outcome total (${round1(group)})`);
    }
    return group === null ? null : round1(group);
  };
  const totals = { baseline: totalOf("baseline"), treatment: totalOf("treatment") };
  const rows = units.map((unit, index): SummaryOutcomeRow => {
    const b = arms.baseline.points[index]!;
    const t = arms.treatment.points[index]!;
    return { label: unit.label, max: unit.max, baseline: b === null ? null : round1(b), treatment: t === null ? null : round1(t) };
  });
  return { rows, totals, max };
}

export interface SummaryEntryInput {
  readonly report: RunReport;
  readonly scored: ScoredReportModel;
  /** Frozen prompt from the verified reader, or `null` when unavailable. */
  readonly frozenPrompt: string | null;
  readonly reportUrl: string;
}

/** Builds one summary entry from a verified, graded report. */
export function buildSummaryEntry(input: SummaryEntryInput): SummaryEntry {
  const { report, scored } = input;
  const rubric = scored.rubric;
  if (report.receiptManifest?.treeSha256 === undefined) {
    throw new Error(`verified receipt of run ${report.runId} carries no manifest tree hash; refusing to render the summary`);
  }
  if (rubric === undefined) throw new Error(`no frozen rubric available for run ${report.runId}`);
  const rendered = report.pairs.filter((pair) => scored.pairIds.includes(pair.pairId));
  const outcome = projectOutcomeChecks(rubric, rendered);
  const prompt = input.frozenPrompt !== null && input.frozenPrompt.trim() !== "" ? input.frozenPrompt : null;
  const scenario = report.caseScenario ?? rubric.display?.scenario ?? null;
  const { accuracy, cost, latency } = scored.pillars;
  return {
    caseId: scored.caseId,
    caseTitle: scored.caseTitle,
    modelLabel: formatModelLabel(report.target),
    taskText: prompt ?? scenario,
    selectionMode: scored.selectionMode,
    pairLabels: scored.pairLabels,
    pairIds: scored.pairIds,
    repetitionCount: scored.repetitionCount,
    score: { baseline: accuracy.baseline, treatment: accuracy.treatment, change: formatSummaryScoreChange(accuracy.changeRaw) },
    cost: { baseline: cost.baseline, treatment: cost.treatment, change: cost.change },
    latency: { baseline: latency.baseline, treatment: latency.treatment, change: latency.change },
    outcomeRows: outcome.rows,
    outcomeTotal: { max: outcome.max, ...outcome.totals },
    reportUrl: input.reportUrl,
    runId: report.runId,
    treeSha256: report.receiptManifest.treeSha256,
    testDouble: report.testDouble,
  };
}

/** Single-entry document for one verified receipt (the only selection the CLI exports today). */
export function buildSummaryDocument(input: SummaryEntryInput): SummaryDocument {
  return { skillLabel: input.scored.skillLabel, entries: [buildSummaryEntry(input)] };
}
