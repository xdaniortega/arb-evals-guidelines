/**
 * `pnpm eval:inspect` — show one view of one condition from sealed evidence.
 *
 * Thin composition entrypoint only: parse argv, call the read model, print, exit. The
 * view vocabulary, the file mapping, and the chain verification live in
 * evals/src/artifacts/queries.ts.
 *
 * It is strictly read-only.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONDITION_IDS, EvalError, toStructuredFailure } from "../src/core/types.ts";
import type { ConditionId } from "../src/core/types.ts";
import {
  INSPECT_VIEWS,
  exportNativeSessionView,
  formatInspectResult,
  inspectCondition,
  resolveLatestRun,
} from "../src/artifacts/queries.ts";
import type { InspectViewName } from "../src/artifacts/queries.ts";

const USAGE =
  `usage: eval:inspect (--receipt <path> | --latest [--case <id>]) --condition ${CONDITION_IDS.join("|")} ` +
  `--view ${INSPECT_VIEWS.join("|")} [--pair <pair-id>] [--export jsonl|html|both]`;

interface Args {
  readonly receiptPath: string | null;
  readonly latest: boolean;
  readonly caseFilter: string | null;
  readonly conditionId: ConditionId;
  readonly view: InspectViewName;
  readonly pairId: string | null;
  readonly exportFormat: "jsonl" | "html" | "both" | null;
}

function parseArgs(argv: readonly string[]): Args {
  let receiptPath: string | null = null;
  let latest = false;
  let caseFilter: string | null = null;
  let conditionId: ConditionId | null = null;
  let view: InspectViewName | null = null;
  let pairId: string | null = null;
  let exportFormat: "jsonl" | "html" | "both" | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (flag === "--latest") {
      latest = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new EvalError("input-invalid", `${String(flag)} requires a value. ${USAGE}`, { at: String(flag) });
    }
    index += 1;
    if (flag === "--receipt") receiptPath = value;
    else if (flag === "--case") caseFilter = value;
    else if (flag === "--pair") pairId = value;
    else if (flag === "--export") {
      if (!["jsonl", "html", "both"].includes(value)) throw new EvalError("input-invalid", "--export must be jsonl, html, or both", { at: "--export" });
      exportFormat = value as "jsonl" | "html" | "both";
    } else if (flag === "--condition") {
      if (!(CONDITION_IDS as readonly string[]).includes(value)) {
        throw new EvalError("input-invalid", `--condition must be one of: ${CONDITION_IDS.join(", ")}`, {
          at: "--condition",
        });
      }
      conditionId = value as ConditionId;
    } else if (flag === "--view") {
      if (!(INSPECT_VIEWS as readonly string[]).includes(value)) {
        throw new EvalError("input-invalid", `--view must be one of: ${INSPECT_VIEWS.join(", ")}`, { at: "--view" });
      }
      view = value as InspectViewName;
    } else {
      throw new EvalError("input-invalid", `unknown argument: ${String(flag)}. ${USAGE}`, { at: "argv" });
    }
  }

  if (latest && receiptPath !== null) {
    throw new EvalError(
      "input-invalid",
      "--latest cannot be combined with --receipt; choose either --latest (with optional --case) or --receipt",
      { at: "--latest" },
    );
  }
  if (!latest && receiptPath === null) {
    throw new EvalError("input-invalid", `--receipt or --latest is required. ${USAGE}`, { at: "argv" });
  }
  if (conditionId === null || view === null) {
    throw new EvalError("input-invalid", `--condition and --view are required. ${USAGE}`, { at: "argv" });
  }
  if (exportFormat !== null && view !== "session") throw new EvalError("input-invalid", "--export requires --view session", { at: "--export" });
  return {
    receiptPath: receiptPath !== null ? resolve(receiptPath) : null,
    latest,
    caseFilter,
    conditionId,
    view,
    pairId,
    exportFormat,
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2).filter((entry) => entry !== "--"));
  const evalsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  let receiptPath: string;
  let pairId = args.pairId;
  if (args.latest) {
    const resolved = await resolveLatestRun(evalsRoot, { caseSelector: args.caseFilter });
    receiptPath = resolved.receiptPath;
    if (pairId === null) {
      pairId = resolved.pairs[0]?.pairId ?? null;
    }
  } else {
    receiptPath = args.receiptPath!;
  }

  const result = await inspectCondition({
    receiptPath,
    conditionId: args.conditionId,
    view: args.view,
    pairId,
  });
  process.stdout.write(`${formatInspectResult(result)}\n`);
  if (args.exportFormat !== null && result.verified) {
    const exported = await exportNativeSessionView({ receiptPath, conditionId: args.conditionId, pairId, format: args.exportFormat });
    process.stdout.write(`jsonl     ${exported.jsonlPath}\n`);
    if (exported.htmlPath !== null) process.stdout.write(`html      ${exported.htmlPath}\n`);
    process.stdout.write(`status    ${exported.completed ? "complete" : `incomplete (${exported.tailStatus})`}  redactions=${exported.redactions}\n`);
  }
  return result.verified ? 0 : 1;
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
