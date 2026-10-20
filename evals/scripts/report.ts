/**
 * `pnpm eval:report` — verify sealed runs and print pair outcomes and separate averages.
 *
 * Thin composition entrypoint only: parse argv, call the read model, print, exit. The
 * chain verification, the gradeability rules, and the refusal to print a delta for an
 * invalid pair all live in evals/src/artifacts/queries.ts.
 *
 * It is strictly read-only. Nothing here writes, repairs, or regenerates evidence.
 */

import { resolve } from "node:path";
import { EvalError, toStructuredFailure } from "../src/core/types.ts";
import { buildRunReport, formatRunReport } from "../src/artifacts/queries.ts";

const USAGE =
  "usage: eval:report --receipt <path to receipt.json> [--receipt <another receipt>] [--format table|markdown|json] [--details]\n" +
  "  Each run keeps its own averages. Multiple JSON receipts produce an array.\n" +
  "  --details adds operational per-arm metadata to human output; JSON is unchanged.";

interface Args {
  readonly receiptPaths: readonly string[];
  readonly format: "table" | "markdown" | "json";
  readonly details: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const receiptPaths: string[] = [];
  let format: "table" | "markdown" | "json" = "table";
  let details = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (flag === "--details") {
      details = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === "--receipt") {
      if (value === undefined || value.startsWith("--")) {
        throw new EvalError("input-invalid", `--receipt requires a value. ${USAGE}`, { at: "--receipt" });
      }
      receiptPaths.push(resolve(value));
      index += 1;
    } else if (flag === "--format") {
      if (value === undefined || value.startsWith("--")) {
        throw new EvalError("input-invalid", `--format requires a value. ${USAGE}`, { at: "--format" });
      }
      if (value !== "table" && value !== "markdown" && value !== "json") {
        throw new EvalError("input-invalid", "--format must be one of: table, markdown, json", { at: "--format" });
      }
      format = value;
      index += 1;
    } else {
      throw new EvalError("input-invalid", `unknown argument: ${String(flag)}. ${USAGE}`, { at: "argv" });
    }
  }

  if (receiptPaths.length === 0) {
    throw new EvalError("input-invalid", `--receipt is required. ${USAGE}`, { at: "--receipt" });
  }

  return { receiptPaths, format, details };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2).filter((entry) => entry !== "--"));
  const reports = await Promise.all(args.receiptPaths.map(buildRunReport));
  const rendered = reports.map((report, index) => formatRunReport(report, {
    format: args.format, details: args.details, runNumber: index + 1,
  }));
  const output = args.format === "json" && rendered.length > 1
    ? JSON.stringify(rendered.map((item) => JSON.parse(item)), null, 2)
    : rendered.join("\n\n");
  process.stdout.write(`${output}\n`);
  return reports.every((report) => report.verification.ok) ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const failure = toStructuredFailure(error, "evidence-invalid");
    process.stderr.write(`FAIL [${failure.code}] at ${failure.at ?? "(unknown)"}: ${failure.message}\n`);
    process.exitCode = 1;
  },
);
