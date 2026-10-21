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
import { buildRunReport, formatLimits, readFrozenInputs, renderPairDetails } from "./queries.ts";
import type { PairReport, RunReport } from "./queries.ts";
import { renderScoredMarkdown, renderScoredSummaryMarkdown, TEST_DOUBLE_WARNING } from "./scored-report.ts";
import type { ScoredReportModel } from "./scored-report.ts";
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

const NA = "n/a (not recorded)";
const ARM_HEADERS = ["Without this skill", "With this skill"] as const;

function table(headers: readonly string[], rows: readonly (readonly string[])[], numeric = true): string[] {
  const escape = (cell: string): string => cell.replaceAll("|", "\\|").replaceAll("\n", " ");
  return [
    `| ${headers.map(escape).join(" | ")} |`,
    `|---|${headers.slice(1).map(() => (numeric ? "---:" : "---")).join("|")}|`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ];
}

function fence(text: string): string[] {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const marker = "`".repeat(longest + 1);
  return [`${marker}text`, text, marker];
}

function pairLabel(pairId: string): string {
  return pairId.slice(pairId.lastIndexOf("-") + 1);
}

/** Reason the summary cannot be exported, or `null` when every rendered pair is graded in both arms. */
function summaryRefusalReason(report: RunReport): string | null {
  if (report.isLegacy) {
    return `run ${report.runId} was scored under an earlier rubric (legacy); EVALS.md is not generated`;
  }
  if (!report.scored) return `no scored report model is available for run ${report.runId}`;
  for (const pair of report.pairs) {
    const ungraded = (["baseline", "treatment"] as const).filter((armId) => {
      const condition = pair.conditions.find((c) => c.conditionId === armId);
      return !(condition !== undefined && condition.gradeable && condition.rubricScore != null);
    });
    if (ungraded.length > 0) {
      return `pair ${pairLabel(pair.pairId)} has ungraded arm(s): ${ungraded.join(", ")}; EVALS.md is not generated`;
    }
  }
  return null;
}

function perPairBlock(pair: PairReport, scored: ScoredReportModel | null | undefined): string[] {
  const label = pairLabel(pair.pairId);
  const lines = [`### ${label}`, ""];
  if (!scored) {
    lines.push(`Not gradeable: ${pair.delta.reason}`, "");
    return lines;
  }
  const rowOf = (row: { label: string; baseline: string; treatment: string }): string[] => [row.label, row.baseline, row.treatment];
  lines.push(`Status: ${scored.statusLine}`, "");
  if (!pair.valid) lines.push(`Not gradeable: ${pair.delta.reason}`, "");
  lines.push("**Accuracy**", "");
  lines.push(...table(["Check", ...ARM_HEADERS], [...scored.accuracyTable.rows, scored.accuracyTable.totalRow].map(rowOf)), "");
  if (scored.checksTable) {
    lines.push(`**${scored.checksTable.heading}**`, "");
    lines.push(...table(["Check", ...ARM_HEADERS], [...scored.checksTable.rows, scored.checksTable.totalRow].map(rowOf)), "");
  }
  lines.push("**Cost and latency**", "");
  lines.push(...table(["Metric", ...ARM_HEADERS], scored.costLatencyTable.rows.map(rowOf)), "");
  return lines;
}

async function aboutCaseSection(receiptPath: string, report: RunReport): Promise<string[]> {
  const lines = ["## About this case", ""];
  const frozen = await readFrozenInputs(receiptPath);
  if (!frozen.available || frozen.prompt === null) {
    lines.push(`Frozen inputs unavailable: ${frozen.reason ?? "not recorded"}.`, "");
  } else {
    const config = frozen.caseConfig ?? {};
    const tools = Array.isArray(config.allowedTools) ? (config.allowedTools as unknown[]).map(String).join(", ") : NA;
    lines.push(`- Case: ${report.caseId}, version ${config.version === undefined ? NA : String(config.version)}`);
    lines.push(`- Rubric version: ${report.rubricVersion ?? NA}`);
    lines.push(`- Allowed tools: ${tools}`);
    lines.push(`- Output path: ${typeof config.outputPath === "string" ? config.outputPath : NA}`, "");
    lines.push("Prompt (verbatim):", "", ...fence(frozen.prompt), "");
    const rubric = report.scored?.rubric;
    if (rubric !== undefined) {
      const topics = new Map((rubric.topics ?? []).map((topic) => [topic.id, topic.label]));
      lines.push("Checks:", "");
      lines.push(
        ...table(
          ["Check", "Group", "Topic", "Points"],
          rubric.checks.map((check) => [
            check.id,
            check.group,
            check.topic === undefined ? "" : (topics.get(check.topic) ?? check.topic),
            String(check.points),
          ]),
          false,
        ),
        "",
      );
    }
  }
  lines.push(
    "[Current case documentation](../../README.md); the frozen inputs above are authoritative. This section is explanatory only and is not evidence.",
    "",
  );
  return lines;
}

function reproducibilitySection(report: RunReport): string[] {
  const digests = [
    ...new Set(report.pairs.flatMap((pair) => pair.conditions.map((c) => c.imageDigest)).filter((d): d is string => d !== null)),
  ].sort();
  const target = report.target;
  const revision = report.source?.revision;
  const dirty = report.source?.dirty;
  const model = target?.model ?? "<model>";
  const thinking = target?.thinking ?? "<thinking>";
  const lines = [
    "## Reproducibility",
    "",
    "Recorded facts:",
    "",
    `- Evaluator source revision: ${revision ?? NA}${dirty === undefined ? "" : dirty ? " (dirty working tree)" : " (clean)"}`,
    `- Evaluator build: ${report.evaluatorBuild ?? NA}`,
    `- Image digest(s): ${digests.length === 0 ? NA : digests.join(", ")}`,
    `- Skill snapshot tree sha256: ${report.skillSnapshot?.treeSha256 ?? NA}`,
    `- SKILL.md sha256: ${report.skillSnapshot?.skillMdSha256 ?? NA}`,
    `- Provider: ${target?.provider ?? NA}`,
    `- Model: ${target?.model ?? NA}`,
    `- Thinking level: ${target?.thinking ?? NA}`,
    `- Limits: ${formatLimits(report.limits)}`,
    `- Repetitions: ${report.pairs.length}`,
    "",
    "A comparable new run:",
    "",
    ...fence(
      `pnpm eval -- --case ${report.caseSelector} --skill <path_to_skill> --model ${model} --thinking ${thinking} --repetitions ${report.pairs.length}`,
    ),
    "",
    "Answers are not expected to be identical between runs; a new run measures the same task again and is compared with this one, not matched to it.",
    "",
  ];
  return lines;
}

function verifySection(report: RunReport, runDir: string): string[] {
  const manifest = report.receiptManifest;
  return [
    "## Verify this report",
    "",
    "This file is generated and is not part of the sealed hash chain. It is tied to its run by the hashes below, which come from `receipt.json`.",
    "",
    `Run hash (manifest tree sha256): ${manifest?.treeSha256 ?? NA}  `,
    `Receipt manifest file sha256: ${manifest?.fileSha256 ?? NA}`,
    "",
    "Recompute the evidence chain and compare the tree hash it prints with the one above:",
    "",
    ...fence(`pnpm eval:report -- --receipt ${runDir}/receipt.json --checks`),
    "",
  ];
}

function exportSection(runDir: string): string[] {
  return [
    "## Export",
    "",
    "The first command (re)generates `EVALS.md` and `EVALS-FULL-REPORT.md` inside this run folder. `--to` additionally copies the summary into a directory. **`EVALS.md` is the file to export or copy into the skills repository.** `EVALS-FULL-REPORT.md` stays in this repository.",
    "",
    ...fence(
      [
        `pnpm eval:export -- --receipt ${runDir}/receipt.json`,
        `pnpm eval:export -- --receipt ${runDir}/receipt.json --to <output_dir>`,
        `pnpm eval:export -- --receipt ${runDir}/receipt.json --to <output_dir> --pair r001`,
      ].join("\n"),
    ),
    "",
  ];
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
  const detailsUrl = buildRunReportUrl({ repoUrl: options.repoUrl, runRelativeDir: runDir, target: "full-report" });
  const summaryRefusal = summaryRefusalReason(report);

  const summary =
    summaryRefusal === null && report.scored
      ? renderScoredSummaryMarkdown(report.scored, {
          detailsUrl,
          testDouble: report.testDouble,
          runHash: report.receiptManifest?.treeSha256 ?? report.verification.receiptManifestSha256,
        })
      : null;

  const title = report.scored?.caseTitle ?? report.caseTitle ?? report.caseId;
  const lines: string[] = [];
  if (report.testDouble) lines.push(`> **Warning:** ${TEST_DOUBLE_WARNING}`, "");
  lines.push(`# EVALS-FULL-REPORT: ${title}`, "");
  lines.push(...(await aboutCaseSection(receiptPath, report)));

  if (report.scored && !report.isLegacy) {
    const heading = "EVALS-FULL-REPORT";
    const body = renderScoredMarkdown(report.scored, { checks: true, heading, runHash: report.receiptManifest?.treeSha256 ?? report.verification.receiptManifestSha256 }).replace(`# ${heading}\n\n`, "");
    lines.push(body, "");
  } else {
    lines.push(`Legacy or unscored run: no rubric v0.2 scored sections are available. Status: ${report.status}.`, "");
  }
  if (summaryRefusal !== null) lines.push(`> EVALS.md was not generated: ${summaryRefusal}.`, "");

  if (report.pairs.length > 1) {
    lines.push("## Per-pair results", "");
    for (const pair of report.pairs) {
      const single = report.isLegacy ? null : (await buildRunReport(receiptPath, { pairId: pair.pairId })).scored;
      lines.push(...perPairBlock(pair, single));
    }
  }

  lines.push(...verifySection(report, runDir));
  lines.push(...exportSection(runDir));
  lines.push("## Operational details", "");
  lines.push(`- Limits: ${formatLimits(report.limits)}`);
  lines.push(`- Elapsed: ${report.elapsedWallTime ?? "n/a"} wall time`);
  for (const failure of report.failures ?? []) lines.push(`- Failure: [${failure.code}] ${failure.message}`);
  lines.push("");
  if (report.pairs.length > 0) lines.push(...fence(renderPairDetails(report)), "");

  lines.push(...reproducibilitySection(report));

  return { summary, full: `${lines.join("\n").replace(/\n+$/, "")}\n`, summaryRefusal };
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
