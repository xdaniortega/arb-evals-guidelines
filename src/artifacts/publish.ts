/**
 * Publication of verified rubric v0.2 evaluation results to a skill's EVALS.md.
 *
 * Host-side only: strictly read-only towards evidence, strictly bounded towards
 * the destination EVALS.md file.
 *
 * Guarantees:
 * - Evidence is verified before any file mutation; refuses to publish on verification failure.
 * - Destination skill is derived from inputs/skill-snapshot.json.sourcePath.
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

import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { EvalError } from "../core/types.ts";
import { buildRunReport, peekRunPairs, resolvePairSelection } from "./queries.ts";
import type { PairReport } from "./queries.ts";
import { renderScoredMarkdown } from "./scored-report.ts";

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

export interface DestinationResolutionInput {
  readonly skillSourcePath: string;
  readonly repoRoot?: string;
  readonly targetSkillDir?: string;
}

export interface ResolvedDestination {
  readonly repoRoot: string;
  readonly targetDir: string;
  readonly targetPath: string;
  readonly relativeTargetPath: string;
}

/**
 * Pure resolver that determines repository root and destination paths without
 * filesystem checks.
 */
export function resolvePublicationTarget(input: DestinationResolutionInput): ResolvedDestination {
  const repoRoot = input.repoRoot ? resolve(input.repoRoot) : resolveDefaultRepoRoot();
  const targetDir = input.targetSkillDir
    ? resolve(input.targetSkillDir)
    : resolve(repoRoot, input.skillSourcePath);
  const targetPath = join(targetDir, "EVALS.md");
  return {
    repoRoot,
    targetDir,
    targetPath,
    relativeTargetPath: relative(repoRoot, targetPath),
  };
}

/**
 * Validates and resolves the destination EVALS.md path fail-closed.
 *
 * For production publication (no test-only targetSkillDir override):
 * - skillSourcePath must be a normalized repository-relative path;
 *   rejects absolute paths, empty/dot, traversal (..), and resolution outside repo root.
 * - Destination must remain inside canonical real repo root.
 * - Derived skill directory must already exist as a REAL directory, not a symlink;
 *   rejects any symlink path component from repo root to skill dir.
 * - Existing EVALS.md must be a regular file, rejecting symlinks and non-regular files.
 * - Refuses missing directory without creating arbitrary directories (no mkdir).
 *
 * targetSkillDir is an isolated test-only seam for unit tests using temporary directories.
 */
export async function validateAndResolveDestination(
  skillSourcePath: string,
  options: { repoRoot?: string; targetSkillDir?: string } = {},
): Promise<ResolvedDestination> {
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : resolveDefaultRepoRoot();

  // Test-only bypass seam: isolated for testing with temporary directories
  if (options.targetSkillDir) {
    const targetDir = resolve(options.targetSkillDir);
    const targetPath = join(targetDir, "EVALS.md");

    let fileStat;
    try {
      fileStat = await lstat(targetPath);
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        throw cause;
      }
      fileStat = undefined;
    }

    if (fileStat) {
      if (fileStat.isSymbolicLink()) {
        throw new EvalError(
          "evidence-invalid",
          `Publication refused: destination EVALS.md is a symlink: ${targetPath}`,
          { at: targetPath },
        );
      }
      if (!fileStat.isFile()) {
        throw new EvalError(
          "evidence-invalid",
          `Publication refused: destination EVALS.md is not a regular file: ${targetPath}`,
          { at: targetPath },
        );
      }
    }

    return {
      repoRoot,
      targetDir,
      targetPath,
      relativeTargetPath: relative(repoRoot, targetPath),
    };
  }

  // Production path safety validation
  if (!skillSourcePath || typeof skillSourcePath !== "string" || skillSourcePath.trim().length === 0) {
    throw new EvalError(
      "evidence-invalid",
      `Publication refused: skillSourcePath is missing or empty.`,
    );
  }

  // 1. Reject absolute paths
  if (isAbsolute(skillSourcePath) || skillSourcePath.startsWith("/") || skillSourcePath.startsWith("\\")) {
    throw new EvalError(
      "evidence-invalid",
      `Publication refused: skillSourcePath must be repository-relative, got absolute path: ${skillSourcePath}`,
      { at: skillSourcePath },
    );
  }

  // 2. Reject dot or empty
  if (skillSourcePath === "." || skillSourcePath === "./" || skillSourcePath === ".\\") {
    throw new EvalError(
      "evidence-invalid",
      `Publication refused: skillSourcePath cannot be dot or empty: ${skillSourcePath}`,
      { at: skillSourcePath },
    );
  }

  // Reject traversal or empty segments
  const segments = skillSourcePath.split(/[/\\]/);
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new EvalError(
      "evidence-invalid",
      `Publication refused: skillSourcePath contains invalid or traversal segments: ${skillSourcePath}`,
      { at: skillSourcePath },
    );
  }

  // Check normalized form
  const normalized = normalize(skillSourcePath).replace(/\\/g, "/");
  const forwardPath = skillSourcePath.replace(/\\/g, "/");
  if (normalized !== forwardPath) {
    throw new EvalError(
      "evidence-invalid",
      `Publication refused: skillSourcePath is not normalized: ${skillSourcePath}`,
      { at: skillSourcePath },
    );
  }

  // 3. Destination must remain inside canonical real repo root
  let realRepoRoot: string;
  try {
    realRepoRoot = await realpath(repoRoot);
  } catch (cause: unknown) {
    throw new EvalError(
      "evidence-invalid",
      `Publication refused: repository root does not exist: ${repoRoot}`,
      { at: repoRoot, cause },
    );
  }

  const targetDir = resolve(repoRoot, skillSourcePath);
  const relFromRepo = relative(repoRoot, targetDir);
  if (relFromRepo.startsWith("..") || isAbsolute(relFromRepo) || relFromRepo === "") {
    throw new EvalError(
      "evidence-invalid",
      `Publication refused: destination skill directory resolves outside repository root: ${targetDir}`,
      { at: targetDir },
    );
  }

  // 4. Require derived skill directory to exist as a REAL directory, not a symlink;
  // reject any symlink path component from repo root to skill dir
  let current = repoRoot;
  for (const segment of segments) {
    current = join(current, segment);
    let st;
    try {
      st = await lstat(current);
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        throw new EvalError(
          "evidence-invalid",
          `Publication refused: skill path component does not exist: ${current}`,
          { at: current, cause },
        );
      }
      throw cause;
    }
    if (st.isSymbolicLink()) {
      throw new EvalError(
        "evidence-invalid",
        `Publication refused: skill path component is a symlink: ${current}`,
        { at: current },
      );
    }
    if (!st.isDirectory()) {
      throw new EvalError(
        "evidence-invalid",
        `Publication refused: skill path component is not a directory: ${current}`,
        { at: current },
      );
    }
  }

  // Enforce canonical containment via realpath
  const realTargetDir = await realpath(targetDir);
  const canonicalRel = relative(realRepoRoot, realTargetDir);
  if (canonicalRel.startsWith("..") || isAbsolute(canonicalRel) || canonicalRel === "") {
    throw new EvalError(
      "evidence-invalid",
      `Publication refused: destination skill directory escapes canonical repository root: ${realTargetDir}`,
      { at: realTargetDir },
    );
  }

  // 5. Reject existing EVALS.md if it is a symlink or non-regular file
  const targetPath = join(targetDir, "EVALS.md");
  let fileStat;
  try {
    fileStat = await lstat(targetPath);
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new EvalError(
        "evidence-invalid",
        `Publication refused: cannot inspect destination EVALS.md: ${targetPath}`,
        { at: targetPath, cause },
      );
    }
    fileStat = undefined;
  }

  if (fileStat) {
    if (fileStat.isSymbolicLink()) {
      throw new EvalError(
        "evidence-invalid",
        `Publication refused: destination EVALS.md is a symlink: ${targetPath}`,
        { at: targetPath },
      );
    }
    if (!fileStat.isFile()) {
      throw new EvalError(
        "evidence-invalid",
        `Publication refused: destination EVALS.md is not a regular file: ${targetPath}`,
        { at: targetPath },
      );
    }
  }

  return {
    repoRoot,
    targetDir,
    targetPath,
    relativeTargetPath: relative(repoRoot, targetPath),
  };
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

export interface PublishOptions {
  readonly receiptPath: string;
  readonly checks?: boolean;
  readonly repoRoot?: string;
  readonly targetSkillDir?: string;
  /**
   * Full pair ID or short `rNNN` label. Omitted (or `null`): a single-pair run publishes
   * that pair; a multi-pair run publishes the **mean over every pair**. Given: publishes
   * that one named pair, exactly like a single-pair run.
   */
  readonly pairId?: string | null;
}

export interface PublishResult {
  readonly runId: string;
  readonly targetPath: string;
  readonly relativeTargetPath: string;
  readonly status: string;
  readonly renderedMarkdown: string;
  /** "single" for one published pair, "mean" when the tables hold the mean of every pair. */
  readonly mode: "single" | "mean";
  /** Full pair IDs actually published: one pair ID in single mode, every pair ID in mean mode. */
  readonly pairIds: readonly string[];
}

/**
 * Publishes verified evaluation results for a sealed run to the evaluated skill's EVALS.md.
 */
export async function publishRun(options: PublishOptions): Promise<PublishResult> {
  const receiptPath = resolve(options.receiptPath);

  // Resolve the `--pair` selection against the receipt's pair list before building the
  // (verified) report, so a bad `--pair` fails fast with the list of available pairs,
  // even if the run can't be published for other reasons. Never picks a pair silently:
  // a multi-pair run with no `--pair` resolves to the mean over every pair.
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
      `Publication refused: evidence verification failed for run ${report.runId}.\n` +
      `Failures: ${failures || "none"}\n` +
      `Altered: ${altered || "none"}; Missing: ${missing || "none"}; Extra: ${extra || "none"}`,
      { at: receiptPath },
    );
  }

  // 2. Derive destination skill from recorded run
  if (!report.skillSourcePath || report.skillSourcePath.trim().length === 0) {
    throw new EvalError(
      "evidence-invalid",
      `Publication refused: cannot derive destination skill from run ${report.runId} ` +
      `(inputs/skill-snapshot.json sourcePath is missing or empty).`,
      { at: receiptPath },
    );
  }

  // 3. Ensure a scored report model is available
  if (!report.scored) {
    if (report.isLegacy) {
      throw new EvalError(
        "evidence-invalid",
        `Publication refused: run ${report.runId} was scored under an earlier rubric (legacy) and cannot be published under rubric v0.2.`,
        { at: receiptPath },
      );
    }
    throw new EvalError(
      "evidence-invalid",
      `Publication refused: no scored report model available for run ${report.runId}.`,
      { at: receiptPath },
    );
  }

  // 3b. Every rendered pair must be graded in both arms; an ungraded arm is never
  // published as `n/a`. In mean mode this checks EVERY pair, so an ungraded pair never
  // silently drops out of the average; in single-pair mode it checks only the selected
  // pair, so an ungraded pair elsewhere in the run does not block publishing a graded one.
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
      const suggestion = selection.mode === "mean" ? " Pass --pair to publish a single pair." : "";
      throw new EvalError(
        "evidence-invalid",
        `Publication refused: pair ${pairLabel} of run ${report.runId} has ungraded arm(s): ${ungraded.join(", ")}; ` +
        `cannot publish the ${scope}.${suggestion} Re-run the case to obtain a graded pair.`,
        { at: receiptPath },
      );
    }
  }

  // 4. Render markdown using the shared scored model (without operational footer)
  const renderedMarkdown = renderScoredMarkdown(report.scored, {
    checks: Boolean(options.checks),
  });

  // 5. Fail-closed destination path safety validation
  const destination = await validateAndResolveDestination(report.skillSourcePath, {
    repoRoot: options.repoRoot,
    targetSkillDir: options.targetSkillDir,
  });
  const { targetPath, relativeTargetPath } = destination;

  // 6. Read existing file if present
  let originalContent = "";
  try {
    originalContent = await readFile(targetPath, "utf8");
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new EvalError("evidence-invalid", `Cannot read destination file: ${targetPath}`, {
        at: targetPath,
        cause,
      });
    }
    originalContent = "";
  }

  // 7. Replace bounded generated section (validates markers and preserves authored content)
  const newContent = replaceGeneratedSection(originalContent, renderedMarkdown);

  // 8. Write updated file:
  // In production, targetDir is already verified to exist and be a real directory.
  // We do NOT call mkdir in production to avoid creating arbitrary directories.
  if (options.targetSkillDir) {
    await mkdir(destination.targetDir, { recursive: true });
  }
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
