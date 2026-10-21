/**
 * The isolated one-shot validator: grading in a fresh, bounded, single-use container.
 *
 * WHY it is separate from the in-process runner: the in-process runner is honest but is
 * a test double, because "the validator had no network and no credential" is only an
 * argument about the host process, not an enforced property. Here it is enforced:
 *
 * - a NEW container per grading, from the same locked image, destroyed afterwards;
 * - egress profile `none`, so the guest entrypoint sets `OUTPUT DROP` for both IP
 *   families, plus `--no-dns`, so no name resolution exists at all;
 * - no credential is delivered and no environment entry carries one;
 * - the candidate is passed as immutable base64 strings on stdin, never as a writable
 *   file the validator could edit and then grade;
 * - the validator itself is OWNER-AUTHORED trusted code, so no guest-authored code runs
 *   anywhere — not on the host, and not in this container either.
 *
 * The container is bounded in wall clock by the caller's deadline and is torn down and
 * verified absent even when grading fails.
 */

import { randomBytes } from "node:crypto";
import { EvalError, decodeValidationOutcome, toStructuredFailure } from "../core/types.ts";
import type { StructuredFailure, ValidationOutcome } from "../core/types.ts";
import {
  GUEST_CONTROL_DIR,
  GUEST_ENTRYPOINT,
  GUEST_SUPERVISOR,
  GUEST_GID,
  GUEST_UID,
  runContainerCli,
} from "../sandboxes/apple-container.ts";
import type { CliResult } from "../sandboxes/apple-container.ts";
import type { ValidatorRequest, ValidatorRun, ValidatorRunner } from "./validation.ts";

export const CONTAINER_VALIDATOR_RUNNER_ID = "isolated-container";

/** Journal hook: the runner creates external resources and they must be recorded. */
export type ValidatorResourceHook = (record: {
  readonly event: "intent" | "observed";
  readonly action: "create" | "destroy";
  readonly kind: "guest" | "network";
  readonly name: string;
  readonly status: string | null;
}) => Promise<void>;

export interface ContainerValidatorOptions {
  /**
   * Exact image reference the one-shot container runs from. Usually absent at
   * construction and supplied by `attachRun` once the run has built its image.
   */
  readonly imageReference?: string;
  readonly runId: string;
  readonly cliPath?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly commandTimeoutMs?: number;
  /** Bounded CPU/memory/process budget for the grading container. */
  readonly limits?: { readonly cpus: number; readonly memoryMiB: number; readonly pids: number };
}

/**
 * An optional capability, not part of the `ValidatorRunner` interface.
 *
 * A validator runner that creates real containers needs two things only the run knows:
 * the image digest/reference the pair was built from, and the journal every external
 * effect must be recorded in BEFORE it is invoked. The runner asks for them through this
 * one hook rather than by widening the interface every implementation must satisfy.
 */
export interface RunAttachableValidatorRunner {
  attachRun(context: { readonly imageReference: string; readonly record: ValidatorResourceHook }): void;
}

export function isRunAttachable(runner: unknown): runner is RunAttachableValidatorRunner {
  return typeof (runner as { attachRun?: unknown }).attachRun === "function";
}

export interface ContainerValidatorRunner extends ValidatorRunner, RunAttachableValidatorRunner {
  /** Exact identities this runner created, for cleanup assertions. */
  readonly created: readonly string[];
}

function infrastructureOutcome(failure: StructuredFailure): ValidationOutcome {
  return {
    status: "infrastructure-failure",
    score: null,
    fullPass: null,
    checks: [{ id: "validator-infrastructure", passed: false, message: failure.message.slice(0, 1_000) }],
  };
}

function lastJsonLine(text: string): unknown {
  const lines = text.split("\n").filter((line) => line.trim().startsWith("{"));
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

export function createContainerValidatorRunner(options: ContainerValidatorOptions): ContainerValidatorRunner {
  const cliPath = options.cliPath ?? "container";
  const timeoutMs = options.commandTimeoutMs ?? 300_000;
  const limits = options.limits ?? { cpus: 2, memoryMiB: 1_024, pids: 128 };
  const labels = Object.entries(options.labels ?? { "eval-run": options.runId }).map(
    ([key, value]) => `${key}=${value}`,
  );
  const created: string[] = [];
  let journalHook: ValidatorResourceHook | null = null;
  let imageReference = options.imageReference ?? null;
  const record: ValidatorResourceHook = async (entry) => {
    if (journalHook !== null) await journalHook(entry);
  };

  return {
    id: CONTAINER_VALIDATOR_RUNNER_ID,
    // Real isolation, so evidence produced with it is not test-double evidence.
    testDouble: false,
    created,
    attachRun(context: { imageReference: string; record: ValidatorResourceHook }): void {
      imageReference = context.imageReference;
      journalHook = context.record;
    },
    async run(request: ValidatorRequest): Promise<ValidatorRun> {
      const startedAt = Date.now();
      const nonce = randomBytes(4).toString("hex");
      const guestName = `eval-vguest-${nonce}`;
      const networkName = `eval-vnet-${nonce}`;
      const deadlineMs =
        typeof request.deadlineMs === "number" && Number.isFinite(request.deadlineMs) && request.deadlineMs > 0
          ? request.deadlineMs
          : timeoutMs;
      const gradingDeadlineAtMs = startedAt + deadlineMs;
      const cleanupDeadlineAtMs = request.cleanupDeadlineAtMs ?? (gradingDeadlineAtMs + Math.min(timeoutMs, 30_000));
      let networkAttempted = false;
      let guestAttempted = false;
      let runResult: ValidatorRun | null = null;
      let cleanupFailure: StructuredFailure | null = null;
      const commandOptions = (deadlineAtMs: number, signal?: AbortSignal) => ({ cliPath, timeoutMs, deadlineAtMs, ...(signal === undefined ? {} : { signal }) });
      try {
        if (request.signal?.aborted === true) {
          throw new EvalError("interrupted", "the validator run was aborted", { at: "validator run" });
        }
        if (imageReference === null) {
          throw new EvalError(
            "validator-infrastructure",
            "the isolated validator has no image reference; the run must call attachRun() after building its image",
            { at: CONTAINER_VALIDATOR_RUNNER_ID },
          );
        }
        // Grading MUST use frozen bytes (bundle or legacy source) directly; mutable source reading is removed.
        let stdinPayload: unknown;
        if (request.validatorBundle !== undefined && request.validatorBundle.length > 0) {
          stdinPayload = {
            validatorBundle: request.validatorBundle,
            validatorEntry: request.validatorEntryPath ?? "validator.ts",
            input: request.input,
          };
        } else if (typeof request.validatorSource === "string" && request.validatorSource !== "") {
          stdinPayload = {
            validatorSource: request.validatorSource,
            input: request.input,
          };
        } else {
          throw new EvalError(
            "validator-infrastructure",
            "the isolated validator requires validatorBundle or validatorSource; mutable source reading is disabled",
            { at: CONTAINER_VALIDATOR_RUNNER_ID },
          );
        }

        await record({ event: "intent", action: "create", kind: "network", name: networkName, status: null });
        networkAttempted = true;
        created.push(`network:${networkName}`);
        const network = await runContainerCli(
          ["network", "create", ...labels.flatMap((label) => ["--label", label]), networkName],
          commandOptions(gradingDeadlineAtMs, request.signal),
        );
        if (network.code !== 0) {
          throw new EvalError(
            "validator-infrastructure",
            `could not create the isolated validator network: ${network.stderr.trim().slice(0, 300)}`,
            { at: networkName },
          );
        }
        await record({ event: "observed", action: "create", kind: "network", name: networkName, status: "created" });

        await record({ event: "intent", action: "create", kind: "guest", name: guestName, status: null });
        guestAttempted = true;
        created.push(`guest:${guestName}`);
        const args = [
          "run",
          "--interactive",
          "--name",
          guestName,
          "--network",
          networkName,
          "--read-only",
          "--tmpfs",
          GUEST_CONTROL_DIR,
          "--tmpfs",
          "/tmp",
          "--cpus",
          String(limits.cpus),
          "--memory",
          `${String(limits.memoryMiB)}M`,
          "--ulimit",
          `nproc=${String(limits.pids)}`,
          // No resolver at all: grading needs no name and must not be able to look one up.
          "--no-dns",
          "--cap-drop",
          "ALL",
          "--cap-add",
          "NET_ADMIN",
          "--cap-add",
          "SETUID",
          "--cap-add",
          "SETGID",
          "--entrypoint",
          GUEST_ENTRYPOINT,
          ...labels.flatMap((label) => ["--label", label]),
          "--env",
          "EVAL_EGRESS_PROFILE=none",
          imageReference,
          "node",
          GUEST_SUPERVISOR,
          "validate",
        ];
        const result: CliResult = await runContainerCli(args, {
          ...commandOptions(gradingDeadlineAtMs, request.signal),
          stdin: JSON.stringify(stdinPayload),
        });
        await record({ event: "observed", action: "create", kind: "guest", name: guestName, status: "created" });
        if (result.timedOut) {
          throw new EvalError(
            "validator-infrastructure",
            `the isolated validator exceeded its bounded deadline of ${deadlineMs}ms and was killed`,
            { at: "validator run" },
          );
        }
        if (result.code !== 0 || result.aborted || result.truncated) {
          throw new EvalError("validator-infrastructure", `the isolated validator transport failed (exit ${String(result.code)}, aborted=${String(result.aborted)}, truncated=${String(result.truncated)})`, { at: "validator run" });
        }
        const frame = lastJsonLine(result.stdout) as { ok?: boolean; error?: string; outcome?: unknown } | null;
        if (frame === null) {
          throw new EvalError(
            "validator-infrastructure",
            `the isolated validator produced no protocol frame: ${result.stderr.trim().slice(0, 300)}`,
            { at: "validator run" },
          );
        }
        if (frame.ok !== true) {
          throw new EvalError(
            "validator-infrastructure",
            `the isolated validator failed: ${String(frame.error ?? "unknown")}`,
            { at: "validator run" },
          );
        }
        const outcome = decodeValidationOutcome(frame.outcome, "validator outcome");
        runResult = {
          runnerId: CONTAINER_VALIDATOR_RUNNER_ID,
          testDouble: false,
          outcome,
          failure: null,
          durationMs: Date.now() - startedAt,
        };
      } catch (error: unknown) {
        const failure = toStructuredFailure(error, "validator-infrastructure");
        runResult = {
          runnerId: CONTAINER_VALIDATOR_RUNNER_ID,
          testDouble: false,
          outcome: infrastructureOutcome(failure),
          failure,
          durationMs: Date.now() - startedAt,
        };
      } finally {
        // Single use: the container and its network are destroyed on every path, by
        // exact identity, and their absence is verified.
        await record({ event: "intent", action: "destroy", kind: "guest", name: guestName, status: null }).catch((error) => { cleanupFailure ??= toStructuredFailure(error, "cleanup-failed"); });
        const removed = guestAttempted ? await runContainerCli(["delete", "--force", guestName], commandOptions(cleanupDeadlineAtMs)).catch(
          () => null,
        ) : null;
        await record({
          event: "observed",
          action: "destroy",
          kind: "guest",
          name: guestName,
          status: removed?.code === 0 ? "destroyed" : "already-absent",
        }).catch((error) => { cleanupFailure ??= toStructuredFailure(error, "cleanup-failed"); });
        if (guestAttempted && removed?.code !== 0 && !/container not found:/i.test(`${removed?.stderr ?? ""}\n${removed?.stdout ?? ""}`)) cleanupFailure = toStructuredFailure(new EvalError("cleanup-failed", `validator guest ${guestName} destruction was not confirmed`, { at: guestName }), "cleanup-failed");
        if (guestAttempted) {
          const absent = await runContainerCli(["inspect", guestName], commandOptions(cleanupDeadlineAtMs)).catch(() => null);
          if (absent === null || (absent.code === 0 || !/container not found:/i.test(`${absent.stderr}\n${absent.stdout}`))) cleanupFailure ??= toStructuredFailure(new EvalError("cleanup-failed", `validator guest ${guestName} remained present or could not be inspected`, { at: guestName }), "cleanup-failed");
        }
        if (networkAttempted) {
          await record({ event: "intent", action: "destroy", kind: "network", name: networkName, status: null }).catch((error) => { cleanupFailure ??= toStructuredFailure(error, "cleanup-failed"); });
          const droppedNetwork = await runContainerCli(["network", "delete", networkName], commandOptions(cleanupDeadlineAtMs)).catch(() => null);
          await record({
            event: "observed",
            action: "destroy",
            kind: "network",
            name: networkName,
            status: droppedNetwork?.code === 0 ? "destroyed" : /network not found:/i.test(`${droppedNetwork?.stderr ?? ""}\n${droppedNetwork?.stdout ?? ""}`) ? "already-absent" : "failed",
          }).catch((error) => { cleanupFailure ??= toStructuredFailure(error, "cleanup-failed"); });
          if (droppedNetwork?.code !== 0 && !/network not found:/i.test(`${droppedNetwork?.stderr ?? ""}\n${droppedNetwork?.stdout ?? ""}`)) cleanupFailure ??= toStructuredFailure(new EvalError("cleanup-failed", `validator network ${networkName} destruction was not confirmed`, { at: networkName }), "cleanup-failed");
          {
            const absent = await runContainerCli(["network", "inspect", networkName], commandOptions(cleanupDeadlineAtMs)).catch(() => null);
            if (absent === null || (absent.code === 0 || !/network not found:/i.test(`${absent.stderr}\n${absent.stdout}`))) cleanupFailure ??= toStructuredFailure(new EvalError("cleanup-failed", `validator network ${networkName} remained present or could not be inspected`, { at: networkName }), "cleanup-failed");
          }
        }
      }
      if (cleanupFailure !== null) runResult = { runnerId: CONTAINER_VALIDATOR_RUNNER_ID, testDouble: false, outcome: infrastructureOutcome(cleanupFailure), failure: cleanupFailure, durationMs: Date.now() - startedAt };
      return runResult ?? (() => { throw new EvalError("validator-infrastructure", "validator produced no run result"); })();
    },
  };
}

export type { ValidatorRunner };
export { GUEST_UID, GUEST_GID };
