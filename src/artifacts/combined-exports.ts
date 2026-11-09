/**
 * Combined exports: one `EVALS-<runIdA>+<runIdB>[+...].md` written directly inside
 * `eval-cases/<case>/runs/`, summarising several independent runs of one case (one per model).
 *
 * The file is a generated output outside every hash chain. Its members are identified by the
 * run ids in its own name; every member is verified through the ordinary read model and its
 * `SummaryEntry` is built exactly as the single-run export builds it. Nothing is merged or
 * recomputed across runs, and a combination that cannot be presented consistently is refused
 * rather than rendered partially. There is no combined full report: each row links the full
 * report of its own run.
 */

import { createHash, randomBytes } from "node:crypto";
import { lstat, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { buildRunReportUrl } from "../core/report-links.ts";
import { EvalError } from "../core/types.ts";
import { buildRunReport, readFrozenInputs } from "./queries.ts";
import type { RunReport, SealedFrozenInputsResult } from "./queries.ts";
import { formatModelLabel } from "./model-label.ts";
import { runRepoRelativeDir, summaryRefusalReason } from "./run-exports.ts";
import { renderScoredSummaryMarkdown } from "./scored-report.ts";
import { buildSummaryEntry } from "./summary-entry.ts";
import type { SummaryEntryInput } from "./summary-entry.ts";

export const COMBINED_FILE_PREFIX = "EVALS-";
const COMBINED_FILE_SUFFIX = ".md";
/** Same shape as `runIdFor`: `<UTC stamp>-<8..16 hex>`. */
const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8,16}$/;

/** `EVALS-<idA>+<idB>[+...].md` for run ids in the given order. */
export function combinedFileName(runIds: readonly string[]): string {
  return `${COMBINED_FILE_PREFIX}${runIds.join("+")}${COMBINED_FILE_SUFFIX}`;
}

/** True for any name that claims to be a combined file (valid or not). */
export function isCombinedFileCandidate(name: string): boolean {
  return name.startsWith(COMBINED_FILE_PREFIX) && name.endsWith(COMBINED_FILE_SUFFIX);
}

/** Run ids named by a combined file name, or `null` when the name is not strictly `EVALS-<id>(+<id>)+.md` with distinct ids. */
export function parseCombinedFileName(name: string): string[] | null {
  if (!isCombinedFileCandidate(name)) return null;
  const body = name.slice(COMBINED_FILE_PREFIX.length, name.length - COMBINED_FILE_SUFFIX.length);
  const ids = body.split("+");
  if (ids.length < 2) return null;
  if (!ids.every((id) => RUN_ID_PATTERN.test(id))) return null;
  if (new Set(ids).size !== ids.length) return null;
  return ids;
}

const MAX_FILE_NAME_BYTES = 255;
/** Staging file name used by the atomic write (`.tmp-<12 hex>-<name>`). */
const stagingName = (fileName: string): string => `.tmp-${"0".repeat(12)}-${fileName}`;

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/** What every member must share for the runs to be comparable. */
function memberIdentity(m: { readonly report: RunReport; readonly frozen: SealedFrozenInputsResult }): Record<string, string> {
  return {
    "case id": m.report.caseId,
    "case version": String(m.frozen.caseConfig?.version ?? "unrecorded"),
    "rubric version": m.report.rubricVersion ?? "unrecorded",
    "prompt hash": m.frozen.prompt === null ? "unrecorded" : sha256Hex(m.frozen.prompt),
    "skill snapshot tree hash": m.report.skillSnapshot?.treeSha256 ?? "unrecorded",
  };
}

/** Identity fields on which any member differs from the first; empty when the runs are comparable. */
export function differingIdentityFields(identities: readonly Readonly<Record<string, string>>[]): string[] {
  const [reference, ...rest] = identities;
  if (reference === undefined) return [];
  const differing = new Set<string>();
  for (const own of rest) for (const key of Object.keys(reference)) if (own[key] !== reference[key]) differing.add(key);
  return [...differing];
}

/**
 * Pure render: one document of the given entries in order. Same-case entries share one section;
 * the renderer throws when they disagree on the check list.
 */
export function renderCombinedSummary(inputs: readonly SummaryEntryInput[]): string {
  if (inputs.length === 0) throw new Error("a combined summary needs at least one run");
  return renderScoredSummaryMarkdown({ skillLabel: inputs[0]!.scored.skillLabel, entries: inputs.map(buildSummaryEntry) });
}

export type CombinedExports =
  | {
      readonly ok: true;
      readonly content: string;
      readonly fileName: string;
      /** Absolute `runs/` folder the file belongs in. */
      readonly runsDir: string;
      readonly caseId: string;
      readonly runIds: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

const refuse = (reason: string): CombinedExports => ({ ok: false, reason });

/**
 * Renders the combined EVALS.md of the runs behind `receiptPaths` (argument order). Refusals are
 * returned with their reason; unreadable evidence throws.
 */
export async function renderCombinedExports(input: {
  readonly receiptPaths: readonly string[];
  readonly repoUrl: string;
}): Promise<CombinedExports> {
  const receipts = input.receiptPaths.map((path) => resolve(path));
  if (receipts.length < 2) return refuse("a combined EVALS.md needs at least two runs");
  if (new Set(receipts).size !== receipts.length) return refuse("the same receipt was given more than once");

  const loaded: { readonly receiptPath: string; readonly report: RunReport; readonly frozen: SealedFrozenInputsResult; readonly label: string }[] = [];
  for (const receiptPath of receipts) {
    const report = await buildRunReport(receiptPath);
    if (!report.verification.ok) return refuse(`evidence verification failed for run ${report.runId}`);
    loaded.push({ receiptPath, report, frozen: await readFrozenInputs(receiptPath), label: report.target === undefined ? report.runId : formatModelLabel(report.target) });
  }

  const runIds = loaded.map((m) => m.report.runId);
  if (new Set(runIds).size !== runIds.length) return refuse("the same run was given more than once");
  const caseIds = [...new Set(loaded.map((m) => m.report.caseId))];
  if (caseIds.length > 1) return refuse(`runs belong to different cases (${caseIds.join(", ")}); a combined EVALS.md covers one case`);
  const runsDirs = [...new Set(receipts.map((path) => dirname(dirname(path))))];
  if (runsDirs.length > 1) return refuse("runs are stored in different runs folders; a combined EVALS.md covers one");
  for (const m of loaded) {
    if (basename(dirname(m.receiptPath)) !== m.report.runId) return refuse(`run directory name does not match run id ${m.report.runId}`);
  }

  const labels = loaded.map((m) => m.label);
  const duplicateLabel = labels.find((label, index) => labels.indexOf(label) !== index);
  if (duplicateLabel !== undefined) {
    return refuse(`more than one run is labelled "${duplicateLabel}"; the combined tables could not tell them apart`);
  }

  const differing = differingIdentityFields(loaded.map(memberIdentity));
  if (differing.length > 0) return refuse(`runs differ in ${differing.join(", ")}; the runs are not comparable`);

  const problems = loaded.flatMap((m) => {
    const reason = summaryRefusalReason(m.report);
    return reason === null ? [] : [`${m.label} (run ${m.report.runId}): ${reason}`];
  });
  if (problems.length > 0) return refuse(`${problems.join("; ")}; combined EVALS.md is not generated`);

  let content: string;
  try {
    content = renderCombinedSummary(
      loaded.map((m) => {
        if (!m.report.scored) throw new EvalError("evidence-invalid", `no scored report model is available for run ${m.report.runId}`);
        return {
          report: m.report,
          scored: m.report.scored,
          frozenPrompt: m.frozen.prompt,
          reportUrl: buildRunReportUrl({ repoUrl: input.repoUrl, runRelativeDir: runRepoRelativeDir(m.report), target: "full-report" }),
        };
      }),
    );
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
  const fileName = combinedFileName(runIds);
  const roundTrip = parseCombinedFileName(fileName);
  if (roundTrip === null || roundTrip.length !== runIds.length || roundTrip.some((id, index) => id !== runIds[index])) {
    return refuse(`the combined file name ${fileName} does not identify its runs; refusing to write it`);
  }
  if (Buffer.byteLength(stagingName(fileName)) > MAX_FILE_NAME_BYTES) {
    return refuse(`the combined file name for ${runIds.length} runs is too long for a file name (${Buffer.byteLength(stagingName(fileName))} > ${MAX_FILE_NAME_BYTES} bytes)`);
  }
  return { ok: true, content, fileName, runsDir: runsDirs[0]!, caseId: caseIds[0]!, runIds };
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  return lstat(path).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  });
}

/** Writes the combined file atomically into its `runs/` folder; never replaces anything but a regular file. */
export async function writeCombinedExports(exports: Extract<CombinedExports, { ok: true }>): Promise<string> {
  const target = join(exports.runsDir, exports.fileName);
  const existing = await lstatOrNull(target);
  if (existing !== null && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new EvalError("evidence-invalid", `${exports.fileName} is not a regular file; refusing to replace it`, { at: exports.fileName });
  }
  const staged = join(exports.runsDir, `.tmp-${randomBytes(6).toString("hex")}-${exports.fileName}`); // length bound: stagingName()
  try {
    await writeFile(staged, exports.content, { mode: 0o644, flag: "wx" });
    await rename(staged, target);
  } catch (cause) {
    await unlink(staged).catch(() => undefined);
    throw cause;
  }
  return target;
}

/** One model of a multi-model command, in argument order. */
export interface CombinedRunInput {
  /** Readable model label for messages. */
  readonly label: string;
  /** Receipt of the run this model produced, or `null` when none was produced. */
  readonly receiptPath: string | null;
  /** The model was never started (the command stopped first) rather than started without a receipt. */
  readonly notStarted: boolean;
}

/**
 * Combined EVALS.md of a multi-model command: gathers each model's receipt in order, renders,
 * writes and returns the absolute path, or the reason nothing was written. Never throws.
 */
export async function exportCombinedForRuns(input: {
  readonly runs: readonly CombinedRunInput[];
  readonly repoUrl: string;
}): Promise<{ readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string }> {
  const receiptPaths: string[] = [];
  for (const run of input.runs) {
    if (run.receiptPath === null) {
      return { ok: false, reason: run.notStarted ? `${run.label} was not run` : `${run.label} did not produce a sealed receipt` };
    }
    receiptPaths.push(run.receiptPath);
  }
  try {
    const rendered = await renderCombinedExports({ receiptPaths, repoUrl: input.repoUrl });
    if (!rendered.ok) return { ok: false, reason: rendered.reason };
    return { ok: true, path: await writeCombinedExports(rendered) };
  } catch (cause) {
    return { ok: false, reason: cause instanceof EvalError ? cause.message : messageOf(cause) };
  }
}

export interface CombinedCheck {
  readonly ok: boolean;
  /** Absolute path of the combined file. */
  readonly path: string;
  /** Why it is not ok; `null` when ok. */
  readonly problem: string | null;
}

async function compareFile(path: string, expected: string): Promise<string | null> {
  const stat = await lstatOrNull(path);
  if (stat === null) return "missing";
  if (stat.isSymbolicLink() || !stat.isFile() || (await readFile(path, "utf8")) !== expected) return "stale";
  return null;
}

/** Re-renders the combination of `receiptPaths` and compares the file bytes. Read-only. */
export async function checkCombinedExports(input: { readonly receiptPaths: readonly string[]; readonly repoUrl: string }): Promise<CombinedCheck> {
  const rendered = await renderCombinedExports(input);
  if (!rendered.ok) return { ok: false, path: "", problem: `refused (${rendered.reason})` };
  const path = join(rendered.runsDir, rendered.fileName);
  const problem = await compareFile(path, rendered.content);
  return { ok: problem === null, path, problem };
}

/** Absolute paths of every `EVALS-*.md` entry directly under `<caseDir>/runs`, sorted by name. */
export async function listCombinedFiles(caseDir: string): Promise<string[]> {
  const runsDir = join(caseDir, "runs");
  return (await readdir(runsDir).catch(() => [] as string[])).filter(isCombinedFileCandidate).sort().map((name) => join(runsDir, name));
}

/** Every directory directly under `casesRoot`, sorted by name (each is treated as a case folder). */
export async function listCaseDirs(casesRoot: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(casesRoot, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) out.push(join(casesRoot, entry.name));
  }
  return out;
}

/** Receipt paths of the runs a combined file names, or the reason they cannot be located. */
async function memberReceipts(file: string): Promise<{ readonly receipts: string[] } | { readonly problem: string }> {
  const ids = parseCombinedFileName(basename(file));
  if (ids === null) return { problem: "unparseable name (expected EVALS-<run-id>+<run-id>[+...].md with distinct run ids)" };
  const runsDir = dirname(file);
  const receipts: string[] = [];
  for (const id of ids) {
    const stat = await lstatOrNull(join(runsDir, id));
    if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) return { problem: `member run ${id} is missing` };
    receipts.push(join(runsDir, id, "receipt.json"));
  }
  return { receipts };
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Checks every combined file of every case under `casesRoot` (the combined half of `--check --all`). */
export async function checkAllCombined(input: { readonly casesRoot: string; readonly repoUrl: string }): Promise<CombinedCheck[]> {
  const out: CombinedCheck[] = [];
  for (const caseDir of await listCaseDirs(input.casesRoot)) {
    for (const path of await listCombinedFiles(caseDir)) {
      const members = await memberReceipts(path);
      if ("problem" in members) {
        out.push({ ok: false, path, problem: members.problem });
        continue;
      }
      try {
        const rendered = await renderCombinedExports({ receiptPaths: members.receipts, repoUrl: input.repoUrl });
        if (!rendered.ok) out.push({ ok: false, path, problem: `refused (${rendered.reason})` });
        else {
          const problem = await compareFile(path, rendered.content);
          out.push({ ok: problem === null, path, problem });
        }
      } catch (cause) {
        out.push({ ok: false, path, problem: `check failed (${messageOf(cause)})` });
      }
    }
  }
  return out;
}

export interface CombinedWrite {
  readonly path: string;
  readonly ok: boolean;
  /** `written`, or `removed` when the combination is now refused. */
  readonly action: "written" | "removed" | "failed";
  /** Failure reason or the refusal that caused the removal; `null` for a plain write. */
  readonly detail: string | null;
}

/**
 * Rewrites every combined file of every case from its members (the combined half of
 * `--regenerate --all`). A file whose combination is now refused is removed; a file with an
 * unparseable name or a missing member fails and is left untouched.
 */
export async function regenerateAllCombined(input: { readonly casesRoot: string; readonly repoUrl: string }): Promise<CombinedWrite[]> {
  const out: CombinedWrite[] = [];
  for (const caseDir of await listCaseDirs(input.casesRoot)) {
    for (const path of await listCombinedFiles(caseDir)) {
      const members = await memberReceipts(path);
      if ("problem" in members) {
        out.push({ path, ok: false, action: "failed", detail: members.problem });
        continue;
      }
      try {
        const rendered = await renderCombinedExports({ receiptPaths: members.receipts, repoUrl: input.repoUrl });
        if (!rendered.ok) {
          const stat = await lstatOrNull(path);
          if (stat !== null && (stat.isSymbolicLink() || !stat.isFile())) {
            out.push({ path, ok: false, action: "failed", detail: "not a regular file; refusing to remove it" });
            continue;
          }
          await unlink(path);
          out.push({ path, ok: true, action: "removed", detail: rendered.reason });
          continue;
        }
        await writeCombinedExports(rendered);
        out.push({ path, ok: true, action: "written", detail: null });
      } catch (cause) {
        out.push({ path, ok: false, action: "failed", detail: messageOf(cause) });
      }
    }
  }
  return out;
}
