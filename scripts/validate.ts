/**
 * `pnpm eval:validate` — offline input check.
 *
 * Thin composition entrypoint only: it parses argv at the process boundary, calls the
 * runner preflight, prints its report, and sets the exit code. All policy lives in
 * src/runner/preflight.ts.
 *
 * It makes no network request, creates no guest, reads no credential, and never opens
 * .env.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EvalError, toStructuredFailure } from "../src/core/types.ts";
import { formatPreflightReport, preflightInputs } from "../src/runner/preflight.ts";

const USAGE = "usage: eval:validate [--case <id>] [--skill <path>] (legacy: --suite <id> [--case <selector>])";

function parseArgs(argv: readonly string[]): { suiteId: string | null; caseSelector: string | null; skillPath: string | null } {
  let suiteId: string | null = null;
  let caseSelector: string | null = null;
  let skillPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (flag !== "--suite" && flag !== "--case" && flag !== "--skill") {
      throw new EvalError("input-invalid", `unknown argument: ${String(flag)}. ${USAGE}`, { at: "argv" });
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new EvalError("input-invalid", `${flag} requires a value. ${USAGE}`, { at: flag });
    }
    if (flag === "--skill") {
      if (skillPath !== null) throw new EvalError("input-invalid", "--skill accepts exactly one treatment skill; multiple skills are not supported yet", { at: "--skill" });
      skillPath = value;
    } else if (flag === "--suite") suiteId = value;
    else caseSelector = value;
    index += 1;
  }
  if (suiteId !== null && skillPath !== null) throw new EvalError("input-invalid", "--suite conflicts with --skill; use --case <id> --skill <path>", { at: "--suite" });
  return { suiteId, caseSelector, skillPath };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2).filter((arg) => arg !== "--"));
  const evalsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const report = await preflightInputs({
    evalsRoot,
    repoRoot: evalsRoot,
    suiteId: args.suiteId,
    caseSelector: args.caseSelector,
    skillPath: args.skillPath,
    cliLimits: {},
  });
  process.stdout.write(`${formatPreflightReport(report)}\n`);
  return report.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const failure = toStructuredFailure(error, "input-invalid");
    process.stderr.write(
      `FAIL [${failure.code}] at ${failure.at ?? "(unknown)"}: ${failure.message}\n`,
    );
    process.exitCode = 1;
  },
);
