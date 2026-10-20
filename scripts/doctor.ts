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
import { fileURLToPath, pathToFileURL } from "node:url";
import { runIdFor } from "../src/core/experiment.ts";
import { EvalError, toStructuredFailure } from "../src/core/types.ts";
import { createAppleContainerSandbox } from "../src/sandboxes/apple-container.ts";
import { formatRecoveryResult, recoverRun } from "../src/runner/recover.ts";
import { formatDoctorReport, runReadinessDoctor } from "../src/runner/doctor.ts";

const USAGE = "usage: eval:doctor [--model <id>] [--provider <google|anthropic>] [--thinking <level>] OR eval:recover --run <exact-run-id>";

type DoctorCommand =
  | { mode: "recover"; runId: string }
  | { mode: "doctor"; provider?: string; model?: string; thinking?: string };

/**
 * @notice Selects recovery or readiness and retains the requested readiness target.
 * @param argv Command-line options, excluding the package-manager separator.
 * @returns An exact-run recovery request or target-specific readiness request.
 */
export function parseDoctorArgs(argv: readonly string[]): DoctorCommand {
  let runId: string | null = null;
  const target: { provider?: string; model?: string; thinking?: string } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (flag === "--doctor" || flag === "--readiness") {
      continue;
    }
    if (flag === "--run" || flag === "--model" || flag === "--provider" || flag === "--thinking") {
      const value = argv[index + 1];
      if (value === undefined || value.trim() === "" || value.startsWith("--")) {
        throw new EvalError("input-invalid", `${flag} requires a value. ${USAGE}`, { at: flag });
      }
      if (flag === "--run") runId = value;
      else if (flag === "--model") target.model = value;
      else if (flag === "--provider") target.provider = value;
      else target.thinking = value;
      index += 1;
      continue;
    }
    throw new EvalError("input-invalid", `unknown argument: ${String(flag)}. ${USAGE}`, { at: "argv" });
  }

  if (runId !== null) {
    if (Object.keys(target).length > 0) {
      throw new EvalError("input-invalid", "readiness target options cannot be combined with --run recovery", { at: "--run" });
    }
    return { mode: "recover", runId };
  }

  return { mode: "doctor", ...target };
}

async function main(): Promise<number> {
  const command = parseDoctorArgs(process.argv.slice(2).filter((entry) => entry !== "--"));
  const evalsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = resolve(evalsRoot, "..");

  if (command.mode === "recover") {
    const now = new Date();
    // Inspect the original run's label; recovery must never relabel or infer ownership.
    const sandbox = createAppleContainerSandbox({ runId: command.runId });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("recovery invocation deadline elapsed")), 120_000);
    timer.unref();
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
    model: command.model,
    provider: command.provider,
    thinking: command.thinking,
  });
  process.stdout.write(`${formatDoctorReport(report)}\n`);
  return report.ready ? 0 : 1;
}

const isDirectInvocation = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectInvocation) {
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
}
