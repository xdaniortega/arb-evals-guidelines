/**
 * `pnpm eval:recover -- --run <exact-run-id>` — exact-ID recovery.
 * `pnpm eval:doctor` — no-request readiness verification.
 *
 * Thin composition entrypoint only: parses argv and routes to either:
 * 1. Exact-ID recovery in evals/src/runner/recover.ts
 * 2. Readiness doctor in evals/src/runner/doctor.ts
 */

import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIdFor } from "../src/core/experiment.ts";
import { EvalError, toStructuredFailure } from "../src/core/types.ts";
import { createAppleContainerSandbox } from "../src/sandboxes/apple-container.ts";
import { formatRecoveryResult, recoverRun } from "../src/runner/recover.ts";
import { formatDoctorReport, runReadinessDoctor } from "../src/runner/doctor.ts";

const USAGE = "usage: eval:doctor OR eval:recover --run <exact-run-id>";

type DoctorCommand =
  | { mode: "recover"; runId: string }
  | { mode: "doctor"; provider?: string; model?: string };

function parseArgs(argv: readonly string[]): DoctorCommand {
  let runId: string | null = null;
  let isDoctor = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (flag === "--doctor" || flag === "--readiness") {
      isDoctor = true;
      continue;
    }
    if (flag === "--run") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new EvalError("input-invalid", `--run requires a value. ${USAGE}`, { at: "--run" });
      }
      runId = value;
      index += 1;
      continue;
    }
    throw new EvalError("input-invalid", `unknown argument: ${String(flag)}. ${USAGE}`, { at: "argv" });
  }

  if (runId !== null) {
    return { mode: "recover", runId };
  }

  return { mode: "doctor" };
}

async function main(): Promise<number> {
  const command = parseArgs(process.argv.slice(2).filter((entry) => entry !== "--"));
  const evalsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = resolve(evalsRoot, "..");

  if (command.mode === "recover") {
    const now = new Date();
    // Inspect the original run's label; recovery must never relabel or infer ownership.
    const sandbox = createAppleContainerSandbox({ runId: command.runId });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("recovery invocation deadline elapsed")), 120_000);
    timer.unref?.();
    const probe = await sandbox.probe(controller.signal);
    if (!probe.ready) {
      clearTimeout(timer);
      throw new EvalError("platform-unsupported", `Apple Container is not ready for real recovery: ${probe.details.map((detail) => `${detail.name}=${detail.status}`).join(", ")}`, { at: "eval:recover" });
    }
    const result = await recoverRun({
      evalsRoot,
      runId: command.runId,
      sandbox,
      recoveryId: runIdFor(now, randomBytes(4).toString("hex")),
      attemptedAt: now.toISOString(),
      deadlineAtMs: Date.now() + 120_000,
      signal: controller.signal,
    });
    clearTimeout(timer);
    process.stdout.write(`${formatRecoveryResult(result)}\n`);
    return result.ok ? 0 : 1;
  }

  // Readiness doctor mode
  const report = await runReadinessDoctor({
    evalsRoot,
    repoRoot,
  });
  process.stdout.write(`${formatDoctorReport(report)}\n`);
  return report.ready ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const failure = toStructuredFailure(error, "input-invalid");
    process.stderr.write(`FAIL [${failure.code}] at ${failure.at ?? "(unknown)"}: ${failure.message}\n`);
    process.exitCode = 1;
  },
);
