/**
 * `pnpm eval:export` — verify sealed evidence and write or check generated reports:
 * - `--receipt` writes (or with --regenerate/--check, rewrites/verifies) a run's EVALS.md and
 *   EVALS-FULL-REPORT.md inside the run folder; `--all` covers every retained run and every combined file.
 * - `--receipt ... --to` publishes the run's EVALS.md into a skill directory (or a named .md file)
 *   within stable markers: <!-- AF-EVAL:BEGIN generated --> ... <!-- AF-EVAL:END generated -->.
 *   Authored text outside the markers is preserved verbatim.
 * - several `--receipt` flags write (or with --check verify) one combined
 *   eval-cases/<case>/runs/EVALS-<run-id>+<run-id>[+...].md summarising those runs.
 *   `--all` also covers every such combined file.
 * Sealed runs are never modified.
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EvalError, toStructuredFailure } from "../src/core/types.ts";
import { resolveRepositoryUrl } from "../src/core/report-links.ts";
import { exportRun } from "../src/artifacts/publish.ts";
import { listRunHistory } from "../src/artifacts/queries.ts";
import {
  checkAllCombined,
  checkCombinedExports,
  regenerateAllCombined,
  renderCombinedExports,
  writeCombinedExports,
} from "../src/artifacts/combined-exports.ts";
import { checkRunExports, renderRunExports, writeRunExports } from "../src/artifacts/run-exports.ts";
import { EVAL_CASES_DIR } from "../src/runner/case-loader.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE =
  "usage: eval:export --receipt <path to receipt.json>   (default: generates EVALS.md and EVALS-FULL-REPORT.md inside the run folder)\n" +
  "       eval:export --receipt <path to receipt.json> --to <path_to_skill | file.md> [--pair <pair-id|rNNN>] [--repo-url <https://github.com/o/r>]\n" +
  "       eval:export (--receipt <path to receipt.json> | --all) (--regenerate | --check) [--repo-url <https://github.com/o/r>]\n" +
  "       eval:export --receipt <receipt.json> --receipt <receipt.json> [--receipt ...] [--check] [--repo-url <https://github.com/o/r>]\n" +
  "  Several --receipt flags write (or with --check verify) one combined EVALS-<run-id>+<run-id>[+...].md directly in\n" +
  "  eval-cases/<case>/runs/, with one row per run in argument order. The runs must be distinct runs of one case with\n" +
  "  the same skill, case version, rubric version and prompt, each with a pair graded in both arms; otherwise it is refused and nothing is written.\n" +
  "  --pair, --to and --all cannot be combined with several --receipt.\n" +
  "  --to <dir> also writes EVALS.md into that existing directory; a path ending in .md names the file.\n" +
  "  Without --pair: a single-pair run exports that pair; a multi-pair run exports the mean over\n" +
  "  the pairs graded in both arms (refused only if none is). With --pair <id> (refused if that pair has an ungraded arm): exports that one named pair (full pair ID or short rNNN label).\n" +
  "  --to requires fresh run-folder EVALS.md / EVALS-FULL-REPORT.md (see --regenerate).\n" +
  "  --regenerate writes EVALS.md and EVALS-FULL-REPORT.md into the run folder (never touches sealed files).\n" +
  "  --check re-renders both files and fails when one is missing, stale or unexpected (read-only).\n" +
  "  --all applies --regenerate/--check to every retained run and every combined EVALS-*.md under eval-cases/*/runs/.\n" +
  "  --repo-url overrides the `repository` field of package.json used for the details link.";

interface Args {
  /** Every `--receipt` in argument order (at least one). */
  readonly receiptPaths: readonly string[];
  readonly to?: string;
  readonly repoUrl?: string;
  readonly pairId?: string;
  readonly regenerate: boolean;
  readonly check: boolean;
  readonly all: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const receiptPaths: string[] = [];
  let to: string | undefined;
  let repoUrl: string | undefined;
  let pairId: string | undefined;
  let regenerate = false;
  let check = false;
  let all = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (flag === "--regenerate" || flag === "--check" || flag === "--all") {
      if ((flag === "--regenerate" && regenerate) || (flag === "--check" && check) || (flag === "--all" && all)) {
        throw new EvalError("input-invalid", `${flag} given twice. ${USAGE}`, { at: flag });
      }
      if (flag === "--regenerate") regenerate = true;
      else if (flag === "--check") check = true;
      else all = true;
      continue;
    }
    if (flag !== "--receipt" && flag !== "--to" && flag !== "--repo-url" && flag !== "--pair") {
      throw new EvalError("input-invalid", `unknown argument: ${String(flag)}. ${USAGE}`, { at: "argv" });
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new EvalError("input-invalid", `${flag} requires a value. ${USAGE}`, { at: flag });
    }
    index += 1;
    const seen = { "--to": to, "--repo-url": repoUrl, "--pair": pairId }[flag as "--to" | "--repo-url" | "--pair"];
    if (flag !== "--receipt" && seen !== undefined) throw new EvalError("input-invalid", `${flag} given twice. ${USAGE}`, { at: flag });
    if (flag === "--receipt") receiptPaths.push(resolve(value));
    else if (flag === "--to") to = value;
    else if (flag === "--repo-url") repoUrl = value;
    else pairId = value;
  }

  const bad = (message: string): never => {
    throw new EvalError("input-invalid", `${message}. ${USAGE}`, { at: "argv" });
  };
  if (regenerate && check) bad("--regenerate and --check are mutually exclusive");
  const receiptPath = receiptPaths[0];
  if (receiptPaths.length > 1) {
    if (all || to !== undefined || pairId !== undefined) bad("--all, --to and --pair cannot be combined with several --receipt");
    if (!check) regenerate = true;
  } else if (regenerate || check) {
    if (to !== undefined || pairId !== undefined) bad("--to and --pair cannot be combined with --regenerate/--check");
    if (all === (receiptPath !== undefined)) bad("exactly one of --receipt or --all is required with --regenerate/--check");
  } else {
    if (all) bad("--all requires --regenerate or --check");
    if (!receiptPath) bad("--receipt is required");
    // Default: no --to means "generate the reports inside the run folder".
    if (!to) {
      if (pairId !== undefined) bad("--pair requires --to");
      regenerate = true;
    }
  }
  return {
    regenerate,
    check,
    all,
    receiptPaths,
    ...(to !== undefined ? { to } : {}),
    ...(repoUrl !== undefined ? { repoUrl } : {}),
    ...(pairId !== undefined ? { pairId } : {}),
  };
}

/** Reads the `repository` field of package.json once, at the process boundary. */
function readPackageRepository(): string | undefined {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    repository?: string | { url?: string };
  };
  return typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
}

function display(path: string): string {
  const rel = relative(REPO_ROOT, path);
  return rel.startsWith("..") ? path : rel;
}

async function runFolderMode(args: Args, repoUrl: string): Promise<number> {
  let receipts: string[];
  if (args.all) {
    const casesRoot = join(REPO_ROOT, EVAL_CASES_DIR) + sep;
    const history = await listRunHistory(REPO_ROOT);
    receipts = [];
    for (const entry of history) {
      if (!entry.runDir.startsWith(casesRoot)) continue;
      if (entry.state === "incomplete") {
        process.stdout.write(`skip   ${display(entry.runDir)} (incomplete run)\n`);
        continue;
      }
      receipts.push(entry.receiptPath);
    }
  } else {
    receipts = [args.receiptPaths[0]!];
  }

  let failed = 0;
  for (const receiptPath of receipts) {
    const runDir = dirname(receiptPath);
    try {
      if (args.check) {
        const result = await checkRunExports(receiptPath, { repoUrl });
        if (result.ok) {
          process.stdout.write(`ok     ${display(runDir)}\n`);
        } else {
          failed += 1;
          const parts = [
            ...result.missing.map((name) => `missing ${name}`),
            ...result.stale.map((name) => `stale ${name}`),
            ...result.unexpected.map((name) => `unexpected ${name}`),
          ];
          process.stdout.write(`FAIL   ${display(runDir)}: ${parts.join(", ")}\n`);
        }
      } else {
        const exports = await renderRunExports(receiptPath, { repoUrl });
        await writeRunExports(runDir, exports);
        const files = exports.summary === null ? "EVALS-FULL-REPORT.md only" : "EVALS.md, EVALS-FULL-REPORT.md";
        process.stdout.write(`wrote  ${display(runDir)}: ${files}${exports.summaryRefusal === null ? "" : ` (${exports.summaryRefusal})`}\n`);
      }
    } catch (error: unknown) {
      failed += 1;
      process.stdout.write(`FAIL   ${display(runDir)}: ${toStructuredFailure(error, "evidence-invalid").message}\n`);
    }
  }
  if (args.all) failed += await allCombined(args, repoUrl);
  if (args.check && failed > 0) {
    process.stderr.write(`Error: exports are not fresh. Run \`pnpm eval:export -- --receipt <receipt> --regenerate\` or \`--regenerate --all\`.\n`);
  }
  return failed === 0 ? 0 : 1;
}

/** Writes or checks every combined EVALS-*.md of every case (the combined half of `--all`). Returns the failure count. */
async function allCombined(args: Args, repoUrl: string): Promise<number> {
  const casesRoot = join(REPO_ROOT, EVAL_CASES_DIR);
  let failed = 0;
  if (args.check) {
    for (const result of await checkAllCombined({ casesRoot, repoUrl })) {
      if (result.ok) process.stdout.write(`ok     ${display(result.path)}\n`);
      else {
        failed += 1;
        process.stdout.write(`FAIL   ${display(result.path)}: ${result.problem ?? "not fresh"}\n`);
      }
    }
  } else {
    for (const result of await regenerateAllCombined({ casesRoot, repoUrl })) {
      if (!result.ok) {
        failed += 1;
        process.stdout.write(`FAIL   ${display(result.path)}: ${result.detail ?? "failed"}\n`);
      } else if (result.action === "removed") {
        process.stdout.write(`removed ${display(result.path)} (${result.detail ?? "refused"})\n`);
      } else {
        process.stdout.write(`wrote  ${display(result.path)}\n`);
      }
    }
  }
  return failed;
}

/** Several `--receipt` flags: write or check the one combined file of those runs. */
async function combinedMode(args: Args, repoUrl: string): Promise<number> {
  if (args.check) {
    const result = await checkCombinedExports({ receiptPaths: args.receiptPaths, repoUrl });
    if (result.ok) {
      process.stdout.write(`ok     ${display(result.path)}\n`);
      return 0;
    }
    process.stdout.write(`FAIL   ${result.path === "" ? "combined EVALS.md" : display(result.path)}: ${result.problem ?? "not fresh"}\n`);
    process.stderr.write("Error: the combined EVALS.md is not fresh. Run the same command without --check to regenerate it.\n");
    return 1;
  }
  const rendered = await renderCombinedExports({ receiptPaths: args.receiptPaths, repoUrl });
  if (!rendered.ok) throw new EvalError("input-invalid", `combined export refused: ${rendered.reason}`, { at: "--receipt" });
  const path = await writeCombinedExports(rendered);
  process.stdout.write(`wrote ${display(path)}\n`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2).filter((entry) => entry !== "--"));
  const repoUrl = resolveRepositoryUrl(args.repoUrl, args.repoUrl === undefined ? readPackageRepository() : undefined);
  if (args.receiptPaths.length > 1) return combinedMode(args, repoUrl);
  if (args.regenerate || args.check) return runFolderMode(args, repoUrl);
  const result = await exportRun({
    receiptPath: args.receiptPaths[0]!,
    to: args.to!,
    repoUrl,
    ...(args.pairId !== undefined ? { pairId: args.pairId } : {}),
  });
  const suffix =
    result.mode === "mean"
      ? ` (mean of ${result.pairIds.length} ${result.pairIds.length === 1 ? "pair" : "pairs"})`
      : ` pair ${result.pairIds[0]?.slice(result.pairIds[0].lastIndexOf("-") + 1) ?? ""}`;
  process.stdout.write(`Exported evaluation results for run ${result.runId}${suffix} to ${result.relativeTargetPath}\n`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const failure = toStructuredFailure(error, "evidence-invalid");
    process.stderr.write(`Error: ${failure.message}\n`);
    process.exitCode = 1;
  },
);
