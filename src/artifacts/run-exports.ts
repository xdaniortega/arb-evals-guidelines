/**
 * Run-folder exports: `EVALS.md` (summary) and `EVALS-FULL-REPORT.md` next to `receipt.json`.
 *
 * Both files are generated outputs, never evidence: they sit outside the hash chain (exact
 * root names only, see `isChainExcludedPath`), are recomputed deterministically from sealed
 * evidence plus an injected repository URL, and are bound to their run by the sealed
 * manifest hashes they embed. Rendering has no timestamps and no absolute host paths.
 */

import { lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { buildRunReportUrl } from "../core/report-links.ts";
import { EvalError } from "../core/types.ts";
import { renderFullReportForRun } from "./full-report-input.ts";
import { buildRunReport, readFrozenInputs } from "./queries.ts";
import type { RunReport, SealedFrozenInputsResult } from "./queries.ts";
import { renderScoredSummaryMarkdown } from "./scored-report.ts";
import { buildSummaryDocument } from "./summary-entry.ts";
import { VIEWS_DIR } from "./store.ts";

export const SUMMARY_FILE = "EVALS.md";
export const FULL_REPORT_FILE = "EVALS-FULL-REPORT.md";

/**
 * Repository-relative run folder `eval-cases/<caseId>/runs/<runId>`. Fails closed when the
 * report's run directory is not named after its run id, so a link can never point elsewhere.
 */
export function runRepoRelativeDir(report: Pick<RunReport, "caseId" | "runId" | "runDir">): string {
  if (basename(report.runDir) !== report.runId) {
    throw new Error(`run directory name does not match run id ${report.runId}`);
  }
  return `eval-cases/${report.caseId}/runs/${report.runId}`;
}

export interface RunExports {
  /** EVALS.md content, or `null` when export of this run would be refused. */
  readonly summary: string | null;
  readonly full: string;
  /** Why `summary` is null; `null` when it is present. */
  readonly summaryRefusal: string | null;
}

function pairLabel(pairId: string): string {
  return pairId.slice(pairId.lastIndexOf("-") + 1);
}

const SUMMARY_NOT_GENERATED = "EVALS.md is not generated";

/** Bare reason the summary cannot be exported, or `null` when every rendered pair is graded in both arms. */
function summaryRefusalReason(report: RunReport): string | null {
  if (report.isLegacy) {
    return `run ${report.runId} was scored under an earlier rubric (legacy)`;
  }
  if (!report.scored) return `no scored report model is available for run ${report.runId}`;
  for (const pair of report.pairs) {
    const ungraded = (["baseline", "treatment"] as const).filter((armId) => {
      const condition = pair.conditions.find((c) => c.conditionId === armId);
      return !(condition !== undefined && condition.gradeable && condition.rubricScore != null);
    });
    if (ungraded.length > 0) {
      return `pair ${pairLabel(pair.pairId)} has ungraded arm(s): ${ungraded.join(", ")}`;
    }
  }
  return null;
}

/**
 * Renders the skill summary of an already verified, gradeable report. The single path used by
 * both the run-folder export and `--to` publication: the frozen task text comes from the
 * verified reader, everything else from the report.
 */
export async function renderSummaryForReport(
  receiptPath: string,
  report: RunReport,
  options: { readonly repoUrl: string },
  preReadFrozen?: SealedFrozenInputsResult,
): Promise<string> {
  if (!report.scored) throw new EvalError("evidence-invalid", `no scored report model is available for run ${report.runId}`, { at: receiptPath });
  const frozen = preReadFrozen ?? (await readFrozenInputs(receiptPath));
  const reportUrl = buildRunReportUrl({ repoUrl: options.repoUrl, runRelativeDir: runRepoRelativeDir(report), target: "full-report" });
  return renderScoredSummaryMarkdown(buildSummaryDocument({ report, scored: report.scored, frozenPrompt: frozen.prompt, reportUrl }));
}

/** Renders both run-folder files from sealed evidence. Throws when the evidence does not verify. */
export async function renderRunExports(receiptPath: string, options: { readonly repoUrl: string }): Promise<RunExports> {
  const report = await buildRunReport(receiptPath);
  if (!report.verification.ok) {
    throw new EvalError(
      "evidence-invalid",
      `run exports refused: evidence verification failed for run ${report.runId}`,
      { at: receiptPath },
    );
  }
  const runDir = runRepoRelativeDir(report);
  const refusalReason = summaryRefusalReason(report);
  // One verified read of the frozen inputs serves both renderers.
  const frozen = await readFrozenInputs(receiptPath);
  const summary = refusalReason === null ? await renderSummaryForReport(receiptPath, report, options, frozen) : null;

  const full = await renderFullReportForRun(receiptPath, report, { repoUrl: options.repoUrl, runDir, summaryRefusal: refusalReason }, frozen);

  return { summary, full, summaryRefusal: refusalReason === null ? null : `${refusalReason}; ${SUMMARY_NOT_GENERATED}` };
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  return lstat(path).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  });
}

async function stageAndRename(runDir: string, name: string, content: string): Promise<void> {
  const target = join(runDir, name);
  const existing = await lstatOrNull(target);
  if (existing !== null && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new EvalError("evidence-invalid", `${name} is not a regular file; refusing to replace it`, { at: name });
  }
  const viewsDir = join(runDir, VIEWS_DIR);
  const createdViews = (await lstatOrNull(viewsDir)) === null;
  await mkdir(viewsDir, { recursive: true, mode: 0o755 });
  const staged = join(viewsDir, `.tmp-${randomBytes(6).toString("hex")}-${name}`);
  try {
    await writeFile(staged, content, { mode: 0o644, flag: "wx" });
    await rename(staged, target);
  } catch (cause) {
    await unlink(staged).catch(() => undefined);
    throw cause;
  } finally {
    if (createdViews) await rmdir(viewsDir).catch(() => undefined);
  }
}

/** Writes both files into the run folder; removes a stale EVALS.md when the summary is null. */
export async function writeRunExports(runDir: string, exports: RunExports): Promise<void> {
  await stageAndRename(runDir, FULL_REPORT_FILE, exports.full);
  if (exports.summary !== null) {
    await stageAndRename(runDir, SUMMARY_FILE, exports.summary);
    return;
  }
  const existing = await lstatOrNull(join(runDir, SUMMARY_FILE));
  if (existing !== null) {
    if (existing.isDirectory()) {
      throw new EvalError("evidence-invalid", `${SUMMARY_FILE} is not a regular file; refusing to remove it`, { at: SUMMARY_FILE });
    }
    await unlink(join(runDir, SUMMARY_FILE));
  }
}

export interface RunExportsCheck {
  readonly ok: boolean;
  /** Expected files that do not exist. */
  readonly missing: readonly string[];
  /** Files whose bytes differ from a fresh render (or are not regular files). */
  readonly stale: readonly string[];
  /** Files that must not exist (EVALS.md for a run whose export would be refused). */
  readonly unexpected: readonly string[];
}

/** Re-renders both files and compares bytes. Read-only. */
export async function checkRunExports(receiptPath: string, options: { readonly repoUrl: string }): Promise<RunExportsCheck> {
  const runDir = dirname(resolve(receiptPath));
  const expected = await renderRunExports(receiptPath, options);
  const missing: string[] = [];
  const stale: string[] = [];
  const unexpected: string[] = [];
  const wanted: ReadonlyArray<readonly [string, string | null]> = [
    [SUMMARY_FILE, expected.summary],
    [FULL_REPORT_FILE, expected.full],
  ];
  for (const [name, content] of wanted) {
    const stat = await lstatOrNull(join(runDir, name));
    if (content === null) {
      if (stat !== null) unexpected.push(name);
      continue;
    }
    if (stat === null) {
      missing.push(name);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || (await readFile(join(runDir, name), "utf8")) !== content) stale.push(name);
  }
  return { ok: missing.length + stale.length + unexpected.length === 0, missing, stale, unexpected };
}
