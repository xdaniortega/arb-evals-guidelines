/**
 * Export of verified rubric v0.2 evaluation results to a skill's EVALS.md (`pnpm eval:export --to`).
 *
 * Host-side only: strictly read-only towards evidence, strictly bounded towards
 * the destination EVALS.md file.
 *
 * Guarantees:
 * - Evidence is verified before any file mutation; refuses to publish on verification failure.
 * - The destination is always explicit (`--to`); nothing is written into this repository by default.
 * - Destination path is validated fail-closed (must remain inside canonical repository root,
 *   skill dir must exist as real directory without symlink components, no arbitrary mkdir).
 * - Results section is bounded between HTML comments and replaced idempotently.
 * - Exact marker validation fails closed on mismatched, reversed, nested, duplicate, or malformed markers.
 * - Authored coverage notes outside the markers are preserved verbatim byte-for-byte.
 * - Real status and available measurements are published; never substitutes mock scores.
 * - Both arms must be graded for every rendered pair: an ungraded arm is refused rather than
 *   published as `n/a`, or silently dropped out of a mean.
 * - A multi-pair run with no `--pair` publishes the mean over every pair; `--pair` publishes
 *   one named pair. Verification (`verifyRun`) always covers the whole run either way; pair
 *   selection only narrows what gets rendered, never what gets verified.
 * - Badges describe execution/grading status and do not claim certification.
 * - Receipt paths and operational footers remain outside EVALS.md.
 */

import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { EvalError } from "../core/types.ts";
import { buildRunReport, peekRunPairs, resolvePairSelection } from "./queries.ts";
import type { PairReport } from "./queries.ts";
import { buildRunReportUrl } from "../core/report-links.ts";
import { FULL_REPORT_FILE, SUMMARY_FILE, checkRunExports, runRepoRelativeDir } from "./run-exports.ts";
import { renderScoredSummaryMarkdown } from "./scored-report.ts";

export const EVAL_BEGIN_MARKER = "<!-- AF-EVAL:BEGIN generated -->";
export const EVAL_END_MARKER = "<!-- AF-EVAL:END generated -->";

// Whitespace-tolerant exact marker regexes
const BEGIN_MARKER_REGEX = /<!--\s*AF-EVAL:BEGIN\s+generated\s*-->/gi;
const END_MARKER_REGEX = /<!--\s*AF-EVAL:END\s+generated\s*-->/gi;

// Any HTML comment matching AF-EVAL prefix (used to detect malformed markers)
const ANY_AF_EVAL_COMMENT_REGEX = /<!--\s*AF-EVAL:[^>]*-->/gi;

function findAllMatches(content: string, regex: RegExp): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];
  const re = new RegExp(regex.source, regex.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    matches.push(match);
  }
  return matches;
}

/**
 * Resolves the default repository root from the location of this module.
 * publish.ts lives at <repo>/src/artifacts/publish.ts, so two parent
 * directory traversals yield the actual repository root.
 */
export function resolveDefaultRepoRoot(): string {
  return resolve(import.meta.dirname, "..", "..");
}

/**
 * Replaces or inserts the generated results section within stable HTML-comment markers.
 *
 * Rules:
 * - Counts exact/whitespace-tolerant BEGIN and END markers.
 * - Accepts only (0 begin, 0 end) OR (1 begin, 1 end in correct order).
 * - Rejects mismatched, reversed, nested, duplicate, or malformed markers with EvalError ("input-invalid").
 * - With one valid pair: preserves prefix and suffix byte-for-byte and replaces only the bounded span.
 * - With zero markers: preserves original authored content byte-for-byte as a contiguous substring.
 *   Inserting after H1 adds only the separators needed around the generated block without
 *   trimming or normalizing the authored remainder.
 * - Idempotency holds across multiple invocations.
 */
export function replaceGeneratedSection(originalContent: string, renderedMarkdown: string): string {
  const allAfEvalMatches = findAllMatches(originalContent, ANY_AF_EVAL_COMMENT_REGEX);
  const beginMatches = findAllMatches(originalContent, BEGIN_MARKER_REGEX);
  const endMatches = findAllMatches(originalContent, END_MARKER_REGEX);

  const beginCount = beginMatches.length;
  const endCount = endMatches.length;

  // Reject any malformed or unrecognized AF-EVAL comment marker
  if (allAfEvalMatches.length !== beginCount + endCount) {
    throw new EvalError(
      "input-invalid",
      `Malformed EVALS.md markers: found malformed or unrecognized AF-EVAL comment marker(s).`,
    );
  }

  const generatedBlock = `${EVAL_BEGIN_MARKER}\n${renderedMarkdown.trim()}\n${EVAL_END_MARKER}`;

  // Case 1: Exactly 0 BEGIN and 0 END markers -> insert
  if (beginCount === 0 && endCount === 0) {
    if (originalContent.length === 0) {
      return `${generatedBlock}\n`;
    }

    // Look for a leading top-level markdown heading: # Title
    const titleMatch = originalContent.match(/^(#[^\r\n]*(?:\r?\n|$))/);
    if (titleMatch && titleMatch[1]) {
      const heading = titleMatch[1];
      const rest = originalContent.slice(heading.length);

      const headingSep = heading.endsWith("\r\n") ? "\r\n" : heading.endsWith("\n") ? "\n" : "\n\n";

      if (rest.length === 0) {
        return `${heading}${headingSep}${generatedBlock}\n`;
      }

      let trailingSep: string;
      if (rest.startsWith("\r\n\r\n") || rest.startsWith("\n\n")) {
        trailingSep = "";
      } else if (rest.startsWith("\r\n")) {
        trailingSep = "\r\n";
      } else if (rest.startsWith("\n")) {
        trailingSep = "\n";
      } else {
        trailingSep = "\n\n";
      }

      // Preserve rest byte-for-byte; do NOT trim or normalize authored remainder
      return `${heading}${headingSep}${generatedBlock}${trailingSep}${rest}`;
    }

    // No top-level heading: prepend generated block, preserving entire original content byte-for-byte
    const nl = originalContent.includes("\r\n") ? "\r\n" : "\n";
    return `${generatedBlock}${nl}${nl}${originalContent}`;
  }

  // Case 2: Exactly 1 BEGIN and 1 END marker -> replace bounded span
  if (beginCount === 1 && endCount === 1) {
    const beginMatch = beginMatches[0];
    const endMatch = endMatches[0];

    if (!beginMatch || !endMatch) {
      throw new EvalError(
        "input-invalid",
        `Malformed EVALS.md markers: missing expected marker match.`,
      );
    }

    const beginIdx = beginMatch.index;
    const endIdx = endMatch.index;

    if (beginIdx >= endIdx) {
      throw new EvalError(
        "input-invalid",
        `Malformed EVALS.md markers: END marker appears before BEGIN marker (reversed markers).`,
      );
    }

    if (beginIdx + beginMatch[0].length > endIdx) {
      throw new EvalError(
        "input-invalid",
        `Malformed EVALS.md markers: BEGIN and END markers overlap.`,
      );
    }

    // Preserve prefix and suffix byte-for-byte and replace only the bounded span
    const prefix = originalContent.slice(0, beginIdx);
    const suffix = originalContent.slice(endIdx + endMatch[0].length);

    return `${prefix}${generatedBlock}${suffix}`;
  }

  // Case 3: Any other marker combination is malformed/ambiguous -> fail closed
  if (beginCount > 1 || endCount > 1) {
    throw new EvalError(
      "input-invalid",
      `Malformed EVALS.md markers: duplicate markers detected (found ${beginCount} BEGIN and ${endCount} END markers).`,
    );
  }
  if (beginCount === 1 && endCount === 0) {
    throw new EvalError(
      "input-invalid",
      `Malformed EVALS.md markers: unpaired BEGIN marker (found 1 BEGIN and 0 END markers).`,
    );
  }
  if (beginCount === 0 && endCount === 1) {
    throw new EvalError(
      "input-invalid",
      `Malformed EVALS.md markers: unpaired END marker (found 0 BEGIN and 1 END markers).`,
    );
  }

  throw new EvalError(
    "input-invalid",
    `Malformed EVALS.md markers: invalid marker configuration (${beginCount} BEGIN, ${endCount} END).`,
  );
}

export interface ExportOptions {
  readonly receiptPath: string;
  /** Destination: a `.md` file path, or an existing real directory (writes `<dir>/EVALS.md`). */
  readonly to: string;
  /** Normalized repository URL used to build the details link (injected; the git remote is never read). */
  readonly repoUrl: string;
  /**
   * Full pair ID or short `rNNN` label. Omitted (or `null`): a single-pair run exports
   * that pair; a multi-pair run exports the **mean over every pair**. Given: exports
   * that one named pair, exactly like a single-pair run.
   */
  readonly pairId?: string | null;
}

export interface ExportResult {
  readonly runId: string;
  readonly targetPath: string;
  readonly relativeTargetPath: string;
  readonly status: string;
  readonly renderedMarkdown: string;
  /** "single" for one exported pair, "mean" when the tables hold the mean of every pair. */
  readonly mode: "single" | "mean";
  /** Full pair IDs actually exported: one pair ID in single mode, every pair ID in mean mode. */
  readonly pairIds: readonly string[];
}

/**
 * Resolves `--to`: a `.md` path is the file itself (its parent must be a real directory);
 * anything else must be an existing real directory and receives `EVALS.md`. Symlinked or
 * non-regular destinations are refused. Never creates directories.
 */
export async function resolveExportDestination(to: string): Promise<{ targetPath: string; relativeTargetPath: string }> {
  const resolved = resolve(to);
  const isFile = resolved.toLowerCase().endsWith(".md");
  const dir = isFile ? dirname(resolved) : resolved;
  const targetPath = isFile ? resolved : join(resolved, "EVALS.md");

  const dirStat = await lstat(dir).catch((cause: unknown) => {
    throw new EvalError("evidence-invalid", `Export refused: destination directory does not exist: ${dir}`, { at: dir, cause });
  });
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new EvalError("evidence-invalid", `Export refused: destination must be a real directory, not a symlink: ${dir}`, { at: dir });
  }
  const fileStat = await lstat(targetPath).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  });
  if (fileStat?.isSymbolicLink()) {
    throw new EvalError("evidence-invalid", `Export refused: destination file is a symlink: ${targetPath}`, { at: targetPath });
  }
  if (fileStat !== undefined && !fileStat.isFile()) {
    throw new EvalError("evidence-invalid", `Export refused: destination is not a regular file: ${targetPath}`, { at: targetPath });
  }
  return { targetPath, relativeTargetPath: relative(resolveDefaultRepoRoot(), targetPath) };
}

/**
 * Exports the EVALS.md summary of a sealed run into a skill directory (or a named `.md` file).
 */
export async function exportRun(options: ExportOptions): Promise<ExportResult> {
  const receiptPath = resolve(options.receiptPath);

  // Resolve the `--pair` selection against the receipt's pair list before building the
  // (verified) report, so a bad `--pair` fails fast with the list of available pairs.
  // Never picks a pair silently: a multi-pair run with no `--pair` resolves to the mean.
  const receiptSummary = await peekRunPairs(receiptPath);
  const selection = resolvePairSelection(receiptSummary, options.pairId ?? null);

  const report = await buildRunReport(receiptPath, {
    pairId: selection.mode === "single" ? selection.pair.pairId : null,
  });

  // 1. Verify evidence first: refuse if verification fails
  if (!report.verification.ok) {
    const failures = report.verification.failures.map((f) => f.message).join("; ");
    const altered = report.verification.altered.join(", ");
    const missing = report.verification.missing.join(", ");
    const extra = report.verification.extra.join(", ");
    throw new EvalError(
      "evidence-invalid",
      `Export refused: evidence verification failed for run ${report.runId}.\n` +
      `Failures: ${failures || "none"}\n` +
      `Altered: ${altered || "none"}; Missing: ${missing || "none"}; Extra: ${extra || "none"}`,
      { at: receiptPath },
    );
  }

  // 2. Ensure a scored report model is available
  if (!report.scored) {
    if (report.isLegacy) {
      throw new EvalError(
        "evidence-invalid",
        `Export refused: run ${report.runId} was scored under an earlier rubric (legacy) and cannot be exported under rubric v0.2.`,
        { at: receiptPath },
      );
    }
    throw new EvalError(
      "evidence-invalid",
      `Export refused: no scored report model available for run ${report.runId}.`,
      { at: receiptPath },
    );
  }

  // 2b. Every rendered pair must be graded in both arms; an ungraded arm is never
  // exported as `n/a`. In mean mode this checks EVERY pair, so an ungraded pair never
  // silently drops out of the average; in single-pair mode it checks only the selected pair.
  const renderedPairs: readonly PairReport[] =
    selection.mode === "mean"
      ? report.pairs
      : report.pairs.filter((pair) => pair.pairId === selection.pair.pairId);
  for (const pair of renderedPairs) {
    const ungraded = ((["baseline", "treatment"] as const)).filter((armId) => {
      const condition = pair.conditions.find((c) => c.conditionId === armId);
      return !(condition !== undefined && condition.gradeable && condition.rubricScore != null);
    });
    if (ungraded.length > 0) {
      const pairLabel = pair.pairId.slice(pair.pairId.lastIndexOf("-") + 1);
      const scope = selection.mode === "mean" ? "mean" : `pair ${pairLabel}`;
      const suggestion = selection.mode === "mean" ? " Pass --pair to export a single pair." : "";
      throw new EvalError(
        "evidence-invalid",
        `Export refused: pair ${pairLabel} of run ${report.runId} has ungraded arm(s): ${ungraded.join(", ")}; ` +
        `cannot export the ${scope}.${suggestion} Re-run the case to obtain a graded pair.`,
        { at: receiptPath },
      );
    }
  }

  // 2c. The run-folder exports must be fresh: the full report always, and EVALS.md for the
  // default selection (its body is exactly what gets exported). Never exports a stale link target.
  const freshness = await checkRunExports(receiptPath, { repoUrl: options.repoUrl });
  const needed = [FULL_REPORT_FILE, ...(options.pairId == null ? [SUMMARY_FILE] : [])];
  const bad = needed.filter((name) => freshness.missing.includes(name) || freshness.stale.includes(name));
  if (bad.length > 0) {
    throw new EvalError(
      "evidence-invalid",
      `Export refused: run-folder ${bad.join(", ")} of run ${report.runId} is missing or stale. ` +
        `Run \`pnpm eval:export -- --receipt <receipt> --regenerate\` first.`,
      { at: receiptPath },
    );
  }

  // 3. Render the summary (no operational footer, no receipt path, no host paths)
  const detailsUrl = buildRunReportUrl({
    repoUrl: options.repoUrl,
    runRelativeDir: runRepoRelativeDir(report),
    target: "full-report",
  });
  const renderedMarkdown = renderScoredSummaryMarkdown(report.scored, {
    detailsUrl,
    testDouble: report.testDouble,
    runHash: report.receiptManifest?.treeSha256 ?? report.verification.receiptManifestSha256,
  });

  // 4. Fail-closed destination validation
  const { targetPath, relativeTargetPath } = await resolveExportDestination(options.to);

  // 5. Read existing file if present
  let originalContent = "";
  try {
    originalContent = await readFile(targetPath, "utf8");
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new EvalError("evidence-invalid", `Cannot read destination file: ${targetPath}`, { at: targetPath, cause });
    }
  }

  // 6. Replace bounded generated section (validates markers and preserves authored content);
  // a missing file is created as BEGIN / body / END.
  const newContent = replaceGeneratedSection(originalContent, renderedMarkdown);
  await writeFile(targetPath, newContent, "utf8");

  return {
    runId: report.runId,
    targetPath,
    relativeTargetPath,
    status: report.status,
    renderedMarkdown,
    mode: selection.mode,
    pairIds: renderedPairs.map((pair) => pair.pairId),
  };
}
