/**
 * `pnpm eval:publish` — verify sealed run evidence, derive destination skill,
 * and publish the scored report to that skill's EVALS.md within stable markers.
 *
 * It updates only the bounded generated section between HTML comments:
 * <!-- AF-EVAL:BEGIN generated --> ... <!-- AF-EVAL:END generated -->
 * Preserves all authored coverage notes outside markers verbatim.
 * Refuses to publish if evidence verification fails or destination cannot be derived.
 *
 * It is strictly read-only towards evidence. Nothing here mutates run evidence.
 */

import { resolve } from "node:path";
import { EvalError, toStructuredFailure } from "../src/core/types.ts";
import { publishRun } from "../src/artifacts/publish.ts";

const USAGE =
  "usage: eval:publish --receipt <path to receipt.json> [--pair <pair-id|rNNN>] [--checks] [--repo-root <path> | --skill-dir <path>]\n" +
  "  --skill-dir <path> writes EVALS.md into that skill directory (e.g. a ../arbitrum-skills-evals checkout).\n" +
  "  Verifies run evidence, derives destination skill, and updates bounded EVALS.md section.\n" +
  "  Without --pair: a single-pair run publishes that pair; a multi-pair run publishes the\n" +
  "  mean over every pair. With --pair <id>: publishes that one named pair (full pair ID or\n" +
  "  short rNNN label).\n" +
  "  --checks includes topic-level check breakdown table.";

interface Args {
  readonly receiptPath: string;
  readonly checks: boolean;
  readonly repoRoot?: string;
  readonly targetSkillDir?: string;
  readonly pairId?: string;
}

function parseArgs(argv: readonly string[]): Args {
  let receiptPath: string | undefined;
  let checks = false;
  let repoRoot: string | undefined;
  let targetSkillDir: string | undefined;
  let pairId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (flag === "--checks") {
      checks = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === "--receipt") {
      if (value === undefined || value.startsWith("--")) {
        throw new EvalError("input-invalid", `--receipt requires a value. ${USAGE}`, { at: "--receipt" });
      }
      receiptPath = resolve(value);
      index += 1;
    } else if (flag === "--repo-root") {
      if (value === undefined || value.startsWith("--")) {
        throw new EvalError("input-invalid", `--repo-root requires a value. ${USAGE}`, { at: "--repo-root" });
      }
      repoRoot = resolve(value);
      index += 1;
    } else if (flag === "--skill-dir") {
      if (value === undefined || value.startsWith("--")) {
        throw new EvalError("input-invalid", `--skill-dir requires a value. ${USAGE}`, { at: "--skill-dir" });
      }
      targetSkillDir = resolve(value);
      index += 1;
    } else if (flag === "--pair") {
      if (pairId !== undefined) {
        throw new EvalError("input-invalid", `--pair given twice. ${USAGE}`, { at: "--pair" });
      }
      if (value === undefined || value.startsWith("--")) {
        throw new EvalError("input-invalid", `--pair requires a value. ${USAGE}`, { at: "--pair" });
      }
      pairId = value;
      index += 1;
    } else {
      throw new EvalError("input-invalid", `unknown argument: ${String(flag)}. ${USAGE}`, { at: "argv" });
    }
  }

  if (!receiptPath) {
    throw new EvalError("input-invalid", `--receipt is required. ${USAGE}`, { at: "--receipt" });
  }

  if (repoRoot !== undefined && targetSkillDir !== undefined) {
    throw new EvalError("input-invalid", `--repo-root conflicts with --skill-dir. ${USAGE}`, { at: "--skill-dir" });
  }

  return { receiptPath, checks, repoRoot, ...(targetSkillDir !== undefined ? { targetSkillDir } : {}), ...(pairId !== undefined ? { pairId } : {}) };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2).filter((entry) => entry !== "--"));
  const result = await publishRun(args);
  const suffix =
    result.mode === "mean"
      ? ` (mean of ${result.pairIds.length} pairs)`
      : ` pair ${result.pairIds[0]?.slice(result.pairIds[0].lastIndexOf("-") + 1) ?? ""}`;
  process.stdout.write(`Published evaluation results for run ${result.runId}${suffix} to ${result.relativeTargetPath}\n`);
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
