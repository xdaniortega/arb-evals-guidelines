/**
 * `pnpm eval:export` — verify sealed run evidence and write the run's EVALS.md summary into a
 * skill directory (or a named .md file) within stable markers:
 * <!-- AF-EVAL:BEGIN generated --> ... <!-- AF-EVAL:END generated -->
 * Authored text outside the markers is preserved verbatim. The sealed run is never modified.
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EvalError, toStructuredFailure } from "../src/core/types.ts";
import { resolveRepositoryUrl } from "../src/core/report-links.ts";
import { exportRun } from "../src/artifacts/publish.ts";
import { listRunHistory } from "../src/artifacts/queries.ts";
import { checkRunExports, renderRunExports, writeRunExports } from "../src/artifacts/run-exports.ts";
import { EVAL_CASES_DIR } from "../src/runner/case-loader.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE =
  "usage: eval:export --receipt <path to receipt.json>   (default: generates EVALS.md and EVALS-FULL-REPORT.md inside the run folder)\n" +
  "       eval:export --receipt <path to receipt.json> --to <path_to_skill | file.md> [--pair <pair-id|rNNN>] [--repo-url <https://github.com/o/r>]\n" +
  "       eval:export (--receipt <path to receipt.json> | --all) (--regenerate | --check) [--repo-url <https://github.com/o/r>]\n" +
  "  --to <dir> also writes EVALS.md into that existing directory; a path ending in .md names the file.\n" +
  "  Without --pair: a single-pair run exports that pair; a multi-pair run exports the mean over\n" +
  "  every pair. With --pair <id>: exports that one named pair (full pair ID or short rNNN label).\n" +
  "  --to requires fresh run-folder EVALS.md / EVALS-FULL-REPORT.md (see --regenerate).\n" +
  "  --regenerate writes EVALS.md and EVALS-FULL-REPORT.md into the run folder (never touches sealed files).\n" +
  "  --check re-renders both files and fails when one is missing, stale or unexpected (read-only).\n" +
  "  --all applies --regenerate/--check to every retained run under eval-cases/.\n" +
  "  --repo-url overrides the `repository` field of package.json used for the details link.";

interface Args {
  readonly receiptPath?: string;
  readonly to?: string;
  readonly repoUrl?: string;
  readonly pairId?: string;
  readonly regenerate: boolean;
  readonly check: boolean;
  readonly all: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let receiptPath: string | undefined;
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
    const seen = { "--receipt": receiptPath, "--to": to, "--repo-url": repoUrl, "--pair": pairId }[flag];
    if (seen !== undefined) throw new EvalError("input-invalid", `${flag} given twice. ${USAGE}`, { at: flag });
    if (flag === "--receipt") receiptPath = resolve(value);
    else if (flag === "--to") to = value;
    else if (flag === "--repo-url") repoUrl = value;
    else pairId = value;
  }

  const bad = (message: string): never => {
    throw new EvalError("input-invalid", `${message}. ${USAGE}`, { at: "argv" });
  };
  if (regenerate && check) bad("--regenerate and --check are mutually exclusive");
  if (regenerate || check) {
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
    ...(receiptPath !== undefined ? { receiptPath } : {}),
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
    receipts = [args.receiptPath!];
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
  if (args.check && failed > 0) {
    process.stderr.write(`Error: run exports are not fresh. Run \`pnpm eval:export -- --receipt <receipt> --regenerate\` (or --all).\n`);
  }
  return failed === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2).filter((entry) => entry !== "--"));
  const repoUrl = resolveRepositoryUrl(args.repoUrl, args.repoUrl === undefined ? readPackageRepository() : undefined);
  if (args.regenerate || args.check) return runFolderMode(args, repoUrl);
  const result = await exportRun({
    receiptPath: args.receiptPath!,
    to: args.to!,
    repoUrl,
    ...(args.pairId !== undefined ? { pairId: args.pairId } : {}),
  });
  const suffix =
    result.mode === "mean"
      ? ` (mean of ${result.pairIds.length} pairs)`
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
