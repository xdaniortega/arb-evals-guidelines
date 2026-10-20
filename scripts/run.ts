/**
 * `pnpm eval` — run one paired baseline/treatment evaluation.
 *
 * Thin composition entrypoint only: it parses argv at the process boundary, constructs
 * the resolved values the runner needs, and prints the result. Every policy, algorithm,
 * ordering rule, and failure classification lives in src/runner/run.ts.
 *
 * Credential loading happens strictly at this process boundary only when `--harness pi`
 * is selected, via the gated loader that enforces Git-ignore and never mutates
 * `process.env`. When `--mode fake` is selected, no credential is read
 * and .env is never opened.
 */

import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runIdFor } from "../src/core/experiment.ts";
import type { Target } from "../src/core/experiment.ts";
import {
  EvalError,
  isTaskLimitKey,
  LIMIT_KEYS,
  PROVIDER_CREDENTIAL_VARIABLES,
  RUN_MODES,
  toStructuredFailure,
} from "../src/core/types.ts";
import type { CasePreparer, LimitKey, PartialLimits, RunMode, TaskLimit, TaskLimitKey } from "../src/core/types.ts";
import type { GuardedSecret } from "../src/core/secret-scan.ts";
import { createFakeHarness } from "../src/harnesses/fake.ts";
import { createPiHarness } from "../src/harnesses/pi/adapter.ts";
import type { Harness } from "../src/harnesses/harness.ts";
import { createFakeSandbox } from "../src/sandboxes/fake.ts";
import { createAppleContainerSandbox } from "../src/sandboxes/apple-container.ts";
import type { CredentialDeliveryRequest, Sandbox } from "../src/sandboxes/sandbox.ts";
import { createContainerValidatorRunner } from "../src/runner/container-validator.ts";
import { createInProcessValidatorRunner } from "../src/runner/validation.ts";
import type { ValidatorRunner } from "../src/runner/validation.ts";
import { getProviderCredential, loadGuardedCredentials } from "../src/runner/credentials.ts";
import { resolveTargetConfiguration, validateTargetConfiguration, validateTargetThinking } from "../src/runner/models.ts";
import {
  FAKE_TARGET,
  disposeRunWorkDir,
  preflightForRun,
  resolveEvaluatorBuild,
  resolveSourceIdentity,
  runPairedEvaluation,
  STARTUP_ALLOWANCE_MS,
  type RunProgressEvent,
} from "../src/runner/run.ts";
import { buildRunReport, formatRunReport, REPORT_JSON_SCHEMA_VERSION } from "../src/artifacts/queries.ts";

/** Invocation clock begins at CLI module entry, before credentials, probes and source hashing. */
const CLI_STARTED_AT_MS = Date.now();

/**
 * Selectable implementations.
 */
const HARNESS_IDS = ["fake", "pi"] as const;
type HarnessId = (typeof HARNESS_IDS)[number];

const SANDBOX_IDS = ["fake", "apple-container"] as const;
type SandboxId = (typeof SANDBOX_IDS)[number];

const VALIDATOR_RUNNER_IDS = ["in-process", "isolated-container"] as const;
type ValidatorRunnerId = (typeof VALIDATOR_RUNNER_IDS)[number];

const FORMAT_IDS = ["table", "markdown", "json"] as const;
type FormatId = (typeof FORMAT_IDS)[number];

const SCHEDULING_IDS = ["serial", "overlap"] as const;
type SchedulingId = (typeof SCHEDULING_IDS)[number];

const USAGE =
  `usage: eval --case <id> --skill <path> --model <id> [--mode ${RUN_MODES.join("|")}] [--repetitions <n>] ` +
  `[--harness ${HARNESS_IDS.join("|")}] [--sandbox ${SANDBOX_IDS.join("|")}] [--validator-runner ${VALIDATOR_RUNNER_IDS.join("|")}] ` +
  `[--provider <google|anthropic>] [--thinking <level>] [--serial] [--scheduling ${SCHEDULING_IDS.join("|")}] ` +
  `[--format ${FORMAT_IDS.join("|")}] [--details] [--checks] [--quiet] [--capture-reasoning] ` +
  `[--limit <key>=<value> ...] (limit keys: ${LIMIT_KEYS.join(", ")})\n` +
  `  Defaults: measured mode, Pi, Apple Container, isolated validator, and low thinking.\n` +
  `  Provider is inferred from the exact model; --provider asserts or disambiguates it.\n` +
  `  --mode fake explicitly selects zero-paid-call test doubles and does not require a model.\n` +
  `  --details adds operational metadata to human table/Markdown output; JSON is unchanged.\n` +
  `  --capture-reasoning retains model reasoning when we specifically want to analyze the model's reasoning; off by default because reasoning substantially increases session artifact size.\n` +
  `  Scheduling defaults to overlap after both-ready; --serial retains the same readiness barrier.\n` +
  `  --skill selects one complete treatment skill relative to the repository; baseline receives none.\n` +
  `  --suite <id> remains available only for existing legacy eval.json suites; it conflicts with --skill.\n` +
  `  The four task budgets (wallClockMs, maxOutputTokens, maxToolSteps, maxProviderRequests)\n` +
  `  are UNLIMITED by default: a fresh run imposes no harness cumulative cap on time,\n` +
  `  output tokens, tool steps, or provider requests. Set any of them to an explicit\n` +
  `  positive integer to opt into a finite per-arm cap, or to none (or 0) to keep it\n` +
  `  unlimited. wallClockMs is PER CHILD, starting at that child's prompt. There is no\n` +
  `  fixed maximum arm duration and no overall run-time ceiling.\n` +
  `  Authored case/suite/profile configuration can still declare a finite cap that a\n` +
  `  fresh run inherits; --limit <key> overrides it, including back to none (unlimited).\n` +
  `  Resource/isolation bounds (cpus, memoryMiB, pids, diskMiB, export/workspace bytes)\n` +
  `  are always finite and cannot be disabled. Startup, capture and cleanup retain\n` +
  `  independent infrastructure deadlines. An unlimited arm still observes cancellation.`;

export interface TestOnlyRunComposition {
  /** Test-only boundary: accepted only under the mandatory zero-paid-call preload. */
  readonly testOnly: true;
  readonly guardedSecrets: readonly GuardedSecret[];
  readonly credentials: readonly CredentialDeliveryRequest[];
  /** Exclusively test-owned journal directory; prevents inspection of unrelated runs. */
  readonly stateDir: string;
  /** Focused fault seams are available only at this guarded scripted L2 boundary. */
  readonly preparer?: CasePreparer;
  readonly faults?: { readonly simulateSurvivingSecretHit?: boolean };
  /** Raw lifecycle facts for bounded test-only measurement; production still owns emission. */
  readonly onProgress?: (event: RunProgressEvent) => void;
  createHarness(): Harness;
  createSandbox(runId: string): Sandbox;
  createValidatorRunner(runId: string): ValidatorRunner;
}

export interface RunCliOutcome {
  readonly code: number;
  readonly receiptPath: string | null;
  readonly runDir: string | null;
}

interface Args {
  readonly suiteId: string | null;
  readonly skillPath: string | undefined;
  readonly caseSelector: string;
  readonly mode: RunMode;
  readonly repetitions: number;
  readonly cliLimits: PartialLimits;
  readonly harnessId: HarnessId;
  readonly sandboxId: SandboxId;
  readonly validatorRunnerId: ValidatorRunnerId;
  readonly provider: string | null;
  readonly model: string | null;
  readonly thinking: string | null;
  readonly schedulingPolicy: "serial" | "overlap";
  readonly format: FormatId;
  readonly details: boolean;
  readonly checks: boolean;
  readonly quiet: boolean;
  readonly captureReasoning: boolean;
}

/**
 * @notice Validates CLI options and normalizes explicit unlimited task budgets.
 * @param argv Options after the executable name.
 * @returns Parsed evaluation settings and limit overrides.
 */
export function parseArgs(argv: readonly string[]): Args {
  let suiteId: string | null = null;
  let skillPath: string | undefined;
  let caseSelector: string | null = null;
  let mode: RunMode = "measured";
  let repetitions = 1;
  let harnessId: HarnessId | undefined;
  let sandboxId: SandboxId | undefined;
  let validatorRunnerId: ValidatorRunnerId | undefined;
  const cliLimits: { -readonly [K in LimitKey]?: K extends TaskLimitKey ? TaskLimit : number } = {};
  let provider: string | null = null;
  let model: string | null = null;
  let thinking: string | null = null;
  let schedulingPolicy: "serial" | "overlap" = "overlap";
  let format: FormatId = "table";
  let details = false;
  let checks = false;
  let quiet = false;
  let captureReasoning = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (flag === "--serial") {
      schedulingPolicy = "serial";
      continue;
    }
    if (flag === "--quiet") {
      quiet = true;
      continue;
    }
    if (flag === "--details") {
      details = true;
      continue;
    }
    if (flag === "--checks") {
      checks = true;
      continue;
    }
    if (flag === "--capture-reasoning") {
      captureReasoning = true;
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new EvalError("input-invalid", `${String(flag)} requires a value. ${USAGE}`, { at: String(flag) });
    }
    index += 1;

    if (flag === "--suite") suiteId = value;
    else if (flag === "--skill") {
      if (skillPath !== undefined) throw new EvalError("input-invalid", "--skill accepts exactly one treatment skill; multiple skills are not supported yet", { at: "--skill" });
      skillPath = value;
    }
    else if (flag === "--case") caseSelector = value;
    else if (flag === "--mode") {
      if (!(RUN_MODES as readonly string[]).includes(value)) {
        throw new EvalError("input-invalid", `--mode must be one of: ${RUN_MODES.join(", ")}`, { at: "--mode" });
      }
      mode = value as RunMode;
    } else if (flag === "--harness") {
      if (!(HARNESS_IDS as readonly string[]).includes(value)) {
        throw new EvalError("input-invalid", `--harness must be one of: ${HARNESS_IDS.join(", ")}`, { at: "--harness" });
      }
      harnessId = value as HarnessId;
    } else if (flag === "--sandbox") {
      if (!(SANDBOX_IDS as readonly string[]).includes(value)) {
        throw new EvalError("input-invalid", `--sandbox must be one of: ${SANDBOX_IDS.join(", ")}`, { at: "--sandbox" });
      }
      sandboxId = value as SandboxId;
    } else if (flag === "--validator-runner") {
      if (!(VALIDATOR_RUNNER_IDS as readonly string[]).includes(value)) {
        throw new EvalError(
          "input-invalid",
          `--validator-runner must be one of: ${VALIDATOR_RUNNER_IDS.join(", ")}`,
          { at: "--validator-runner" },
        );
      }
      validatorRunnerId = value as ValidatorRunnerId;
    } else if (flag === "--provider") {
      provider = value;
    } else if (flag === "--model") {
      model = value;
    } else if (flag === "--thinking") {
      thinking = value;
    } else if (flag === "--scheduling") {
      if (!(SCHEDULING_IDS as readonly string[]).includes(value)) {
        throw new EvalError("input-invalid", `--scheduling must be one of: ${SCHEDULING_IDS.join(", ")}`, { at: "--scheduling" });
      }
      schedulingPolicy = value as "serial" | "overlap";
    } else if (flag === "--format") {
      if (!(FORMAT_IDS as readonly string[]).includes(value)) {
        throw new EvalError("input-invalid", `--format must be one of: ${FORMAT_IDS.join(", ")}`, { at: "--format" });
      }
      format = value as FormatId;
    } else if (flag === "--repetitions") {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new EvalError("input-invalid", "--repetitions must be a positive integer", { at: "--repetitions" });
      }
      repetitions = parsed;
    } else if (flag === "--limit") {
      const separator = value.indexOf("=");
      const key = separator === -1 ? "" : value.slice(0, separator);
      const raw = separator === -1 ? "" : value.slice(separator + 1);
      if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
        throw new EvalError("limit-invalid", `--limit key must be one of: ${LIMIT_KEYS.join(", ")}`, { at: "--limit" });
      }
      if (isTaskLimitKey(key)) {
        // `none` or `0` means UNLIMITED: no harness cumulative cap for this task budget.
        // Stored explicitly as null; never a huge sentinel.
        if (raw === "none" || raw === "0") {
          cliLimits[key] = null;
          continue;
        }
        const parsedTask = Number(raw);
        if (!Number.isSafeInteger(parsedTask) || parsedTask <= 0) {
          throw new EvalError("limit-invalid", `--limit ${key} must be a positive integer, 0, or none (unlimited)`, { at: "--limit" });
        }
        cliLimits[key] = parsedTask;
        continue;
      }
      // Resource/isolation bounds cannot be disabled through none/0/null.
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new EvalError("limit-invalid", `--limit ${key} must be a positive integer`, { at: "--limit" });
      }
      cliLimits[key as LimitKey] = parsed;
    } else {
      throw new EvalError("input-invalid", `unknown argument: ${String(flag)}. ${USAGE}`, { at: "argv" });
    }
  }

  if (caseSelector === null || (suiteId === null && skillPath === undefined)) {
    throw new EvalError("input-invalid", `--case and --skill are required (legacy suites may use --suite instead of --skill). ${USAGE}`, { at: "argv" });
  }
  harnessId ??= mode === "measured" ? "pi" : "fake";
  sandboxId ??= mode === "measured" ? "apple-container" : "fake";
  validatorRunnerId ??= mode === "measured" ? "isolated-container" : "in-process";
  if (suiteId !== null && skillPath !== undefined) throw new EvalError("input-invalid", "--suite conflicts with --skill; select a canonical case with --case <id> --skill <path>", { at: "--suite" });
  if (mode === "measured") {
    const doubles: string[] = [];
    if (harnessId === "fake") doubles.push("harness:fake");
    if (sandboxId === "fake") doubles.push("sandbox:fake");
    if (validatorRunnerId === "in-process") doubles.push("validator-runner:in-process");
    if (doubles.length > 0) {
      throw new EvalError(
        "not-implemented",
        `--mode measured refuses test doubles: ${doubles.join(", ")}. Use --mode fake, whose evidence is self-labeled as test-double-produced.`,
        { at: "--mode" },
      );
    }
  }
  if (validatorRunnerId === "isolated-container" && sandboxId !== "apple-container") {
    throw new EvalError("input-invalid", "--validator-runner isolated-container requires --sandbox apple-container", { at: "--validator-runner" });
  }

  if (mode === "measured" || harnessId === "pi") {
    if (model === null) {
      throw new EvalError("input-invalid", "--model is required for measured or scripted Pi runs; provider is inferred from the exact model", { at: "--model" });
    }
  }

  return {
    suiteId,
    skillPath,
    caseSelector,
    mode,
    repetitions,
    cliLimits,
    harnessId,
    sandboxId,
    validatorRunnerId,
    provider,
    model,
    thinking,
    schedulingPolicy,
    format,
    details,
    checks,
    quiet,
    captureReasoning,
  };
}

/**
 * @notice Formats a run lifecycle event with elapsed time for CLI progress.
 * @param event Lifecycle event emitted by the runner.
 * @param startMs Invocation start time in epoch milliseconds.
 * @returns A single human-readable progress line.
 */
export function formatProgressEvent(event: RunProgressEvent, startMs: number): string {
  const elapsedSec = ((event.timestampMs - startMs) / 1000).toFixed(1);
  const prefix = `[+${elapsedSec}s]`;
  switch (event.type) {
    case "request-validated":
      return `${prefix} request validated`;
    case "preparation-started":
      return `${prefix} trusted preparation started`;
    case "preparation-completed":
      return `${prefix} trusted preparation completed`;
    case "freeze-started":
      return `${prefix} freeze started`;
    case "freeze-completed":
      return `${prefix} freeze completed`;
    case "image-cache-hit":
      return `${prefix} image cache hit: profile=${event.profileId} digest=${event.digest.slice(0, 19)}`;
    case "image-build-started":
      return `${prefix} image build started: profile=${event.profileId}`;
    case "image-build-completed":
      return `${prefix} image build completed: profile=${event.profileId} digest=${event.digest.slice(0, 19)}`;
    case "pair-preparing":
      return `${prefix} pair ${event.pairIndex}/${event.totalPairs} preparing`;
    case "both-arms-ready":
      return `${prefix} pair ${event.pairIndex}/${event.totalPairs} both arms ready`;
    case "arm-execution-started":
      return `${prefix} pair ${event.pairIndex} [${event.arm}] execution started`;
    case "arm-execution-completed":
      return `${prefix} pair ${event.pairIndex} [${event.arm}] completed: outcome=${event.outcome} (${(event.durationMs / 1000).toFixed(1)}s)`;
    case "capture-grading-started":
      return `${prefix} pair ${event.pairIndex} [${event.arm ?? "pair"}] capture and grading started`;
    case "capture-grading-completed":
      return `${prefix} pair ${event.pairIndex} [${event.arm ?? "pair"}] capture and grading completed: ${event.disposition}`;
    case "cleanup-started":
      return `${prefix} pair ${event.pairIndex ?? 1} cleanup started`;
    case "cleanup-verified":
      return event.verified
        ? `${prefix} pair ${event.pairIndex ?? 1} cleanup verified`
        : `${prefix} pair ${event.pairIndex ?? 1} cleanup FAILED${event.failureClass ? ` failure=${event.failureClass}` : ""}`;
    case "sealing-started":
      return `${prefix} evidence sealing started`;
    case "finalization-completed":
      return `${prefix} finalization completed: success=${event.success}${event.error ? ` error=${event.error}` : ""}`;
  }
}

/**
 * @notice Runs the public eval CLI composition, optionally replacing only test boundaries.
 * @param argv Parsed once by the same strict public argument boundary.
 * @param testComposition Guarded zero-paid-call composition available only to test children.
 * @returns Process exit status and exact retained evidence paths, when a run was claimed.
 */
export async function runCli(
  argv: readonly string[],
  testComposition?: TestOnlyRunComposition,
): Promise<RunCliOutcome> {
  const args = parseArgs(argv.filter((entry) => entry !== "--"));
  if (testComposition !== undefined) {
    if (testComposition.testOnly !== true || process.env.EVAL_TEST_GUARD !== "1") {
      throw new EvalError("parity-violation", "injected CLI composition is restricted to the zero-paid-call test boundary", { at: "testComposition" });
    }
  }
  const boundaryController = new AbortController();
  const evalsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = evalsRoot;
  const now = new Date();
  const runId = runIdFor(now, randomBytes(4).toString("hex"));
  let workDir = "";
  // Startup-only hard backstop: bounds pre-dispatch liveness (preflight, credentials,
  // probes, image build). It is NOT a whole-run ceiling and is NOT a function of the
  // per-arm wall clock; it is cleared once the run is underway so an unlimited arm has no
  // finite total timer. A finite arm is bounded by its own wall clock + infra allowances;
  // setup, capture and cleanup retain their separate operation deadlines.
  let startupBackstopTimer: ReturnType<typeof setTimeout> | undefined = installHardBackstop(STARTUP_ALLOWANCE_MS);
  try {
    const mode = args.mode;
    const suiteId = args.suiteId;
    const caseSelector = args.caseSelector;
    const repetitions = args.repetitions;
    const harnessId = args.harnessId as HarnessId;
    const sandboxId = args.sandboxId as SandboxId;
    const validatorRunnerId = args.validatorRunnerId as ValidatorRunnerId;
    const schedulingPolicy = args.schedulingPolicy;

    if (mode === "fake" && harnessId === "pi" && testComposition === undefined) {
      throw new EvalError("not-implemented", "--mode fake with --harness pi requires the guarded scripted test composition; public fake runs cannot call real providers", { at: "--harness" });
    }

    let target: Target;
    if (args.model !== null) {
      target = resolveTargetConfiguration({ model: args.model, provider: args.provider, thinking: args.thinking });
    } else {
      // An omitted model is permitted only for the explicit deterministic fake harness.
      if (args.provider !== null && args.provider !== "google" && args.provider !== "anthropic") {
        throw new EvalError("input-invalid", `unsupported provider '${args.provider}'`, { at: "target.provider" });
      }
      target = { ...FAKE_TARGET, provider: args.provider ?? FAKE_TARGET.provider, thinking: (args.thinking ?? FAKE_TARGET.thinking) as Target["thinking"] };
      validateTargetThinking(target.provider, target.model, target.thinking);
    }

    // Resolve case/profile/CLI limits before credentials and pass this exact selection
    // to the runner.
    const preflightInputs = await preflightForRun({
      evalsRoot, repoRoot, suiteId: suiteId ?? undefined, caseSelector,
      skillPath: args.skillPath, cliLimits: args.cliLimits,
    });
    let guardedSecrets: readonly GuardedSecret[] = [];
    let credentials: readonly CredentialDeliveryRequest[] = [];

    if (testComposition !== undefined) {
      guardedSecrets = testComposition.guardedSecrets;
      credentials = testComposition.credentials;
    } else if (harnessId === "pi") {
      const envPath = join(evalsRoot, ".env");
      const loaded = await loadGuardedCredentials(envPath, repoRoot);
      const variable = PROVIDER_CREDENTIAL_VARIABLES[target.provider];
      const value = getProviderCredential(target.provider, loaded.credentials);
      if (value === null) {
        throw new EvalError(
          "credential-missing",
          `credential variable '${variable}' is missing or blank in ${envPath} for provider '${target.provider}'`,
          { at: variable },
        );
      }
      guardedSecrets = loaded.guardedSecrets;
      credentials = [{ variable, value }];
    }
    if (workDir === "") workDir = await mkdtemp(join(tmpdir(), `eval-work-${runId}-`));
    const harness: Harness = testComposition?.createHarness() ??
      (harnessId === "pi" ? createPiHarness() : createFakeHarness());

    const sandbox: Sandbox = testComposition?.createSandbox(runId) ??
      (sandboxId === "apple-container"
        ? createAppleContainerSandbox({ runId, labels: { "eval-run": runId } })
        : createFakeSandbox());
    const validatorRunner: ValidatorRunner = testComposition?.createValidatorRunner(runId) ??
      (validatorRunnerId === "isolated-container"
        ? createContainerValidatorRunner({ runId, labels: { "eval-run": runId } })
        : createInProcessValidatorRunner());
    if (testComposition !== undefined && (mode !== "fake" || harnessId !== "pi" || sandboxId !== "apple-container" || validatorRunnerId !== "isolated-container" || !harness.testDouble || sandbox.testDouble || validatorRunner.testDouble)) {
      throw new EvalError("parity-violation", "L2 composition must replace only completion; sandbox and validator stay production implementations", { at: "testComposition" });
    }

    const harnessProbe = await harness.probe(boundaryController.signal);
    if (!harnessProbe.ready) {
      process.stderr.write(
        [
          `FAIL [platform-unsupported] harness ${harness.id} is not ready:`,
          ...harnessProbe.details.map((detail) => `  ${detail.name}: ${detail.status} — ${detail.detail}`),
          "",
        ].join("\n"),
      );
      return { code: 1, receiptPath: null, runDir: null };
    }

    const probe = await sandbox.probe(boundaryController.signal);
    if (!probe.ready) {
      process.stderr.write(
        [
          `FAIL [platform-unsupported] sandbox ${sandbox.id} is not ready:`,
          ...probe.details.map((detail) => `  ${detail.name}: ${detail.status} — ${detail.detail}`),
          "",
        ].join("\n"),
      );
      return { code: 1, receiptPath: null, runDir: null };
    }

    const runStartedAt = CLI_STARTED_AT_MS;
    const onProgress = args.quiet && testComposition?.onProgress === undefined
      ? undefined
      : (event: RunProgressEvent) => {
          if (!args.quiet) process.stderr.write(`${formatProgressEvent(event, runStartedAt)}\n`);
          testComposition?.onProgress?.(event);
        };

    // The run is underway: pre-dispatch liveness is complete. Clear the startup backstop
    // without arming any total-run timer. From here a finite arm is bounded by its own
    // wall clock and infra allowances; an unlimited arm has no finite total timer.
    clearTimeout(startupBackstopTimer);
    startupBackstopTimer = undefined;

    const result = await runPairedEvaluation({
      evalsRoot,
      repoRoot,
      suiteId: suiteId ?? undefined,
      caseSelector,
      skillPath: args.skillPath,
      mode,
      repetitions,
      cliLimits: args.cliLimits,
      invocationStartedAtMs: CLI_STARTED_AT_MS,
      target,
      runId,
      resourceNonce: randomBytes(4).toString("hex"),
      createdAt: now.toISOString(),
      source: resolveSourceIdentity(repoRoot),
      evaluatorBuild: await resolveEvaluatorBuild(evalsRoot),
      harness,
      sandbox,
      validatorRunner,
      workDir,
      stateDir: testComposition?.stateDir,
      preparer: testComposition?.preparer,
      faults: testComposition?.faults,
      guardedSecrets,
      credentials,
      installSignalHandlers: true,
      signal: boundaryController.signal,
      schedulingPolicy,
      captureReasoning: args.captureReasoning,
      onProgress,
      preflightInputs,
    });

    const report = await buildRunReport(result.receiptPath);
    const formatted = formatRunReport(report, { format: args.format, details: args.details, checks: args.checks });
    process.stdout.write(`${formatted}\n`);

    return {
      code: report.verification.ok && result.status === "complete" ? 0 : 1,
      receiptPath: result.receiptPath,
      runDir: result.runDir,
    };
  } finally {
    clearTimeout(startupBackstopTimer);
    if (workDir !== "") await disposeRunWorkDir(workDir);
  }
}

/**
 * Startup-only process-level hard backstop.
 *
 * WHY it exists: cooperative cancellation aborts an AbortController, which only works if
 * something is actually awaiting it. Pre-dispatch liveness work (preflight, credentials,
 * probes, image build) can wedge inside an unbounded external wait (a stuck CLI, a guest
 * that never answers) and ignore the signal. This timer cannot be starved by a pending
 * await: if it fires, startup has exceeded its bounded budget and the only correct action
 * is to say so loudly and exit non-zero.
 *
 * It bounds STARTUP ONLY and is cleared once the run is underway, so there is no overall
 * run-time ceiling and an unlimited arm is never capped by a hidden finite total timer.
 * It is unref'd, so it never keeps an otherwise-finished process alive.
 */
function installHardBackstop(resolvedBudgetMs: number): ReturnType<typeof setTimeout> {
  const remainingMs = Math.max(0, CLI_STARTED_AT_MS + resolvedBudgetMs - Date.now());
  const timer = setTimeout(() => {
    const seconds = (resolvedBudgetMs / 1000).toFixed(1);
    process.stderr.write(
      `TIMEOUT: hard backstop of ${seconds}s reached; the run did not stop cooperatively. ` +
        `Exiting non-zero. Leftover guests or networks, if any, can be reclaimed with ` +
        `\`pnpm eval:recover --run <run-id>\`.\n`,
    );
    process.exit(1);
  }, remainingMs);
  timer.unref();
  return timer;
}

const isDirectInvocation = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectInvocation) {
  runCli(process.argv.slice(2)).then(
    (outcome) => {
      process.exitCode = outcome.code;
    },
    (error: unknown) => {
      const failure = toStructuredFailure(error, "input-invalid");
      const isJson = process.argv.includes("--format") && process.argv[process.argv.indexOf("--format") + 1] === "json";
      if (isJson) {
        process.stdout.write(
          JSON.stringify(
            {
              schemaVersion: REPORT_JSON_SCHEMA_VERSION,
              success: false,
              receipt: null,
              summary: null,
              failures: [failure],
            },
            null,
            2,
          ) + "\n",
        );
      } else {
        process.stderr.write(`FAIL [${failure.code}] at ${failure.at ?? "(unknown)"}: ${failure.message}\n`);
      }
      process.exitCode = 1;
    },
  );
}
