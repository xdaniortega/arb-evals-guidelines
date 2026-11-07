/**
 * Verified-input adapter for `EVALS-FULL-REPORT.md`.
 *
 * Turns an already verified `RunReport` (plus the verified frozen inputs and one scored view
 * per recorded pair) into the typed `FullReportInput` consumed by the pure renderer. Scores,
 * checks and weights come from the existing scored model and the frozen rubric; nothing is
 * recovered by parsing rendered text, and no value is invented for missing evidence.
 */

import { lstat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertSafeRelativePath } from "../core/experiment.ts";
import { normalizeRepositoryUrl } from "../core/report-links.ts";
import type { Rubric } from "../runner/rubric.ts";
import { renderFullReport } from "./full-report.ts";
import type {
  FullReportAggregate,
  FullReportArm,
  FullReportInput,
  FullReportMetricRow,
  FullReportOutcome,
  FullReportPair,
  FullReportRow,
  FullReportTask,
} from "./full-report.ts";
import { formatLimits, readFrozenInputs } from "./queries.ts";
import type { ConditionReport, PairReport, RunReport, SealedFrozenInputsResult } from "./queries.ts";
import { buildScoredReport, executionPhrase, formatPoints, formatSummaryScoreChange, LEGACY_RESULT_LABEL } from "./scored-report.ts";
import type { ScoredReportModel, ScoredRow } from "./scored-report.ts";
import { formatModelLabel } from "./model-label.ts";
import { projectOutcomeChecks } from "./summary-entry.ts";

const NA = "n/a";
const NA_RECORDED = "n/a (not recorded)";
const MINUS = "−";

const conditionOf = (pair: PairReport, armId: "baseline" | "treatment"): ConditionReport | undefined =>
  pair.conditions.find((c) => c.conditionId === armId);

function pairLabel(pairId: string): string {
  return pairId.slice(pairId.lastIndexOf("-") + 1);
}

const toRow = (row: ScoredRow): FullReportRow => ({ label: row.label, baseline: row.baseline, treatment: row.treatment });

function legacyScoreCell(condition: ConditionReport | undefined): string {
  if (condition === undefined || !condition.gradeable || condition.score === null || Number.isNaN(condition.score)) return NA;
  return `${condition.score.toFixed(3)} (original scale)`;
}

function armOf(condition: ConditionReport | undefined, legacy: boolean, model: ScoredReportModel | null, armId: "baseline" | "treatment"): FullReportArm {
  const graded =
    condition !== undefined && condition.gradeable && (legacy ? condition.score !== null : (condition.rubricScore ?? null) !== null);
  const scoreCell = legacy
    ? legacyScoreCell(condition)
    : ((armId === "baseline" ? model?.baselineAccuracy : model?.treatmentAccuracy)?.total.formatted ?? NA);
  return { phrase: executionPhrase(condition), graded, scoreCell };
}

/** Score composition rows (groups, then the Score total) from a scored model. */
function compositionRows(model: ScoredReportModel): readonly FullReportRow[] | null {
  if (model.isLegacy || model.baselineAccuracy == null || model.treatmentAccuracy == null) return null;
  return [
    ...model.accuracyTable.rows.map(toRow),
    {
      label: "Score total",
      baseline: model.baselineAccuracy.total.formatted,
      treatment: model.treatmentAccuracy.total.formatted,
      bold: true,
    },
  ];
}

function outcomeOf(rubric: Rubric | null, pairs: readonly PairReport[]): FullReportOutcome | null {
  if (rubric === null) return null;
  if (!rubric.checks.some((check) => check.group === "outcome")) return { rows: [], unavailable: "the frozen rubric declares no outcome checks" };
  try {
    const projection = projectOutcomeChecks(rubric, pairs);
    return {
      rows: [
        ...projection.rows.map((row): FullReportRow => ({
          label: row.label,
          baseline: formatPoints(row.baseline, row.max),
          treatment: formatPoints(row.treatment, row.max),
        })),
        {
          label: "Outcome total",
          baseline: formatPoints(projection.totals.baseline, projection.max),
          treatment: formatPoints(projection.totals.treatment, projection.max),
          bold: true,
        },
      ],
      unavailable: null,
    };
  } catch (cause) {
    return { rows: [], unavailable: cause instanceof Error ? cause.message : "the check rows could not be verified" };
  }
}

/** Dynamic percentage-point explanation of the Score change; never relative growth. */
export function scoreExplanation(
  accuracy: { readonly baseline: string; readonly treatment: string; readonly changeRaw: number | null },
  complete: boolean,
): string {
  if (!complete) {
    return "The Score change is not shown because grading is incomplete, so the aggregate cannot be compared as a valid difference. See the Pair explorer for each pair.";
  }
  if (accuracy.changeRaw === null || !Number.isFinite(accuracy.changeRaw)) {
    return "The Score change is unavailable because an arm has no verified Score.";
  }
  const rounded = Math.round(accuracy.changeRaw * 10) / 10;
  const magnitude = Number.isInteger(rounded) ? String(Math.abs(rounded)) : Math.abs(rounded).toFixed(1);
  if (rounded === 0) {
    return `The Score change is **0%**, meaning **0 percentage points** (${accuracy.treatment} ${MINUS} ${accuracy.baseline}). This is the arithmetic score difference, not relative percentage growth. Token and latency changes retain their absolute and relative forms.`;
  }
  const unit = magnitude === "1" ? "percentage point" : "percentage points";
  return (
    `The overview displays the Score change as **${formatSummaryScoreChange(accuracy.changeRaw)}**, meaning ${rounded > 0 ? "an increase" : "a decrease"} of **${magnitude} ${unit}** ` +
    `(${accuracy.treatment} ${MINUS} ${accuracy.baseline}). This is the arithmetic score difference, not relative percentage growth. Token and latency changes retain their absolute and relative forms.`
  );
}

function buildAggregate(report: RunReport, rubric: Rubric | null, pairs: readonly FullReportPair[]): FullReportAggregate {
  const scored = report.scored;
  if (report.isLegacy) {
    return { mode: "legacy", metrics: null, scoreExplanation: null, composition: null, outcome: null, costLatency: null };
  }
  if (scored === null || scored === undefined) {
    return { mode: "scored", metrics: null, scoreExplanation: null, composition: null, outcome: null, costLatency: null };
  }
  const complete = pairs.every((pair) => pair.baseline.graded && pair.treatment.graded);
  const { accuracy, cost, latency } = scored.pillars;
  const metrics: FullReportMetricRow[] = [
    {
      label: "Score",
      baseline: accuracy.baseline,
      treatment: accuracy.treatment,
      change: complete ? formatSummaryScoreChange(accuracy.changeRaw) : NA,
    },
    { label: cost.label, baseline: cost.baseline, treatment: cost.treatment, change: cost.change },
    { label: latency.label, baseline: latency.baseline, treatment: latency.treatment, change: latency.change },
  ];
  return {
    mode: "scored",
    metrics,
    scoreExplanation: scoreExplanation(accuracy, complete),
    composition: compositionRows(scored),
    outcome: outcomeOf(rubric, report.pairs),
    costLatency: scored.costLatencyTable.rows.map(toRow),
  };
}

export async function caseDocUrl(report: RunReport, repoUrl: string): Promise<string | null> {
  try {
    const caseDir = dirname(dirname(report.runDir));
    if (basename(caseDir) !== report.caseId) return null;
    const stat = await lstat(join(caseDir, "README.md")).catch(() => null);
    if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return null;
    const relative = assertSafeRelativePath(`eval-cases/${report.caseId}/README.md`, "caseDoc");
    return `${normalizeRepositoryUrl(repoUrl)}/blob/HEAD/${relative}`;
  } catch {
    return null;
  }
}

function buildTask(
  report: RunReport,
  rubric: Rubric | null,
  frozen: SealedFrozenInputsResult,
  docUrl: string | null,
): FullReportTask {
  const config = frozen.caseConfig ?? {};
  const tools = Array.isArray(config.allowedTools) ? (config.allowedTools as unknown[]).map(String).join(", ") : null;
  const topics = new Map((rubric?.topics ?? []).map((topic) => [topic.id, topic.label]));
  const groupSum = (group: string): number | null =>
    rubric === null ? null : rubric.checks.filter((check) => check.group === group).reduce((sum, check) => sum + check.points, 0);
  return {
    scenario: report.caseScenario ?? rubric?.display?.scenario ?? null,
    caseVersion: config.version === undefined ? null : String(config.version),
    rubricVersion: report.rubricVersion ?? null,
    allowedTools: tools,
    outputPath: typeof config.outputPath === "string" ? config.outputPath : null,
    prompt: frozen.prompt,
    frozenUnavailableReason: !frozen.available || frozen.prompt === null ? (frozen.reason ?? "not recorded") : null,
    docUrl,
    outcomeMax: groupSum("outcome"),
    constraintsMax: groupSum("constraints"),
    checks:
      rubric === null
        ? null
        : rubric.checks.map((check) => ({
            id: check.id,
            group: check.group,
            topic: check.topic === undefined ? "" : (topics.get(check.topic) ?? check.topic),
            points: check.points,
          })),
  };
}

/** Planned repetitions sealed in the receipt; the recorded pair count only when no plan is recorded. */
function repetitionCount(report: RunReport): number {
  return report.counts?.plannedPairs ?? report.pairs.length;
}

export function buildProvenance(report: RunReport): readonly (readonly [string, string])[] {
  const digests = [
    ...new Set(report.pairs.flatMap((pair) => pair.conditions.map((c) => c.imageDigest)).filter((d): d is string => d !== null)),
  ].sort();
  const target = report.target;
  const dirty = report.source?.dirty;
  return [
    ["Evaluator source revision", `${report.source?.revision ?? NA_RECORDED}${dirty === undefined ? "" : dirty ? " (dirty working tree)" : " (clean)"}`],
    ["Evaluator build", report.evaluatorBuild ?? NA_RECORDED],
    ["Image digest(s)", digests.length === 0 ? NA_RECORDED : digests.join(", ")],
    ["Skill snapshot tree sha256", report.skillSnapshot?.treeSha256 ?? NA_RECORDED],
    ["SKILL.md sha256", report.skillSnapshot?.skillMdSha256 ?? NA_RECORDED],
    ["Provider", target?.provider ?? NA_RECORDED],
    ["Model", target?.model ?? NA_RECORDED],
    ["Thinking level", target?.thinking ?? NA_RECORDED],
    ["Limits", formatLimits(report.limits)],
    ["Repetitions", String(repetitionCount(report))],
    ["Elapsed", report.elapsedWallTime === undefined ? NA_RECORDED : report.elapsedWallTime === NA ? NA : `${report.elapsedWallTime} wall time`],
  ];
}

export interface FullReportContext {
  readonly repoUrl: string;
  /** Repository-relative run folder `eval-cases/<case>/runs/<run>`. */
  readonly runDir: string;
  /** Bare reason EVALS.md is not generated (no trailing clause), or `null`. */
  readonly summaryRefusal: string | null;
}

/** Assembles the typed full-report input from a verified report. Reads only verified frozen inputs. */
export async function buildFullReportInput(
  receiptPath: string,
  report: RunReport,
  context: FullReportContext,
  preReadFrozen?: SealedFrozenInputsResult,
): Promise<FullReportInput> {
  const frozen = preReadFrozen ?? (await readFrozenInputs(receiptPath));
  const legacy = report.isLegacy;
  const rubric = !legacy ? (report.scored?.rubric ?? null) : null;

  const pairs = report.pairs.map((pair): FullReportPair => {
    const model: ScoredReportModel | null = legacy
      ? null
      : rubric === null
        ? null
        : buildScoredReport(report, rubric, { mode: "single", pair });
    const legacyModel = legacy ? buildScoredReport(report, null, { mode: "single", pair }) : null;
    const costModel = model ?? legacyModel;
    const baseline = conditionOf(pair, "baseline");
    const treatment = conditionOf(pair, "treatment");
    return {
      pairId: pair.pairId,
      label: pairLabel(pair.pairId),
      baseline: armOf(baseline, legacy, model, "baseline"),
      treatment: armOf(treatment, legacy, model, "treatment"),
      comparisonNote: pair.valid ? null : pair.delta.reason,
      composition: model === null ? null : compositionRows(model),
      outcome: legacy ? null : outcomeOf(rubric, [pair]),
      costLatency: costModel === null ? [] : costModel.costLatencyTable.rows.map(toRow),
      resourcesRecorded: [baseline, treatment].every(
        (c) => c !== undefined && c.consumedTokens !== null && (c.durationMs ?? c.sessionDurationMs ?? null) !== null,
      ),
    };
  });

  const target = report.target;
  return {
    testDouble: report.testDouble,
    legacyLabel: legacy ? LEGACY_RESULT_LABEL : null,
    caseId: report.caseId,
    caseTitle: report.scored?.caseTitle ?? report.caseTitle ?? report.caseId,
    runId: report.runId,
    skillLabel: report.skillSourcePath ? basename(report.skillSourcePath) : null,
    agentLabel: report.harnessId ? (report.harnessId === "pi" ? "Pi" : report.harnessId) : NA_RECORDED,
    modelLabel: formatModelLabel(target),
    pairs,
    aggregate: buildAggregate(report, rubric, pairs),
    summaryRefusal: context.summaryRefusal,
    task: buildTask(report, rubric, frozen, await caseDocUrl(report, context.repoUrl)),
    environment: {
      registeredModelId: target === undefined ? null : `${target.provider}/${target.model}`,
      provenance: buildProvenance(report),
    },
    integrity: {
      treeSha256: report.receiptManifest?.treeSha256 ?? null,
      fileSha256: report.receiptManifest?.fileSha256 ?? null,
    },
    runDir: context.runDir,
    reproduction: {
      caseSelector: report.caseSelector,
      model: target?.model ?? null,
      thinking: target?.thinking ?? null,
      repetitions: repetitionCount(report),
    },
  };
}

/** Builds the input and renders the full report in one step. */
export async function renderFullReportForRun(
  receiptPath: string,
  report: RunReport,
  context: FullReportContext,
  preReadFrozen?: SealedFrozenInputsResult,
): Promise<string> {
  return renderFullReport(await buildFullReportInput(receiptPath, report, context, preReadFrozen));
}
