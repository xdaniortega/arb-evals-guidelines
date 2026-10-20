/** `pnpm eval:history` — discovery-only index of retained run directories. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EvalError, toStructuredFailure } from "../src/core/types.ts";
import { formatLatestRun, formatRunHistory, listRunHistory, resolveLatestRun } from "../src/artifacts/queries.ts";

const USAGE = "usage: eval:history [--format table|json] [--latest] [--case <id>]";

interface HistoryArgs {
  readonly format: "table" | "json";
  readonly latest: boolean;
  readonly caseFilter: string | null;
}

function parseArgs(argv: readonly string[]): HistoryArgs {
  let format: "table" | "json" = "table";
  let latest = false;
  let caseFilter: string | null = null;
  let receiptPath: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (flag === "--latest") {
      latest = true;
      continue;
    }
    if (flag === "--format") {
      const value = argv[++i];
      if (value !== "table" && value !== "json") {
        throw new EvalError("input-invalid", "--format must be table or json", { at: "--format" });
      }
      format = value;
      continue;
    }
    if (flag === "--case") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new EvalError("input-invalid", `--case requires a value. ${USAGE}`, { at: "--case" });
      }
      caseFilter = value;
      continue;
    }
    if (flag === "--receipt") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new EvalError("input-invalid", `--receipt requires a value. ${USAGE}`, { at: "--receipt" });
      }
      receiptPath = value;
      continue;
    }
    throw new EvalError("input-invalid", `unknown argument: ${flag}. ${USAGE}`, { at: "argv" });
  }

  if (latest && receiptPath !== null) {
    throw new EvalError(
      "input-invalid",
      "--latest cannot be combined with --receipt; choose either --latest (with optional --case) or --receipt",
      { at: "--latest" },
    );
  }
  if (receiptPath !== null) {
    throw new EvalError("input-invalid", `unknown argument: --receipt. ${USAGE}`, { at: "--receipt" });
  }
  // The full index is not filtered by case, so accepting --case without --latest would
  // silently ignore it and print an unfiltered listing the caller did not ask for.
  if (caseFilter !== null && !latest) {
    throw new EvalError("input-invalid", `--case requires --latest. ${USAGE}`, { at: "--case" });
  }

  return { format, latest, caseFilter };
}

const evalsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  const args = parseArgs(process.argv.slice(2).filter((v) => v !== "--"));
  if (args.latest) {
    resolveLatestRun(evalsRoot, { caseSelector: args.caseFilter }).then(
      (resolved) => process.stdout.write(`${formatLatestRun(resolved, args.format)}\n`),
      (error) => {
        const failure = toStructuredFailure(error, "evidence-invalid");
        process.stderr.write(`FAIL [${failure.code}]: ${failure.message}\n`);
        process.exitCode = 1;
      },
    );
  } else {
    listRunHistory(evalsRoot).then(
      (entries) => process.stdout.write(`${formatRunHistory(entries, args.format)}\n`),
      (error) => {
        const failure = toStructuredFailure(error, "evidence-invalid");
        process.stderr.write(`FAIL [${failure.code}]: ${failure.message}\n`);
        process.exitCode = 1;
      },
    );
  }
} catch (error) {
  const failure = toStructuredFailure(error, "input-invalid");
  process.stderr.write(`FAIL [${failure.code}]: ${failure.message}\n`);
  process.exitCode = 1;
}
