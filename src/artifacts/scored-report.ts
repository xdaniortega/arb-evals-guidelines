/**
 * Pure shared scored-report model and renderers (terminal, Markdown, JSON) for rubric v0.2.
 *
 * Host-side only: this module defines the unified scored-report representation
 * derived from sealed run evidence (inputs/rubric.json and validation.json), and
 * renders it consistently: the terminal summary shows the same sections, labels and
 * values as the published EVALS.md.
 *
 * Accuracy = Outcome correctness and completeness (80) + Constraints and preservation (20).
 * Cost = recorded tokens; Latency = duration. Every cell comes from sealed evidence or is `n/a`.
 */

import { basename } from "node:path";
import { ACCURACY_GROUPS, RUBRIC_GROUPS } from "../runner/rubric.ts";
import type { Rubric, RubricGroupId, RubricScore } from "../runner/rubric.ts";
import type { ConditionId } from "../core/types.ts";
import type { ConditionReport, PairReport, RunReport } from "./queries.ts";

/**
 * Resolved rendering selection for a run's pair(s): either one selected pair
 * (rendered exactly like today's single-pair output), or the mean over every
 * pair (default when a run has more than one and none was named with `--pair`).
 */
export type PairSelection =
  | { readonly mode: "single"; readonly pair: PairReport | undefined }
  | { readonly mode: "mean"; readonly pairs: readonly PairReport[] };

export const REPORT_JSON_SCHEMA_VERSION = 3;
export const LEGACY_RESULT_LABEL = "LEGACY RESULT — scored under an earlier rubric; not reweighted";
export const SESSION_DERIVED_LABEL = "session-derived";
export const OUTCOME_CHECKS_HEADING = "Accuracy Outcome Checks";
export const TEST_DOUBLE_WARNING = "TEST-DOUBLE EVIDENCE — synthetic scores, not a measured result";

const MINUS = "−";
const NA = "n/a";
const NA_LEGACY = "n/a (legacy run)";

export interface ScoredCell {
  readonly got: number | null;
  readonly max: number;
  readonly formatted: string;
}

export interface ScoredArmAccuracy {
  readonly total: ScoredCell;
  readonly outcome: ScoredCell;
  readonly constraints: ScoredCell;
  readonly topics: readonly (ScoredCell & { readonly id: string; readonly label: string })[];
}

export interface ScoredRow {
  readonly label: string;
  readonly baseline: string;
  readonly treatment: string;
}

export interface ScoredPillars {
  readonly accuracy: ScoredRow & {
    readonly change: string;
    readonly baselineRaw: number | null;
    readonly treatmentRaw: number | null;
    readonly changeRaw: number | null;
  };
  readonly cost: ScoredRow & {
    readonly change: string;
    readonly baselineRaw: number | null;
    readonly treatmentRaw: number | null;
    readonly changeRaw: number | null;
    readonly changePercentRaw: number | null;
  };
  readonly latency: ScoredRow & {
    readonly change: string;
    readonly baselineRawMs: number | null;
    readonly treatmentRawMs: number | null;
    readonly changeRawMs: number | null;
    readonly changePercentRaw: number | null;
    readonly baselineSessionDerived: boolean;
    readonly treatmentSessionDerived: boolean;
    readonly approximate: boolean;
  };
}

export interface ScoredAccuracyTable {
  readonly rows: readonly ScoredRow[];
  readonly totalRow: ScoredRow;
}

export interface ScoredChecksRow extends ScoredRow {
  readonly id: string;
  readonly max: number;
  readonly baselineRaw: number | null;
  readonly treatmentRaw: number | null;
}

export interface ScoredChecksTable {
  readonly heading: string;
  readonly note: string;
  readonly rows: readonly ScoredChecksRow[];
  readonly totalRow: ScoredRow;
}

export interface ScoredCostLatencyTable {
  readonly rows: readonly ScoredRow[];
}

export interface ScoredReportModel {
  readonly runId: string;
  readonly pairId: string;
  readonly pairLabel: string;
  readonly caseSelector: string;
  readonly caseId: string;
  readonly caseTitle: string;
  readonly caseScenario: string;
  readonly agentLabel: string;
  readonly skillLabel: string;
  readonly status: string;
  readonly statusLine: string;
  readonly badgeUrl: string;
  readonly badgeAlt: string;
  readonly rubricVersion?: string;
  readonly isLegacy: boolean;
  readonly legacyLabel?: string;
  readonly rubric?: Rubric;
  readonly observationLabel: string;
  readonly repetitionCount: number;
  readonly validPairCount: number;
  /** "single" for one rendered pair, "mean" when the tables hold the mean of every pair. */
  readonly selectionMode: "single" | "mean";
  /** Short labels of the rendered pair(s): `["r001"]` or `["r001", "r002", "r003"]`. */
  readonly pairLabels: readonly string[];
  /** Full pair IDs of the rendered pair(s), same order as `pairLabels`. */
  readonly pairIds: readonly string[];

  readonly pillars: ScoredPillars;
  readonly accuracyTable: ScoredAccuracyTable;
  readonly checksTable?: ScoredChecksTable;
  readonly costLatencyTable: ScoredCostLatencyTable;

  readonly baselineAccuracy?: ScoredArmAccuracy | null;
  readonly treatmentAccuracy?: ScoredArmAccuracy | null;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Formats a duration. `< 60 s` → `45.2s` (precise `45.213s`); `≥ 60 s` → `3m34s`
 * (precise `3m33.947s`); `≥ 1 h` → `1h02m10s` (precise `1h02m10.123s`).
 */
export function formatDuration(ms: number | null, options: { readonly precise?: boolean } = {}): string {
  if (ms === null || !Number.isFinite(ms)) return NA;
  const abs = Math.abs(ms);
  const sign = ms < 0 ? MINUS : "";
  if (options.precise) {
    if (abs < 60_000) return `${sign}${(abs / 1000).toFixed(3)}s`;
    const wholeMs = Math.round(abs);
    const hours = Math.floor(wholeMs / 3_600_000);
    const minutes = Math.floor((wholeMs % 3_600_000) / 60_000);
    const seconds = ((wholeMs % 60_000) / 1000).toFixed(3).padStart(6, "0");
    return hours > 0 ? `${sign}${hours}h${pad2(minutes)}m${seconds}s` : `${sign}${minutes}m${seconds}s`;
  }
  if (abs < 59_950) return `${sign}${(abs / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(abs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${sign}${hours}h${pad2(minutes)}m${pad2(seconds)}s` : `${sign}${minutes}m${pad2(seconds)}s`;
}

/** Latency in whole milliseconds, always: `191,000 ms`. */
export function formatLatencyMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return NA;
  const rounded = Math.round(Math.abs(ms));
  return `${ms < 0 && rounded !== 0 ? MINUS : ""}${rounded.toLocaleString("en-US")} ms`;
}

function formatPercentChange(baseline: number, treatment: number): string {
  if (baseline === 0) return NA;
  const pct = ((treatment - baseline) / baseline) * 100;
  const text = Math.abs(pct).toFixed(1);
  if (text === "0.0") return "0.0%";
  return pct > 0 ? `+${text}%` : `${MINUS}${text}%`;
}

/** Latency change in ms: `−157,000 ms (−82.2%)`, with `, approximate` when either side is session-derived. */
export function formatDurationDiff(
  baselineMs: number | null,
  treatmentMs: number | null,
  options: { readonly approximate?: boolean } = {},
): string {
  if (baselineMs === null || treatmentMs === null || !Number.isFinite(baselineMs) || !Number.isFinite(treatmentMs)) {
    return NA;
  }
  const diffMs = treatmentMs - baselineMs;
  const magnitude = formatLatencyMs(Math.abs(diffMs));
  const diff = magnitude === "0 ms" ? "0 ms" : diffMs > 0 ? `+${magnitude}` : `${MINUS}${magnitude}`;
  const suffix = options.approximate ? ", approximate" : "";
  return `${diff} (${formatPercentChange(baselineMs, treatmentMs)}${suffix})`;
}

export function formatTokens(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens)) return NA;
  return Math.round(tokens).toLocaleString("en-US");
}

/** Token change: `+90,020 (+18.8%)`. */
export function formatTokenDiff(baseline: number | null, treatment: number | null): string {
  if (baseline === null || treatment === null || !Number.isFinite(baseline) || !Number.isFinite(treatment)) {
    return NA;
  }
  const diff = Math.round(treatment) - Math.round(baseline);
  const diffStr = diff > 0 ? `+${diff.toLocaleString("en-US")}` : diff < 0 ? `${MINUS}${Math.abs(diff).toLocaleString("en-US")}` : "0";
  return `${diffStr} (${formatPercentChange(Math.round(baseline), Math.round(treatment))})`;
}

/** Accuracy change: `+60 percentage points`. */
export function formatSignedAccuracyDiff(diff: number | null): string {
  if (diff === null || !Number.isFinite(diff)) return NA;
  const rounded = Math.round(diff * 10) / 10;
  const display = Number.isInteger(rounded) ? String(Math.abs(rounded)) : Math.abs(rounded).toFixed(1);
  if (rounded > 0) return `+${display} percentage points`;
  if (rounded < 0) return `${MINUS}${display} percentage points`;
  return "0 percentage points";
}

/** Readable execution status of one arm, e.g. `task limit reached` or `interrupted`. */
function executionPhrase(condition: ConditionReport | undefined): string {
  if (condition === undefined) return "missing";
  switch (condition.status) {
    case "completed":
      return "completed";
    case "task-limit":
      return "task limit reached";
    case "not-started":
      return "not started";
    case "infrastructure-failure":
      return condition.stopCause === "external-cancellation" ? "interrupted" : "infrastructure failure";
    default:
      return condition.status;
  }
}

function badgeStatus(condition: ConditionReport | undefined, fallback: string): { text: string; color: string } {
  const phrase = condition === undefined ? fallback : (MEAN_ARM_STATUS.get(condition)?.badgePhrase ?? executionPhrase(condition));
  switch (phrase) {
    case MIXED_STATUS:
      return { text: MIXED_STATUS, color: "yellow" };
    case "completed":
      return { text: "completed", color: "blue" };
    case "task limit reached":
      return { text: "task limit", color: "yellow" };
    case "interrupted":
      return { text: "interrupted", color: "orange" };
    case "infrastructure failure":
      return { text: "infrastructure failure", color: "red" };
    default:
      return { text: phrase, color: "lightgrey" };
  }
}

const shieldsEscape = (text: string): string => encodeURIComponent(text.replaceAll("-", "--").replaceAll("_", "__"));

/** Shields badge `AF-Evaluation | <status> · <treatment accuracy>%`. */
export function generateBadge(
  condition: ConditionReport | undefined,
  fallbackStatus: string,
  accuracy: number | null,
): { readonly url: string; readonly alt: string } {
  const { text, color } = badgeStatus(condition, fallbackStatus);
  const message = accuracy === null ? text : `${text} · ${Math.round(accuracy)}%`;
  return {
    url: `https://img.shields.io/badge/AF--Evaluation-${shieldsEscape(message)}-${color}`,
    alt: `AF-Evaluation: ${message}`,
  };
}

// ---------------------------------------------------------------------------
// Model builder
// ---------------------------------------------------------------------------

const percentOf = (got: number, max: number): number => (max > 0 ? Math.round((got / max) * 100) : 0);
const cell = (got: number | null, max: number, withPercent: boolean): ScoredCell => ({
  got,
  max,
  formatted: got === null ? NA : withPercent ? `${got}/${max} — ${percentOf(got, max)}%` : `${got}/${max}`,
});

function buildArmAccuracy(rubric: Rubric, score: RubricScore | null): ScoredArmAccuracy {
  const groupCell = (id: RubricGroupId): ScoredCell => cell(score?.groups[id].got ?? null, ACCURACY_GROUPS[id].points, true);
  return {
    total: cell(score?.accuracyTotal ?? null, 100, true),
    outcome: groupCell("outcome"),
    constraints: groupCell("constraints"),
    topics: (rubric.topics ?? []).map((t) => ({
      id: t.id,
      label: t.label,
      ...cell(score === null ? null : (score.topics.find((st) => st.id === t.id)?.got ?? 0), t.points, false),
    })),
  };
}

function effectiveDuration(condition: ConditionReport | undefined): { ms: number | null; derived: boolean } {
  if (condition === undefined) return { ms: null, derived: false };
  const mean = MEAN_ARM_STATUS.get(condition);
  if (mean !== undefined) return { ms: condition.durationMs ?? condition.sessionDurationMs ?? null, derived: mean.derivedPairs > 0 };
  if (condition.durationMs !== null) return { ms: condition.durationMs, derived: false };
  const derived = condition.sessionDurationMs ?? null;
  return { ms: derived, derived: derived !== null };
}

// ---------------------------------------------------------------------------
// Mean aggregation across pairs (multi-pair run, no `--pair` selector)
// ---------------------------------------------------------------------------

/** Mean of the finite numeric values present; `null` when none are available. */
function meanOrNull(values: readonly (number | null | undefined)[]): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
}

const MIXED_STATUS = "mixed";

/**
 * Per-arm aggregate facts for a synthesized mean condition, keyed by that condition
 * object. Kept out of `ConditionReport` so the evidence read model is not widened.
 */
interface MeanArmStatus {
  /** Status phrase for the header, e.g. `completed` or `completed in 2 of 3 pairs, task limit reached in 1`. */
  readonly executionPhrase: string;
  /** Badge phrase: the shared phrase when every pair agrees, otherwise `mixed`. */
  readonly badgePhrase: string;
  readonly gradedPairs: number;
  readonly derivedPairs: number;
  readonly totalPairs: number;
}
const MEAN_ARM_STATUS = new WeakMap<ConditionReport, MeanArmStatus>();

/** `completed` when uniform; otherwise `completed in 2 of 3 pairs, task limit reached in 1`. */
function aggregatePhrase(phrases: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const p of phrases) counts.set(p, (counts.get(p) ?? 0) + 1);
  if (counts.size <= 1) return phrases[0] ?? "missing";
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return parts
    .map(([phrase, n], i) => (i === 0 ? `${phrase} in ${n} of ${phrases.length} pairs` : `${phrase} in ${n}`))
    .join(", ");
}

/** Rounds to one decimal place; whole means still render without a trailing `.0`. */
const round1 = (n: number): number => Math.round(n * 10) / 10;

function findCondition(pair: PairReport, conditionId: ConditionId): ConditionReport | undefined {
  return pair.conditions.find((c) => c.conditionId === conditionId);
}

/** Mean accuracy for one arm across every pair. Rubric groups and topics share the same rubric, so points/max stay fixed. */
function meanArmAccuracy(rubric: Rubric, pairs: readonly PairReport[], conditionId: ConditionId): ScoredArmAccuracy {
  const armScore = (c: ConditionReport | undefined): RubricScore | null =>
    c !== undefined && c.gradeable ? (c.rubricScore ?? null) : null;
  const scores = pairs.map((p) => armScore(findCondition(p, conditionId)));
  const meanGroupCell = (id: RubricGroupId): ScoredCell => {
    const got = meanOrNull(scores.map((s) => s?.groups[id].got ?? null));
    return cell(got === null ? null : round1(got), ACCURACY_GROUPS[id].points, true);
  };
  const totalGot = meanOrNull(scores.map((s) => s?.accuracyTotal ?? null));
  return {
    total: cell(totalGot === null ? null : round1(totalGot), 100, true),
    outcome: meanGroupCell("outcome"),
    constraints: meanGroupCell("constraints"),
    topics: (rubric.topics ?? []).map((t) => {
      const got = meanOrNull(scores.map((s) => (s === null ? null : s.topics.find((st) => st.id === t.id)?.got ?? 0)));
      return { id: t.id, label: t.label, ...cell(got === null ? null : round1(got), t.points, false) };
    }),
  };
}

/**
 * Synthesizes a mean condition for one arm across every pair, for the tables that read
 * tokens, duration and status/gradeability from a single `ConditionReport`. Accuracy is
 * aggregated separately by `meanArmAccuracy`; this only feeds cost, latency and status.
 * Status and gradeability are aggregated over every pair (see `MeanArmStatus`); the
 * remaining condition fields are copied from the first pair.
 */
function meanCondition(pairs: readonly PairReport[], conditionId: ConditionId): ConditionReport | undefined {
  const conditions = pairs.map((p) => findCondition(p, conditionId)).filter((c): c is ConditionReport => c !== undefined);
  if (conditions.length === 0) return undefined;
  const base = conditions[0]!;
  const meanTokens = meanOrNull(conditions.map((c) => c.consumedTokens));
  const durations = conditions.map((c) => effectiveDuration(c));
  const meanMs = meanOrNull(durations.map((d) => d.ms));
  const derived = durations.some((d) => d.derived);
  const roundedMeanMs = meanMs === null ? null : Math.round(meanMs);
  const mean: ConditionReport = {
    ...base,
    consumedTokens: meanTokens === null ? null : Math.round(meanTokens),
    durationMs: derived ? null : roundedMeanMs,
    sessionDurationMs: derived ? roundedMeanMs : null,
  };
  const phrases = conditions.map((c) => executionPhrase(c));
  const uniform = new Set(phrases).size <= 1;
  MEAN_ARM_STATUS.set(mean, {
    executionPhrase: aggregatePhrase(phrases),
    badgePhrase: uniform ? (phrases[0] ?? "missing") : MIXED_STATUS,
    gradedPairs: conditions.filter((c) => c.gradeable && (c.rubricScore ?? null) !== null).length,
    derivedPairs: durations.filter((d) => d.derived).length,
    totalPairs: conditions.length,
  });
  return mean;
}

/** `session-derived`, or `session-derived in 1 of 3 pairs` for a mean mixing recorded and derived durations. */
function derivedLabel(condition: ConditionReport | undefined): string {
  const mean = condition === undefined ? undefined : MEAN_ARM_STATUS.get(condition);
  return mean !== undefined && mean.derivedPairs < mean.totalPairs
    ? `${SESSION_DERIVED_LABEL} in ${mean.derivedPairs} of ${mean.totalPairs} pairs`
    : SESSION_DERIVED_LABEL;
}

function withDerivedLabel(text: string, derived: boolean, condition?: ConditionReport): string {
  return derived && text !== NA ? `${text} (${derivedLabel(condition)})` : text;
}

/** Builds the accuracy, cost and latency pillars shared by the rubric and legacy branches. */
function buildPillars(
  baseline: ConditionReport | undefined,
  treatment: ConditionReport | undefined,
  baselineAccuracy: number | null,
  treatmentAccuracy: number | null,
): ScoredPillars {
  const accChange = baselineAccuracy !== null && treatmentAccuracy !== null ? treatmentAccuracy - baselineAccuracy : null;
  const bTokens = baseline?.consumedTokens ?? null;
  const tTokens = treatment?.consumedTokens ?? null;
  const bDuration = effectiveDuration(baseline);
  const tDuration = effectiveDuration(treatment);
  const approximate = bDuration.derived || tDuration.derived;
  const both = <T>(a: T | null, b: T | null, fn: (a: T, b: T) => number | null): number | null =>
    a !== null && b !== null ? fn(a, b) : null;
  const pct = (a: number, b: number): number | null => (a > 0 ? ((b - a) / a) * 100 : null);
  return {
    accuracy: {
      label: "Accuracy",
      baseline: baselineAccuracy !== null ? `${baselineAccuracy}%` : NA,
      treatment: treatmentAccuracy !== null ? `${treatmentAccuracy}%` : NA,
      change: formatSignedAccuracyDiff(accChange),
      baselineRaw: baselineAccuracy,
      treatmentRaw: treatmentAccuracy,
      changeRaw: accChange,
    },
    cost: {
      label: "Cost: recorded tokens",
      baseline: formatTokens(bTokens),
      treatment: formatTokens(tTokens),
      change: formatTokenDiff(bTokens, tTokens),
      baselineRaw: bTokens,
      treatmentRaw: tTokens,
      changeRaw: both(bTokens, tTokens, (a, b) => b - a),
      changePercentRaw: both(bTokens, tTokens, pct),
    },
    latency: {
      label: "Latency",
      baseline: withDerivedLabel(formatLatencyMs(bDuration.ms), bDuration.derived, baseline),
      treatment: withDerivedLabel(formatLatencyMs(tDuration.ms), tDuration.derived, treatment),
      change: formatDurationDiff(bDuration.ms, tDuration.ms, { approximate }),
      baselineRawMs: bDuration.ms,
      treatmentRawMs: tDuration.ms,
      changeRawMs: both(bDuration.ms, tDuration.ms, (a, b) => b - a),
      changePercentRaw: both(bDuration.ms, tDuration.ms, pct),
      baselineSessionDerived: bDuration.derived,
      treatmentSessionDerived: tDuration.derived,
      approximate,
    },
  };
}

function buildCostLatencyTable(baseline: ConditionReport | undefined, treatment: ConditionReport | undefined): ScoredCostLatencyTable {
  const precise = (condition: ConditionReport | undefined): string => {
    const { ms, derived } = effectiveDuration(condition);
    return withDerivedLabel(formatLatencyMs(ms), derived, condition);
  };
  return {
    rows: [
      {
        label: "Total recorded tokens, including cached input",
        baseline: formatTokens(baseline?.consumedTokens ?? null),
        treatment: formatTokens(treatment?.consumedTokens ?? null),
      },
      { label: "Time to completion or termination (ms)", baseline: precise(baseline), treatment: precise(treatment) },
    ],
  };
}

/** `Without this skill: task limit reached, graded · With this skill: completed, graded`. */
function buildStatusLine(
  baseline: ConditionReport | undefined,
  treatment: ConditionReport | undefined,
  graded: (condition: ConditionReport | undefined) => boolean,
): string {
  const phrase = (condition: ConditionReport | undefined): string => {
    const mean = condition === undefined ? undefined : MEAN_ARM_STATUS.get(condition);
    if (mean === undefined) return `${executionPhrase(condition)}, ${graded(condition) ? "graded" : "grading unavailable"}`;
    const grading =
      mean.gradedPairs === mean.totalPairs
        ? "graded"
        : mean.gradedPairs === 0
          ? "grading unavailable"
          : `graded in ${mean.gradedPairs} of ${mean.totalPairs} pairs`;
    return `${mean.executionPhrase}, ${grading}`;
  };
  const b = phrase(baseline);
  const t = phrase(treatment);
  if (b === t) {
    const cut = b.lastIndexOf(", ");
    const joined = `${b.slice(0, cut)}; ${b.slice(cut + 2)}`;
    return joined.charAt(0).toUpperCase() + joined.slice(1);
  }
  return `Without this skill: ${b} · With this skill: ${t}`;
}

const bold = (text: string): string => `**${text}**`;

export function buildScoredReport(
  report: RunReport,
  rubric: Rubric | null,
  selection: PairSelection = { mode: "single", pair: report.pairs[0] },
): ScoredReportModel {
  const isLegacy = rubric === null || report.rubricVersion === undefined;
  const isMean = selection.mode === "mean";
  // Representative single pair backing every field that isn't arm-aggregated below
  // (case/agent/skill metadata, and the legacy branch, which stays single-pair only).
  const firstPair = selection.mode === "single" ? selection.pair : selection.pairs[0];
  const pairId = firstPair?.pairId ?? `${report.runId}-r001`;
  const pairLabel = pairId.slice(pairId.lastIndexOf("-") + 1);
  const renderedPairs = selection.mode === "mean" ? selection.pairs : firstPair ? [firstPair] : [];
  const pairLabels = renderedPairs.map((p) => p.pairId.slice(p.pairId.lastIndexOf("-") + 1));
  const pairIds = renderedPairs.map((p) => p.pairId);

  const neutralFallback = report.caseSelector || report.caseId || NA;
  const caseTitle = report.caseTitle ?? rubric?.display?.title ?? neutralFallback;
  const caseScenario = report.caseScenario ?? rubric?.display?.scenario ?? neutralFallback;

  const harnessName = report.harnessId ? (report.harnessId === "pi" ? "Pi" : report.harnessId) : NA;
  const targetModel = report.target ? `${report.target.provider}/${report.target.model}` : NA;
  const agentLabel = `${harnessName} · ${targetModel}`;
  const skillLabel = report.skillSourcePath ? basename(report.skillSourcePath) : NA;

  // In mean mode, cost/latency/status read from a synthesized mean condition per arm;
  // in single mode, they read the selected pair's own condition, exactly as before.
  const baselineCond = isMean ? meanCondition(selection.pairs, "baseline") : firstPair?.conditions.find((c) => c.conditionId === "baseline");
  const treatmentCond = isMean ? meanCondition(selection.pairs, "treatment") : firstPair?.conditions.find((c) => c.conditionId === "treatment");

  const common = {
    runId: report.runId,
    pairId,
    pairLabel,
    selectionMode: selection.mode,
    pairLabels,
    pairIds,
    caseSelector: report.caseSelector,
    caseId: report.caseId,
    caseTitle,
    caseScenario,
    agentLabel,
    skillLabel,
    status: report.status,
    observationLabel: isMean
      ? `mean of ${renderedPairs.length} repetitions`
      : report.pairs.length > 1
        ? `pair ${pairLabel} of ${report.pairs.length} repetitions`
        : "single-pair observation",
    repetitionCount: report.pairs.length,
    validPairCount: report.counts?.validPairs ?? 0,
    costLatencyTable: buildCostLatencyTable(baselineCond, treatmentCond),
  };

  if (isLegacy) {
    // Legacy run: original scalar scores, never reweighted into rubric groups.
    // Legacy rendering stays single-pair only; mean aggregation is rubric v0.2 only.
    const legacyAccuracy = (c: ConditionReport | undefined): number | null =>
      c !== undefined && c.gradeable && c.score !== null ? Math.round(c.score * 100) : null;
    const baselineAcc = legacyAccuracy(baselineCond);
    const treatmentAcc = legacyAccuracy(treatmentCond);
    const badge = generateBadge(treatmentCond, report.status, treatmentAcc);
    const total = (acc: number | null): string => bold(acc !== null ? `${acc}/100 — ${acc}%` : NA);
    return {
      ...common,
      statusLine: buildStatusLine(baselineCond, treatmentCond, (c) => legacyAccuracy(c) !== null),
      badgeUrl: badge.url,
      badgeAlt: badge.alt,
      isLegacy: true,
      legacyLabel: LEGACY_RESULT_LABEL,
      pillars: buildPillars(baselineCond, treatmentCond, baselineAcc, treatmentAcc),
      accuracyTable: {
        rows: RUBRIC_GROUPS.map((id) => ({ label: ACCURACY_GROUPS[id].label, baseline: NA_LEGACY, treatment: NA_LEGACY })),
        totalRow: { label: bold("Accuracy total"), baseline: total(baselineAcc), treatment: total(treatmentAcc) },
      },
      baselineAccuracy: null,
      treatmentAccuracy: null,
    };
  }

  const armScore = (c: ConditionReport | undefined): RubricScore | null =>
    c !== undefined && c.gradeable ? (c.rubricScore ?? null) : null;
  const baselineAccuracy = isMean
    ? meanArmAccuracy(rubric, selection.pairs, "baseline")
    : buildArmAccuracy(rubric, armScore(baselineCond));
  const treatmentAccuracy = isMean
    ? meanArmAccuracy(rubric, selection.pairs, "treatment")
    : buildArmAccuracy(rubric, armScore(treatmentCond));
  const badge = generateBadge(treatmentCond, report.status, treatmentAccuracy.total.got);

  const accuracyTable: ScoredAccuracyTable = {
    rows: RUBRIC_GROUPS.map((id) => ({
      label: ACCURACY_GROUPS[id].label,
      baseline: baselineAccuracy[id].formatted,
      treatment: treatmentAccuracy[id].formatted,
    })),
    totalRow: {
      label: bold("Accuracy total"),
      baseline: bold(baselineAccuracy.total.formatted),
      treatment: bold(treatmentAccuracy.total.formatted),
    },
  };

  let checksTable: ScoredChecksTable | undefined;
  if (rubric.topics && rubric.topics.length > 0) {
    const outcomeTotal = (acc: ScoredArmAccuracy): string =>
      bold(acc.outcome.got !== null ? `${acc.outcome.got}/${acc.outcome.max}` : NA);
    checksTable = {
      heading: OUTCOME_CHECKS_HEADING,
      note: "Each check covers both production and staging.",
      rows: rubric.topics.map((t, index) => ({
        id: t.id,
        label: t.label,
        max: t.points,
        baseline: baselineAccuracy.topics[index]!.formatted,
        treatment: treatmentAccuracy.topics[index]!.formatted,
        baselineRaw: baselineAccuracy.topics[index]!.got,
        treatmentRaw: treatmentAccuracy.topics[index]!.got,
      })),
      totalRow: { label: bold("Outcome total"), baseline: outcomeTotal(baselineAccuracy), treatment: outcomeTotal(treatmentAccuracy) },
    };
  }

  return {
    ...common,
    statusLine: buildStatusLine(baselineCond, treatmentCond, (c) => armScore(c) !== null),
    badgeUrl: badge.url,
    badgeAlt: badge.alt,
    rubricVersion: rubric.rubricVersion,
    isLegacy: false,
    rubric,
    pillars: buildPillars(baselineCond, treatmentCond, baselineAccuracy.total.got, treatmentAccuracy.total.got),
    accuracyTable,
    ...(checksTable !== undefined ? { checksTable } : {}),
    baselineAccuracy,
    treatmentAccuracy,
  };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

const ARM_HEADERS = ["Without this skill", "With this skill"] as const;
const stripMd = (s: string): string => s.replaceAll("**", "");

function pillarRows(model: ScoredReportModel): (readonly string[])[] {
  return [model.pillars.accuracy, model.pillars.cost, model.pillars.latency].map((p) => [p.label, p.baseline, p.treatment, p.change]);
}

const armRow = (row: ScoredRow): readonly string[] => [row.label, row.baseline, row.treatment];

/** The header lines shared by the terminal summary and EVALS.md. */
function headerFields(model: ScoredReportModel): readonly (readonly [string, string])[] {
  return [
    ["Agent", model.agentLabel],
    ["Skill", model.skillLabel],
    [
      "Run",
      model.selectionMode === "mean"
        ? `${model.runId} · Pairs ${model.pairLabels.join(", ")}`
        : `${model.runId} · Pair ${model.pairLabel}`,
    ],
    ["Status", model.statusLine],
  ];
}

export function renderScoredMarkdown(
  model: ScoredReportModel,
  options: {
    readonly checks?: boolean;
    readonly details?: boolean;
    readonly footer?: string;
    /** First-line heading text; defaults to `EVALS.MD: <case title>`. */
    readonly heading?: string;
    /** Sealed manifest tree sha256, appended to the `Run:` line. */
    readonly runHash?: string | null;
  } = {},
): string {
  const lines: string[] = [];
  const table = markdownTable(lines);

  if (model.isLegacy) {
    lines.push(`> **Warning:** ${model.legacyLabel ?? LEGACY_RESULT_LABEL}\n`);
  }

  lines.push(`# ${options.heading ?? `EVALS.MD: ${model.caseTitle}`}\n`);
  pushHeaderBlock(lines, model, table, { runHash: options.runHash ?? null });

  lines.push("### Accuracy\n");
  table(["Check", ...ARM_HEADERS], [...model.accuracyTable.rows, model.accuracyTable.totalRow].map(armRow));

  if (options.checks && model.checksTable) {
    pushChecksSection(lines, model.checksTable, table);
  }

  lines.push("### Cost and latency\n");
  table(["Metric", ...ARM_HEADERS], model.costLatencyTable.rows.map(armRow));
  lines.pop(); // no trailing blank line after the final table

  if (options.footer) {
    lines.push("", options.footer);
  }

  return lines.join("\n");
}

/**
 * The compact EVALS.md summary: header, badge, pillars, scenario and the
 * Accuracy Outcome Checks table, then a details link (the run hash sits on the `Run:` line; no Status line).
 * No Accuracy or Cost and latency sections and no markers.
 */
export function renderScoredSummaryMarkdown(
  model: ScoredReportModel,
  options: {
    readonly detailsUrl: string;
    readonly testDouble?: boolean;
    /** Sealed manifest tree sha256 from the receipt; the line is omitted when unavailable. */
    readonly runHash?: string | null;
  },
): string {
  const lines: string[] = [];
  const table = markdownTable(lines);
  if (options.testDouble) lines.push(`> **Warning:** ${TEST_DOUBLE_WARNING}\n`);
  if (model.isLegacy) lines.push(`> **Warning:** ${model.legacyLabel ?? LEGACY_RESULT_LABEL}\n`);
  lines.push(`# EVALS.MD: ${model.caseTitle}\n`);
  pushHeaderBlock(lines, model, table, { omitStatus: true, runHash: options.runHash ?? null });
  if (model.checksTable) pushChecksSection(lines, model.checksTable, table);
  lines.push(`For further details or to check run reproducibility see: ${options.detailsUrl}`);
  return `${lines.join("\n")}\n`;
}

function markdownTable(lines: string[]) {
  return (headers: readonly string[], rows: readonly (readonly string[])[]): void => {
    lines.push(`| ${headers.join(" | ")} |`);
    lines.push(`|---|${headers.slice(1).map(() => "---:").join("|")}|`);
    for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
    lines.push("");
  };
}

function pushChecksSection(
  lines: string[],
  checks: ScoredChecksTable,
  table: (headers: readonly string[], rows: readonly (readonly string[])[]) => void,
): void {
  lines.push(`### ${checks.heading}\n`);
  lines.push(`${checks.note}\n`);
  table(["Check", ...ARM_HEADERS], [...checks.rows, checks.totalRow].map(armRow));
}

function pushHeaderBlock(
  lines: string[],
  model: ScoredReportModel,
  table: (headers: readonly string[], rows: readonly (readonly string[])[]) => void,
  options: { readonly omitStatus?: boolean; readonly runHash?: string | null } = {},
): void {
  const fields = headerFields(model)
    .filter(([label]) => !(options.omitStatus && label === "Status"))
    .map(([label, value]): readonly [string, string] =>
      label === "Run" && options.runHash ? [label, `${value} · Hash: ${options.runHash}`] : [label, value],
    );
  fields.forEach(([label, value], index) => {
    // Keep the Markdown line break on every line but the last of the full header, so the summary
    // and the full report render identical header lines.
    const keepBreak = options.omitStatus || index < fields.length - 1;
    lines.push(`${label}: ${value}${keepBreak ? "  " : ""}`);
  });
  lines.push("");
  lines.push(`![${model.badgeAlt}](${model.badgeUrl})\n`);

  table(["Pillar", ...ARM_HEADERS, "Change"], pillarRows(model));

  lines.push(`## Scenario: ${model.caseScenario}\n`);
}

/** Box-drawing table with right-aligned numeric columns; the last `totalRows` rows sit below a rule. */
function drawBox(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  options: { readonly totalRows?: number } = {},
): string {
  const cleaned = rows.map((row) => row.map(stripMd));
  const widths = headers.map((h, i) => Math.max(h.length, ...cleaned.map((r) => r[i]?.length ?? 0)));
  const border = (left: string, mid: string, right: string): string =>
    left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;
  const line = (cells: readonly string[]): string =>
    "│ " + cells.map((c, i) => (i > 0 ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join(" │ ") + " │";
  const split = cleaned.length - (options.totalRows ?? 0);
  const body = cleaned.slice(0, split).map(line);
  const totals = cleaned.slice(split).map(line);
  return [
    border("┌", "┬", "┐"),
    line(headers),
    border("├", "┼", "┤"),
    ...body,
    ...(totals.length > 0 ? [border("├", "┼", "┤"), ...totals] : []),
    border("└", "┴", "┘"),
  ].join("\n");
}

export function renderScoredTerminal(
  model: ScoredReportModel,
  options: { readonly checks?: boolean; readonly headerExtra?: readonly (readonly [string, string])[] } = {},
): string {
  const lines: string[] = [];

  if (model.isLegacy) {
    lines.push(`*** ${model.legacyLabel ?? LEGACY_RESULT_LABEL} ***`, "");
  }

  lines.push(model.caseTitle);
  for (const [label, value] of [...headerFields(model), ...(options.headerExtra ?? [])]) {
    lines.push(`${`${label}:`.padEnd(8)}${value}`);
  }
  lines.push("");

  lines.push("Evaluation pillars:");
  lines.push(drawBox(["Pillar", ...ARM_HEADERS, "Change"], pillarRows(model)));
  lines.push("");

  lines.push(`Scenario: ${model.caseScenario}`);
  lines.push("");

  lines.push("Accuracy:");
  lines.push(drawBox(["Check", ...ARM_HEADERS], [...model.accuracyTable.rows, model.accuracyTable.totalRow].map(armRow), { totalRows: 1 }));
  lines.push("");

  if (options.checks && model.checksTable) {
    const note = model.checksTable.note.replace(/\.$/, "");
    lines.push(`${model.checksTable.heading} (${note.charAt(0).toLowerCase()}${note.slice(1)}):`);
    lines.push(drawBox(["Check", ...ARM_HEADERS], [...model.checksTable.rows, model.checksTable.totalRow].map(armRow), { totalRows: 1 }));
    lines.push("");
  }

  lines.push("Cost and latency:");
  lines.push(drawBox(["Metric", ...ARM_HEADERS], model.costLatencyTable.rows.map(armRow)));

  return lines.join("\n");
}

function jsonPillars(model: ScoredReportModel): Record<string, unknown> {
  const [tokensRow, durationRow] = model.costLatencyTable.rows;
  return {
    accuracy: {
      baseline: model.pillars.accuracy.baselineRaw,
      treatment: model.pillars.accuracy.treatmentRaw,
      changePercentagePoints: model.pillars.accuracy.changeRaw,
    },
    cost: {
      baselineTokens: model.pillars.cost.baselineRaw,
      treatmentTokens: model.pillars.cost.treatmentRaw,
      tokensDelta: model.pillars.cost.changeRaw,
      tokensDeltaPercent: model.pillars.cost.changePercentRaw,
      baselineFormatted: tokensRow?.baseline ?? NA,
      treatmentFormatted: tokensRow?.treatment ?? NA,
    },
    latency: {
      baselineDurationMs: model.pillars.latency.baselineRawMs,
      treatmentDurationMs: model.pillars.latency.treatmentRawMs,
      durationDeltaMs: model.pillars.latency.changeRawMs,
      durationDeltaPercent: model.pillars.latency.changePercentRaw,
      baselineSessionDerived: model.pillars.latency.baselineSessionDerived,
      treatmentSessionDerived: model.pillars.latency.treatmentSessionDerived,
      approximate: model.pillars.latency.approximate,
      baselineReadable: model.pillars.latency.baseline,
      treatmentReadable: model.pillars.latency.treatment,
      baselinePrecise: durationRow?.baseline ?? NA,
      treatmentPrecise: durationRow?.treatment ?? NA,
    },
  };
}

export function renderScoredJson(model: ScoredReportModel): Record<string, unknown> {
  if (model.isLegacy) {
    return {
      rubricVersion: null,
      isLegacy: true,
      legacyLabel: model.legacyLabel ?? LEGACY_RESULT_LABEL,
      status: model.statusLine,
      mode: model.selectionMode,
      selectedPairId: model.pairId,
      pairIds: model.pairIds,
      repetitionCount: model.repetitionCount,
      ...jsonPillars(model),
    };
  }

  const group = (id: RubricGroupId): Record<string, unknown> => ({
    label: ACCURACY_GROUPS[id].label,
    points: ACCURACY_GROUPS[id].points,
    baseline: model.baselineAccuracy?.[id].formatted ?? NA,
    treatment: model.treatmentAccuracy?.[id].formatted ?? NA,
    baselineGot: model.baselineAccuracy?.[id].got ?? null,
    treatmentGot: model.treatmentAccuracy?.[id].got ?? null,
  });

  return {
    rubricVersion: model.rubricVersion ?? null,
    isLegacy: false,
    status: model.statusLine,
    mode: model.selectionMode,
    selectedPairId: model.pairId,
    pairIds: model.pairIds,
    repetitionCount: model.repetitionCount,
    ...jsonPillars(model),
    groups: { outcome: group("outcome"), constraints: group("constraints") },
    topics: (model.checksTable?.rows ?? []).map((r) => ({
      id: r.id,
      label: r.label,
      points: r.max,
      baseline: r.baseline,
      treatment: r.treatment,
      baselineGot: r.baselineRaw,
      treatmentGot: r.treatmentRaw,
    })),
  };
}
