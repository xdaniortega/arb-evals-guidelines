/**
 * Paired run orchestration: preflight -> freeze -> execute -> validate -> clean up -> seal.
 *
 * The stage order is the contract (docs/ARCHITECTURE.md section 6) and is not an
 * implementation detail. Each stage exists to make one specific dishonest outcome
 * impossible:
 *
 * - **Preflight** rethrows. `eval:validate` deliberately swallows a bad case so one
 *   failure cannot hide the others; a run must do the opposite and abort before anything
 *   is created, because dispatching against inputs that did not decode is how a run ends
 *   up grading something other than what it claims to have measured.
 * - **Freeze** hashes everything that must be identical across the arms into one
 *   `ParityBinding`, including the skill snapshot tree hash, which is bound to BOTH arms
 *   even though only treatment stages it. Frozen inputs are written before dispatch and
 *   never rewritten.
 * - **Execute** prepares both isolated arms before dispatch. Overlap runs them together;
 *   serial dispatch waits for baseline capture and verified cleanup before treatment.
 *   Both schedules keep separate guests, networks, and prompt-relative budgets.
 * - **Validate** projects a bounded candidate from the exported workspace and grades both
 *   arms with the same validator. It runs after both guests are gone, so no model guest
 *   is alive while grading happens.
 * - **Clean up** sweeps every journaled exact identity. Never a name or label scan.
 * - **Seal** writes condition, pair, manifest, and receipt records last, so the receipt
 *   cannot exist before every cleanup outcome is known.
 *
 * Failure classification is load-bearing: a task outcome is gradeable and may score zero;
 * an infrastructure outcome carries `score: null` and is never recorded as a task
 * failure. Nothing here ever re-executes a task to obtain a better result.
 */

import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { assertNotAborted } from "../core/types.ts";
import { scheduleTimeout, type DeadlineTimer } from "../core/timing.ts";
import {
  assertParity,
  buildManifestTree,
  buildRunPlan,
  canonicalJson,
  canonicalJsonSha256,
  computePairDelta,
  resolveLimits,
  sha256Hex,
} from "../core/experiment.ts";
import type {
  ConditionPlan,
  ManifestEntry,
  ParityBinding,
  RunPlan,
  ScheduleStep,
  SourceIdentity,
  Target,
} from "../core/experiment.ts";
import {
  EVIDENCE_SCHEMA_VERSION,
  CONDITION_CLEANUP_ALLOWANCE_MS,
  CONDITION_OPERATION_ALLOWANCE_MS,
  EvalError,
  resolveGuestTimeouts,
  SCHEMA_VERSION,
  toStructuredFailure,
} from "../core/types.ts";
import type {
  ConditionId,
  Limits,
  PartialLimits,
  RunMode,
  StructuredFailure,
} from "../core/types.ts";
import { redactSecretBytes, redactSecrets, scanManyForSecrets } from "../core/secret-scan.ts";
import type { GuardedSecret, SecretRedaction } from "../core/secret-scan.ts";
import type {
  Harness,
  HarnessRequest,
  HarnessRunResult,
  NormalizedMessage,
  NormalizedToolStep,
  RuntimeIdentity,
} from "../harnesses/harness.ts";
import type {
  CredentialDeliveryRequest,
  DestroyOutcome,
  ExportedTree,
  Guest,
  GuestAttestation,
  GuestPolicy,
  NetworkPolicy,
  ResourceKind,
  Sandbox,
} from "../sandboxes/sandbox.ts";
import { createEvidenceStore, createRunJournal, journaledIdentities } from "../artifacts/store.ts";
import type { EvidenceStore, RunJournal } from "../artifacts/store.ts";
import { createNativeSessionCapture } from "../artifacts/native-prefix.ts";
import type { NativePrefixSnapshot, NativeSessionCapture } from "../artifacts/native-prefix.ts";
import { verifyRun } from "../artifacts/queries.ts";
import { type NativeSessionEntry, sanitizeNativeSessionEntries } from "../harnesses/pi/export-viewer.ts";
import { MCP_CLIENT_POLICY } from "../harnesses/pi/mcp-tools.ts";
import { isRunAttachable } from "./container-validator.ts";
import { freezeCase, resolveCaseSetup } from "./case-loader.ts";
import type { CaseRef, FrozenCase, SuiteRef } from "./case-loader.ts";
import { createSkillSnapshot } from "./skill-snapshot.ts";
import type { SkillSnapshot } from "./skill-snapshot.ts";
import { createFrozenInputSnapshot } from "./frozen-inputs.ts";
import type { FrozenInputSnapshot } from "./frozen-inputs.ts";
import { fixtureFileMap, projectCandidate } from "./validation.ts";
import type { CandidateMode, CandidateProjection, ValidatorRun, ValidatorRunner } from "./validation.ts";
import type {
  CasePreparer,
  PreparedCaseData,
  RuntimeProfile,
} from "../core/types.ts";
import type { SkillToolBundle } from "../core/skill-tools.ts";
import { resolveSkillToolBundle } from "./skill-tool-manifest.ts";
import { scoreWithRubric } from "./rubric.ts";

// ---------------------------------------------------------------------------
// Frozen guest layout and policies
// ---------------------------------------------------------------------------

export const EVAL_WORKSPACE_ROOT = "/work";
export const EVAL_HOME_DIR = "/home/agent";
export const EVAL_SKILL_GUEST_ROOT = "/opt/skills";

/** Identical for both arms: public IPv4 egress with explicit local, multicast and broadcast denials. */
export const EVAL_NETWORK_POLICY: NetworkPolicy = {
  allowPublicDns: true,
  allowPublicTcpPorts: "all",
  denyRanges: [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "224.0.0.0/4",
    "255.255.255.255/32",
    "::/0",
  ],
};

/**
 * Identical for both arms. Read-only root plus explicitly bounded writable paths.
 *
 * `/run/eval` is the guest control directory: it holds the supervisor's readiness marker
 * and its in-memory credential control socket, and it is declared here rather than
 * created behind the runner's back so attestation can assert that NO writable mount
 * exists outside this list.
 *
 * uid/gid 10001 is the fixed non-root identity created in the locked image. It is a
 * constant of the profile, not a preference: attestation asserts exactly this pair.
 */
export const EVAL_GUEST_POLICY: GuestPolicy = {
  readOnlyRoot: true,
  // `/opt/skills` is bounded and writable in BOTH arms even though only treatment ever
  // stages into it: the policy is part of the parity binding, so making it depend on the
  // condition would make the arms differ by more than skill presence.
  writablePaths: [EVAL_WORKSPACE_ROOT, EVAL_HOME_DIR, "/tmp", "/run/eval", EVAL_SKILL_GUEST_ROOT],
  uid: 10_001,
  gid: 10_001,
  noNewPrivileges: true,
  dropCapabilities: true,
};

/**
 * The explicit execution policy, hashed into the parity binding.
 *
 * Before this existed, "both arms were executed the same way" was an unverifiable claim.
 * Hashing it means a change to arm order, sequencing, cleanup behaviour, the re-run
 * prohibition, the graded surface, or validator isolation changes the parity hash and is
 * therefore visible in evidence rather than inferred from the code that happened to run.
 */
export interface ExecutionPolicy {
  readonly mcpClient: typeof MCP_CLIENT_POLICY;
  readonly schemaVersion: number;
  readonly armOrder: readonly ConditionId[];
  readonly sequentialExecution: boolean;
  readonly destroyPreviousBeforeNext: boolean;
  readonly verifyDestructionBeforeNext: boolean;
  readonly cleanupOnFailure: boolean;
  readonly autoRerunForBetterResult: boolean;
  readonly candidateMode: CandidateMode;
  readonly validatorIsolationMode: string;
  readonly schedulingPolicy: "serial" | "overlap";
  readonly maxActiveAgents: number;
}

/**
 * Bounded startup work before guests are prepared; not a whole-run execution cap.
 *
 * This is the startup/backstop watchdog for infrastructure liveness. It bounds image
 * build and pre-dispatch preparation only. It is deliberately NOT a function of the
 * per-arm wall clock, so it never becomes a hidden finite cap on a legitimately-unlimited
 * arm: an unlimited arm runs without any wall-clock deadline, while startup stays bounded.
 */
export const STARTUP_ALLOWANCE_MS = 300_000;

export const CLEANUP_RESERVE_MS = CONDITION_CLEANUP_ALLOWANCE_MS;

// The fixed maximum permitted arm duration and the overall run-time ceiling were removed
// (task-limit policy, item 6). Each arm is bounded only by its own per-arm wall clock
// (or unlimited when null); every infrastructure operation is bounded by its own
// allowance; and process liveness is guarded by the startup deadline plus the CLI hard
// backstop. There is no single combined ceiling over the whole run.

export function buildExecutionPolicy(input: {
  readonly armOrder: readonly ConditionId[];
  readonly candidateMode: CandidateMode;
  readonly validatorIsolationMode: string;
  readonly schedulingPolicy?: "serial" | "overlap";
}): ExecutionPolicy {
  const schedulingPolicy = input.schedulingPolicy ?? "serial";
  const sequentialExecution = schedulingPolicy === "serial";
  return {
    schemaVersion: SCHEMA_VERSION,
    mcpClient: MCP_CLIENT_POLICY,
    armOrder: [...input.armOrder],
    sequentialExecution,
    destroyPreviousBeforeNext: true,
    verifyDestructionBeforeNext: true,
    cleanupOnFailure: true,
    autoRerunForBetterResult: false,
    candidateMode: input.candidateMode,
    validatorIsolationMode: input.validatorIsolationMode,
    schedulingPolicy,
    maxActiveAgents: sequentialExecution ? 1 : 2,
  };
}

/**
 * The explicit target used by `fake` mode.
 *
 * Provider and exact model are always explicit inputs and are never chosen by credential
 * presence. In `fake` mode no request is made, so the model identity is a literal
 * placeholder that could never be mistaken for a real catalog entry.
 */
export const FAKE_TARGET: Target = { provider: "google", model: "fake-model-0", thinking: "off" };

// ---------------------------------------------------------------------------
// Boundary-resolved identity (called once, by a script, never by a deep module)
// ---------------------------------------------------------------------------

/**
 * Source revision and dirty state.
 *
 * A dirty tree is recorded rather than refused: an exploratory run from an uncommitted
 * working tree is legitimate, but a receipt that hides it is not. An unavailable git is
 * reported as `unknown` + dirty, which is the conservative reading.
 */
/** A hung or pathological git must never stall a run; both bounds fail into the fallback. */
export const GIT_PROBE_TIMEOUT_MS = 5_000;
export const GIT_PROBE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function resolveSourceIdentity(repoRoot: string): SourceIdentity {
  // Bounded in both dimensions: `timeout` kills a hung git and makes execFileSync throw,
  // `maxBuffer` does the same for unbounded output. Both land in the catch below and
  // therefore take the conservative unknown/dirty reading rather than propagating.
  const gitOptions = {
    cwd: repoRoot,
    encoding: "utf8" as const,
    timeout: GIT_PROBE_TIMEOUT_MS,
    maxBuffer: GIT_PROBE_MAX_OUTPUT_BYTES,
    killSignal: "SIGKILL" as const,
  };
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], gitOptions).trim();
    const status = execFileSync("git", ["status", "--porcelain"], gitOptions);
    return { revision, dirty: status.trim() !== "" };
  } catch {
    return { revision: "unknown", dirty: true };
  }
}

/**
 * Content hash over the evaluator's own non-test sources.
 *
 * The receipt must say which evaluator produced it. A version string could be stale; a
 * tree hash cannot be, so a change to orchestration, sealing, or grading logic is visible
 * in evidence even when nothing was committed.
 */
/**
 * Removes a run's scratch directory.
 *
 * The skill snapshot is deliberately sealed read-only (0o555 directories), which is
 * exactly what makes a plain recursive remove fail with EACCES. Permissions are restored
 * before unlinking rather than never applied, so the read-only guarantee holds for the
 * whole time the snapshot could have been staged.
 */
export async function disposeRunWorkDir(workDir: string): Promise<void> {
  const restore = async (dir: string): Promise<void> => {
    await chmod(dir, 0o700).catch(() => undefined);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const target = join(dir, entry.name);
      if (entry.isDirectory()) await restore(target);
      else await chmod(target, 0o600).catch(() => undefined);
    }
  };
  await restore(workDir);
  await rm(workDir, { recursive: true, force: true });
}

export async function resolveEvaluatorBuild(evalsRoot: string): Promise<string> {
  const entries: Array<{ path: string; sha256: string; bytes: number }> = [];
  const root = join(evalsRoot, "src");
  const walk = async (relative: readonly string[]): Promise<void> => {
    const dir = relative.length === 0 ? root : join(root, ...relative);
    const found = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of [...found].sort((left, right) => (left.name < right.name ? -1 : 1))) {
      if (entry.isDirectory()) {
        await walk([...relative, entry.name]);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const bytes = await readFile(join(dir, entry.name));
      entries.push({
        path: [...relative, entry.name].join("/"),
        sha256: sha256Hex(bytes),
        bytes: bytes.byteLength,
      });
    }
  };
  await walk([]);
  return `evals-src@${buildManifestTree(entries).treeSha256.slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Run inputs and results
// ---------------------------------------------------------------------------

export interface CleanupRecord {
  readonly kind: ResourceKind;
  readonly name: string;
  readonly status: string;
  readonly verified: boolean;
  /** Why this outcome is what it is. Never null for an affirmative non-destroy outcome. */
  readonly detail: string | null;
  readonly failure: StructuredFailure | null;
}

/**
 * Recorded on a condition that never started and for which nothing was ever journaled.
 *
 * `cleanup: []` would be indistinguishable from "cleanup ran and found nothing", so the
 * absence of any journaled resource is stated affirmatively instead.
 */
export const NO_RESOURCE_JOURNALED_STATUS = "no-resource-journaled";

export type ConditionStatus = "completed" | "task-limit" | "infrastructure-failure" | "not-started";

export type RunProgressEvent =
  | { readonly type: "request-validated"; readonly timestampMs: number }
  | { readonly type: "preparation-started"; readonly timestampMs: number }
  | { readonly type: "preparation-completed"; readonly timestampMs: number }
  | { readonly type: "freeze-started"; readonly timestampMs: number }
  | { readonly type: "freeze-completed"; readonly timestampMs: number }
  | { readonly type: "image-cache-hit"; readonly profileId: string; readonly digest: string; readonly timestampMs: number }
  | { readonly type: "image-build-started"; readonly profileId: string; readonly timestampMs: number }
  | { readonly type: "image-build-completed"; readonly profileId: string; readonly digest: string; readonly timestampMs: number }
  | { readonly type: "pair-preparing"; readonly pairIndex: number; readonly totalPairs: number; readonly timestampMs: number }
  | { readonly type: "both-arms-ready"; readonly pairIndex: number; readonly totalPairs: number; readonly timestampMs: number }
  | { readonly type: "arm-execution-started"; readonly pairIndex: number; readonly arm: ConditionId; readonly timestampMs: number }
  | { readonly type: "arm-execution-completed"; readonly pairIndex: number; readonly arm: ConditionId; readonly outcome: ConditionStatus; readonly durationMs: number; readonly timestampMs: number }
  | { readonly type: "capture-grading-started"; readonly pairIndex: number; readonly arm?: ConditionId; readonly timestampMs: number }
  | { readonly type: "capture-grading-completed"; readonly pairIndex: number; readonly arm?: ConditionId; readonly disposition: string; readonly timestampMs: number }
  | { readonly type: "cleanup-started"; readonly pairIndex?: number; readonly timestampMs: number }
  | { readonly type: "cleanup-verified"; readonly pairIndex?: number; readonly verified: boolean; readonly failureClass?: string; readonly timestampMs: number }
  | { readonly type: "sealing-started"; readonly timestampMs: number }
  | { readonly type: "finalization-completed"; readonly success: boolean; readonly error?: string; readonly timestampMs: number };

export interface RunOptions {
  readonly evalsRoot: string;
  readonly repoRoot: string;
  readonly suiteId?: string;
  readonly caseSelector: string;
  readonly skillPath?: string;
  readonly mode: RunMode;
  readonly repetitions: number;
  readonly cliLimits: PartialLimits;
  /** Reuse the exact selection validated at the CLI boundary before credential access. */
  readonly preflightInputs?: SelectedRunInputs;
  readonly target: Target;
  readonly runId: string;
  readonly resourceNonce: string;
  readonly createdAt: string;
  readonly source: SourceIdentity;
  readonly evaluatorBuild: string;
  readonly harness: Harness;
  readonly sandbox: Sandbox;
  readonly validatorRunner: ValidatorRunner;
  /** Directory for skill snapshots and other scratch state. Never shared between runs. */
  readonly workDir: string;
  /** `<suite>/runs` by default; tests point this at a temp root. */
  readonly runsRoot?: string;
  /** `.state` by default. */
  readonly stateDir?: string;
  readonly guardedSecrets?: readonly GuardedSecret[];
  readonly credentials?: readonly CredentialDeliveryRequest[];
  /**
   * Test-only overrides for the bounded INFRASTRUCTURE allowances (never the per-arm wall
   * clock). These bound setup, capture, grading and cleanup independently of arm time; a
   * test may shrink them to exercise infrastructure bounds/cancellation quickly. Production
   * always uses the module constants. There is no overall run-time ceiling.
   */
  readonly operationAllowanceMs?: number;
  readonly cleanupReserveMs?: number;
  readonly startupAllowanceMs?: number;
  /** Process-boundary timestamp; prevents preflight/probes from restarting the clock. */
  readonly invocationStartedAtMs?: number;
  /** Optional trusted preparation executed once at the composition boundary before freezing. */
  readonly preparer?: CasePreparer;
  /** Optional injected profile catalog for data-driven profile resolution. */
  readonly profileCatalog?: Readonly<Record<string, RuntimeProfile>>;
  /** External cancellation, composed with the wall-clock deadline. */
  readonly signal?: AbortSignal;
  /** Install SIGINT/SIGTERM handlers. Scripts pass true; tests drive `signal` instead. */
  readonly installSignalHandlers?: boolean;
  readonly faults?: {
    readonly simulateSurvivingSecretHit?: boolean;
  };
  readonly schedulingPolicy?: "serial" | "overlap";
  /** Optional flag: when true, preserve model reasoning verbatim in native session entries. Defaults to false (strip). */
  readonly captureReasoning?: boolean;
  readonly onProgress?: (event: RunProgressEvent) => void;
}

export type RunPairedEvaluationOptions = RunOptions;

export interface RunResult {
  readonly runId: string;
  readonly runDir: string;
  readonly receiptPath: string;
  readonly status: "complete" | "partial";
  readonly stopReason: string | null;
  readonly journalPath: string;
  readonly failures: readonly StructuredFailure[];
}

// ---------------------------------------------------------------------------
// Internal per-condition accumulation
// ---------------------------------------------------------------------------

interface ConditionState {
  readonly step: ScheduleStep;
  readonly plan: ConditionPlan;
  status: ConditionStatus;
  notStartedReason: string | null;
  runtime: RuntimeIdentity | null;
  messages: readonly NormalizedMessage[];
  toolSteps: readonly NormalizedToolStep[];
  sessionEntries: readonly NativeSessionEntry[];
  sessionRedactions: {
    count: number;
    entries: readonly SecretRedaction[];
  };
  nativeCapture: NativeSessionCapture | null;
  nativePrefix: NativePrefixSnapshot | null;
  nativePromotionFailure: EvalError | null;
  usage: HarnessRunResult["usage"] | null;
  timing: HarnessRunResult["timing"] | null;
  /** Structured stop cause; null until the arm executes (never-started arms have none). */
  stopCause: HarnessRunResult["stopCause"] | null;
  /** Provider raw stop reason preserved verbatim, distinct from the harness stop cause. */
  providerStopReason: string | null;
  exported: ExportedTree | null;
  /** The OBSERVED attestation this condition's guest reported. Null if it never started. */
  attestation: GuestAttestation | null;
  candidate: CandidateProjection | null;
  validation: ValidatorRun | null;
  cleanup: CleanupRecord[];
  /** Retained per-resource creation operations; cleanup must not inspect unresolved identities. */
  creationHandles: Partial<Record<"guest" | "network", BoundedEffect<unknown>>>;
  failures: StructuredFailure[];
  imageDigest: string | null;
  redactions: {
    count: number;
    entries: readonly SecretRedaction[];
  };
}

function newConditionState(step: ScheduleStep, plan: ConditionPlan): ConditionState {
  return {
    step,
    plan,
    status: "not-started",
    notStartedReason: "the run stopped before this condition was scheduled",
    runtime: null,
    messages: [],
    toolSteps: [],
    sessionEntries: [],
    sessionRedactions: {
      count: 0,
      entries: [],
    },
    nativeCapture: null,
    nativePrefix: null,
    nativePromotionFailure: null,
    usage: null,
    timing: null,
    stopCause: null,
    providerStopReason: null,
    exported: null,
    attestation: null,
    candidate: null,
    validation: null,
    cleanup: [],
    creationHandles: {},
    failures: [],
    imageDigest: null,
    redactions: {
      count: 0,
      entries: [],
    },
  };
}

function structuredFrom(error: unknown): StructuredFailure {
  return toStructuredFailure(error, "protocol-drift");
}

export interface SelectedRunInputs {
  readonly suite: SuiteRef;
  readonly selected: CaseRef;
  readonly resolved: ReturnType<typeof resolveLimits>;
}

/**
 * @notice Decode selection and resolve policy once before trusted preparation.
 * @param input Suite/case selection, CLI overrides and optional profile catalog.
 * @returns Retained configuration and limits used by both preparation and execution.
 * @dev File bytes are validated and frozen once afterwards, before any guest effects.
 */
export async function preflightForRun(input: {
  readonly evalsRoot: string;
  readonly repoRoot?: string;
  readonly suiteId?: string;
  readonly skillPath?: string;
  readonly caseSelector: string;
  readonly cliLimits: PartialLimits;
  readonly profileCatalog?: Readonly<Record<string, RuntimeProfile>>;
}): Promise<SelectedRunInputs> {
  const decodeOptions = { profileCatalog: input.profileCatalog };
  const { suite, selected } = await resolveCaseSetup(input, decodeOptions);
  const resolved = resolveLimits({
    cli: input.cliLimits,
    caseLimits: selected.config.limits,
    suiteLimits: suite.config.limits,
    runtimeProfileId: selected.config.runtimeProfileId ?? suite.config.runtimeProfileId,
    profileCatalog: input.profileCatalog,
  });
  // No fixed maximum arm duration: a finite wallClockMs of any positive size is accepted,
  // and `null` means unlimited (no per-arm wall-clock deadline).
  return { suite, selected, resolved };
}

// ---------------------------------------------------------------------------
// Mode gate
// ---------------------------------------------------------------------------

/**
 * `measured` refuses every test double; `fake` self-labels the evidence.
 *
 * No non-double harness, sandbox, or validator runner exists yet, so `measured` currently
 * always refuses. That is the intended behaviour, not a gap: it is far better for the
 * mode gate to exist and refuse than to be added after the first double-produced result
 * has already been presented as measured.
 */
export function assertModeAllows(input: {
  readonly mode: RunMode;
  readonly harness: Harness;
  readonly sandbox: Sandbox;
  readonly validatorRunner: ValidatorRunner;
}): void {
  if (input.mode !== "measured") return;
  const doubles = [
    input.harness.testDouble ? `harness:${input.harness.id}` : null,
    input.sandbox.testDouble ? `sandbox:${input.sandbox.id}` : null,
    input.validatorRunner.testDouble ? `validator-runner:${input.validatorRunner.id}` : null,
  ].filter((entry): entry is string => entry !== null);
  if (doubles.length > 0) {
    throw new EvalError(
      "not-implemented",
      `--mode measured refuses test doubles: ${doubles.join(", ")}. Use --mode fake, whose evidence is self-labeled as test-double-produced.`,
      { at: "--mode" },
    );
  }
}

// ---------------------------------------------------------------------------
// Trusted preparation bounded execution
// ---------------------------------------------------------------------------

export interface ExecuteTrustedPreparerOptions {
  readonly preparer: CasePreparer;
  readonly suiteId: string;
  readonly caseSelector: string;
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal;
}

/**
 * @notice Await trusted preparation within an absolute deadline and composed cancellation.
 * @param options Callback, case identity, invocation deadline and optional caller signal.
 * @returns Only a timely result; cancellation/deadline throws interrupted, other errors input-invalid.
 * @dev Rechecks before invocation and after settlement: timers can lag synchronous/microtask work.
 * The referenced timer keeps pending children alive. Cleanup removes timers/listeners, not callback
 * side effects: ignoring cancellation or blocking the event loop requires process isolation to stop.
 */
export async function executeTrustedPreparer(
  options: ExecuteTrustedPreparerOptions,
): Promise<PreparedCaseData> {
  if (options.signal?.aborted) {
    const parentReason = options.signal.reason;
    if (parentReason instanceof EvalError && parentReason.code === "interrupted") {
      throw parentReason;
    }
    throw new EvalError(
      "interrupted",
      `trusted preparation was cancelled before starting: ${parentReason instanceof Error ? parentReason.message : String(parentReason ?? "caller aborted")}`,
      { at: "trusted-preparation" },
    );
  }

  const now = Date.now();
  if (now >= options.deadlineAtMs) {
    throw new EvalError(
      "interrupted",
      `trusted preparation deadline of ${options.deadlineAtMs}ms has already expired (current time: ${now}ms)`,
      { at: "trusted-preparation" },
    );
  }

  const prepController = new AbortController();
  let parentAbortListener: (() => void) | null = null;
  if (options.signal) {
    parentAbortListener = () => {
      const parentReason = options.signal?.reason;
      const error = parentReason instanceof Error
        ? parentReason
        : new EvalError("interrupted", `trusted preparation was cancelled: ${String(parentReason ?? "caller aborted")}`, { at: "trusted-preparation" });
      prepController.abort(error);
    };
    options.signal.addEventListener("abort", parentAbortListener, { once: true });
  }

  let timeoutId: DeadlineTimer | null = null;
  let prepAbortListener: (() => void) | null = null;

  const timeoutMs = Math.max(0, options.deadlineAtMs - Date.now());

  const abortOrTimeoutPromise = new Promise<never>((_, reject) => {
    prepAbortListener = () => {
      const reason = prepController.signal.reason;
      if (reason instanceof EvalError) {
        reject(reason);
      } else if (reason instanceof Error) {
        reject(new EvalError("interrupted", reason.message, { cause: reason, at: "trusted-preparation" }));
      } else {
        reject(new EvalError("interrupted", String(reason ?? "trusted preparation was interrupted"), { at: "trusted-preparation" }));
      }
    };

    if (prepController.signal.aborted) {
      prepAbortListener();
      return;
    }

    prepController.signal.addEventListener("abort", prepAbortListener, { once: true });

    // IMPORTANT: Keep timeout referenced while awaiting so Node child cannot silently exit with code 0 on a pending Promise!
    timeoutId = scheduleTimeout(() => {
      prepController.abort(
        new EvalError(
          "interrupted",
          `trusted preparation exceeded deadline of ${options.deadlineAtMs}ms`,
          { at: "trusted-preparation" },
        ),
      );
    }, timeoutMs);
  });

  const assertActive = (): void => {
    if (options.signal?.aborted) parentAbortListener?.();
    if (!prepController.signal.aborted && Date.now() >= options.deadlineAtMs) {
      prepController.abort(new EvalError(
        "interrupted",
        `trusted preparation exceeded deadline of ${options.deadlineAtMs}ms`,
        { at: "trusted-preparation" },
      ));
    }
    if (prepController.signal.aborted) {
      const reason = prepController.signal.reason;
      if (reason instanceof EvalError) throw reason;
      throw new EvalError("interrupted", reason instanceof Error ? reason.message : String(reason ?? "trusted preparation was interrupted"), { at: "trusted-preparation" });
    }
  };

  const callbackPromise = Promise.resolve().then(() => {
    assertActive();
    return options.preparer({
      suiteId: options.suiteId,
      caseSelector: options.caseSelector,
      signal: prepController.signal,
      deadlineAtMs: options.deadlineAtMs,
    });
  });

  // Absorb late rejections so they never produce unhandledRejection if the deadline/cancellation wins the race
  callbackPromise.catch(() => {});

  try {
    const result = await Promise.race([callbackPromise, abortOrTimeoutPromise]);
    assertActive();
    return result;
  } catch (error: unknown) {
    assertActive();
    if (error instanceof EvalError) {
      throw error;
    }
    throw new EvalError(
      "input-invalid",
      `trusted preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, at: "trusted-preparation" },
    );
  } finally {
    if (timeoutId !== null) {
      (timeoutId as DeadlineTimer).cancel();
      timeoutId = null;
    }
    if (prepAbortListener !== null) {
      prepController.signal.removeEventListener("abort", prepAbortListener);
      prepAbortListener = null;
    }
    if (parentAbortListener !== null && options.signal) {
      options.signal.removeEventListener("abort", parentAbortListener);
      parentAbortListener = null;
    }
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * @notice Coordinates a paired evaluation comparing baseline and treatment arms in isolated sandbox environments.
 * @param options Evaluation options specifying target model, suite, case selector, harness, sandbox, and limits.
 * @returns Complete evaluation outcome containing arm outcomes, comparative deltas, telemetry, and sealed receipt.
 * @dev Arm timing is independent of bounded setup, grading, capture and cleanup operations; cancellation still tears down exact owned resources.
 */
export async function runPairedEvaluation(options: RunOptions): Promise<RunResult> {
  const invocationStartedAtMs = options.invocationStartedAtMs ?? Date.now();
  // -- Stage 1: preflight ---------------------------------------------------
  const selection = options.preflightInputs ?? await preflightForRun({
    evalsRoot: options.evalsRoot,
    repoRoot: options.repoRoot,
    skillPath: options.skillPath,
    suiteId: options.suiteId,
    caseSelector: options.caseSelector,
    cliLimits: options.cliLimits,
    profileCatalog: options.profileCatalog,
  });
  assertModeAllows(options);
  options.onProgress?.({ type: "request-validated", timestampMs: Date.now() });

  const resolved = selection.resolved;
  const wallClockMs = resolved.limits.wallClockMs;
  // Bounded infrastructure allowances (never the arm wall clock). Production uses the
  // module constants; tests may shrink them to exercise infra bounds/cancellation quickly.
  const operationAllowanceMs = options.operationAllowanceMs ?? CONDITION_OPERATION_ALLOWANCE_MS;
  const cleanupReserveMs = options.cleanupReserveMs ?? CLEANUP_RESERVE_MS;
  const startupAllowanceMs = options.startupAllowanceMs ?? STARTUP_ALLOWANCE_MS;
  // There is NO overall run-time ceiling. Each infrastructure operation carries its own
  // finite deadline computed from `Date.now()` plus an allowance at its call site (setup
  // and capture use operationAllowanceMs; cleanup uses cleanupReserveMs), so nothing caps
  // arm execution and no hidden finite bound is introduced anywhere.
  // Startup liveness only; independent of the arm wall clock so unlimited arms are uncapped.
  const startupDeadlineAtMs = invocationStartedAtMs + startupAllowanceMs;

  // -- Cancellation ---------------------------------------------------------
  // Cancellation is a SEPARATE responsibility from arm timing: parent abort and
  // SIGINT/SIGTERM stop active work and begin bounded cleanup regardless of arm limits.
  const controller = new AbortController();
  // Ordinary arm failure stops active agents, but a gradeable overlap sibling gets its
  // already-produced output captured until an external/quarantine stop occurs.
  const captureController = new AbortController();
  const validationController = new AbortController();
  let stopReason: string | null = null;
  const stopCapture = (cause: unknown): void => {
    if (!captureController.signal.aborted) captureController.abort(cause instanceof Error ? cause : new Error(String(cause)));
  };
  const stop = (reason: string, cause?: unknown): void => {
    if (stopReason === null) stopReason = reason;
    if (!controller.signal.aborted) controller.abort(cause instanceof Error ? cause : new Error(reason));
  };
  const onParentAbort = (): void => {
    validationController.abort(options.signal?.reason);
    stopCapture(options.signal?.reason ?? new Error("the caller aborted the run"));
    stop(options.signal?.reason instanceof Error ? options.signal.reason.message : "the caller aborted the run", options.signal?.reason);
  };
  if (options.signal?.aborted) onParentAbort();
  else options.signal?.addEventListener("abort", onParentAbort, { once: true });

  let sealing = false;
  // Set before snapshotting/sealing so no late external continuation can mutate state.
  let finalized = false;
  const onSignal = (name: string): (() => void) => (): void => {
    if (sealing) {
      process.stderr.write(`${name} received while sealing evidence; ignoring it so the run is not left half-sealed\n`);
      return;
    }
    const interruption = new Error(`${name} received`);
    validationController.abort(interruption);
    stopCapture(interruption);
    stop(`${name} received`, interruption);
  };
  const onSigint = onSignal("SIGINT");
  const onSigterm = onSignal("SIGTERM");
  if (options.installSignalHandlers === true) {
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  }
  let cancellationReleased = false;
  const releaseCancellation = (): void => {
    if (cancellationReleased) return;
    cancellationReleased = true;
    options.signal?.removeEventListener("abort", onParentAbort);
    if (options.installSignalHandlers === true) {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
  };
  const signal = controller.signal;

  // Optional trusted preparation runs once before freezing. It is a bounded infrastructure
  // operation with its own allowance and never consumes the cleanup reserve.
  let prepared: PreparedCaseData | undefined;
  if (options.preparer !== undefined) {
    // Startup liveness bounds pre-dispatch preparation (not the arm wall clock): if the
    // startup allowance is already spent before preparation begins, fail closed instead of
    // starting work that cannot finish within the pre-dispatch budget.
    if (Date.now() >= startupDeadlineAtMs) {
      releaseCancellation();
      throw new EvalError("interrupted", "run preparation exceeded its startup deadline before dispatch", { at: "run preparation" });
    }
    options.onProgress?.({ type: "preparation-started", timestampMs: Date.now() });
    try {
      const prepStart = Date.now();
      prepared = await executeTrustedPreparer({
        preparer: options.preparer,
        suiteId: selection.suite.id,
        caseSelector: selection.selected.selector,
        // Preparation has its own allowance within the remaining startup window.
        deadlineAtMs: Math.min(startupDeadlineAtMs, prepStart + operationAllowanceMs),
        signal,
      });
      options.onProgress?.({ type: "preparation-completed", timestampMs: Date.now() });
    } catch (error) {
      releaseCancellation();
      throw error;
    }
  }

  let frozen: FrozenCase;
  try {
    frozen = await freezeCase(selection.suite, selection.selected, prepared);
  } catch (error) {
    releaseCancellation();
    throw error;
  }

  const runsRoot = options.runsRoot ?? join(frozen.suiteDir, "runs");
  const runDir = join(runsRoot, options.runId);
  const stateDir = options.stateDir ?? join(options.evalsRoot, ".state");
  const guardedSecrets = options.guardedSecrets ?? [];
  const candidateMode: CandidateMode = frozen.config.candidateMode;

  const journal = await createRunJournal({
    stateDir,
    runId: options.runId,
    nonce: options.resourceNonce,
  });
  const store = await createEvidenceStore({ runDir, guardedSecrets });
  await mkdir(options.workDir, { recursive: true, mode: 0o700 });

  const runFailures: StructuredFailure[] = [];
  /** Set by a cleanup failure or a secret quarantine. No further paid call may be made. */
  let paidCallsBlocked = false;
  const blockPaidCalls = (reason: string, quarantine = false): void => {
    paidCallsBlocked = true;
    if (quarantine) stopCapture(new EvalError("secret-quarantine", reason));
    if (stopReason === null) stopReason = reason;
  };

  let states: ConditionState[] = [];
  // Retain timed-out operations so cleanup never races their late resource creation.
  const pendingEffects: Array<{ readonly handle: BoundedEffect<unknown>; readonly conditionId: ConditionId | null }> = [];
  let plan: RunPlan | null = null;
  let snapshot: SkillSnapshot | null = null;
  let frozenSnapshot: FrozenInputSnapshot | null = null;

  try {
    // -- Stage 2: freeze ----------------------------------------------------
    options.onProgress?.({ type: "freeze-started", timestampMs: Date.now() });
    snapshot = await createSkillSnapshot({
      repoRoot: options.repoRoot,
      skillPath: frozen.suite.skillPath,
      ...(options.skillPath != null ? { skillDir: options.skillPath } : {}),
      snapshotDir: join(options.workDir, "skill-snapshot"),
    });

    const skillToolBundle = await resolveSkillToolBundle({
      snapshotDir: snapshot.snapshotDir,
      at: `skill ${frozen.suite.skillPath}`,
    });
    const skillToolBundleSha256 = canonicalJsonSha256(skillToolBundle);

    // Building an image is an external effect and is journaled before invocation.
    const imageIntent = `eval-image-${options.runId}-${frozen.runtimeProfileId}`;
    await journal.record({
      event: "intent",
      action: "create",
      kind: "image",
      name: imageIntent,
      conditionId: null,
      status: null,
    });
    const imageHandle = boundedEffect(startupDeadlineAtMs, "image preparation", (startupSignal) => options.sandbox.buildImage({
      runtimeProfileId: frozen.runtimeProfileId,
      contextDir: join(options.evalsRoot, "container"),
      signal: AbortSignal.any([signal, startupSignal]),
      deadlineAtMs: startupDeadlineAtMs,
      onBuildStarted: () => options.onProgress?.({ type: "image-build-started", profileId: frozen.runtimeProfileId, timestampMs: Date.now() }),
    }), "interrupted");
    pendingEffects.push({ handle: imageHandle as BoundedEffect<unknown>, conditionId: null });
    const image = await imageHandle.result;
    await journal.record({
      event: "observed",
      action: "create",
      kind: "image",
      name: image.digest,
      conditionId: null,
      status: "created",
    });

    options.onProgress?.(image.cacheHit === true ? {
      type: "image-cache-hit",
      profileId: frozen.runtimeProfileId,
      digest: image.digest,
      timestampMs: Date.now(),
    } : {
      type: "image-build-completed",
      profileId: frozen.runtimeProfileId,
      digest: image.digest,
      timestampMs: Date.now(),
    });

    // A validator runner that creates real containers only now learns which image the
    // pair was built from, and is given the journal so its own external effects are
    // recorded before they happen, exactly like the sandbox's.
    if (isRunAttachable(options.validatorRunner)) {
      options.validatorRunner.attachRun({
        imageReference: image.reference,
        record: async (entry) => {
          await journal.record({ ...entry, conditionId: null });
        },
      });
    }

    const executionPolicy = buildExecutionPolicy({
      armOrder: ["baseline", "treatment"],
      candidateMode,
      validatorIsolationMode: options.validatorRunner.id,
      schedulingPolicy: options.schedulingPolicy,
    });
    const skillGuestPath = `${EVAL_SKILL_GUEST_ROOT}/${frozen.suite.id}`;

    const parity: ParityBinding = {
      promptSha256: frozen.promptSha256,
      fixtureTreeSha256: frozen.fixtureTreeSha256,
      outputPath: frozen.config.outputPath,
      oracleSha256: frozen.oracleSha256,
      validatorSha256: frozen.validatorSha256,
      validatorClosureSha256: frozen.validatorClosureSha256,
      allowedTools: [...frozen.config.allowedTools],
      harnessId: options.harness.id,
      sandboxId: options.sandbox.id,
      validatorRunnerId: options.validatorRunner.id,
      runtimeProfileId: frozen.runtimeProfileId,
      imageDigest: image.digest,
      target: options.target,
      limits: resolved.limits,
      networkPolicySha256: canonicalJsonSha256(EVAL_NETWORK_POLICY),
      guestPolicySha256: canonicalJsonSha256(EVAL_GUEST_POLICY),
      workspaceRoot: EVAL_WORKSPACE_ROOT,
      executionPolicySha256: canonicalJsonSha256(executionPolicy),
      caseId: frozen.config.id,
      caseVersion: frozen.config.version,
      // Bound to BOTH arms: evidence must show the two arms were planned against the
      // same skill bytes even though baseline never stages them.
      skillSnapshotTreeSha256: snapshot.treeSha256,
      // Bound to BOTH arms: evidence must show both arms were planned against the
      // same declared tool requirements even though only treatment provisions them.
      skillToolBundleSha256,
      candidateMode,
    };

    plan = buildRunPlan({
      runId: options.runId,
      mode: options.mode,
      suiteId: frozen.suite.id,
      caseSelector: frozen.selector,
      caseId: frozen.config.id,
      caseVersion: frozen.config.version,
      repetitions: options.repetitions,
      armOrder: executionPolicy.armOrder,
      skillGuestPath,
      resourceNonce: options.resourceNonce,
      createdAt: options.createdAt,
      source: options.source,
      evaluatorBuild: options.evaluatorBuild,
      parity,
    });
    assertParity(plan.conditions);

    // Frozen inputs are written before dispatch and are never rewritten.
    await writeFrozenInputs(store, {
      plan,
      target: options.target,
      limits: resolved.limits,
      limitProvenance: resolved.provenance,
      executionPolicy,
      networkPolicy: EVAL_NETWORK_POLICY,
      guestPolicy: EVAL_GUEST_POLICY,
      frozen,
      snapshot,
      skillGuestPath,
      skillToolBundle,
      image: {
        reference: image.reference,
        digest: image.digest,
        runtimeProfileId: image.runtimeProfileId,
        testDouble: image.testDouble,
      },
      mode: options.mode,
      harnessId: options.harness.id,
      sandboxId: options.sandbox.id,
      validatorRunnerId: options.validatorRunner.id,
      testDouble: isTestDoubleRun(options),
    });

    // Prepare complete bounded input snapshot in evaluator-owned scratch state
    frozenSnapshot = await createFrozenInputSnapshot({
      targetDir: join(options.workDir, "frozen-inputs"),
      frozen,
      snapshot,
    });
    options.onProgress?.({ type: "freeze-completed", timestampMs: Date.now() });
    if (Date.now() >= startupDeadlineAtMs) {
      throw new EvalError("interrupted", "run preparation exceeded its startup deadline before dispatch", { at: "run preparation" });
    }

    const planByCondition = new Map<ConditionId, ConditionPlan>(
      plan.conditions.map((condition) => [condition.conditionId, condition]),
    );
    states = plan.schedule.map((step) => {
      const conditionPlan = planByCondition.get(step.conditionId);
      if (conditionPlan === undefined) {
        throw new EvalError("parity-violation", `schedule references unknown condition ${step.conditionId}`);
      }
      const state = newConditionState(step, conditionPlan);
      state.nativeCapture = createNativeSessionCapture({
        path: join(stateDir, "native-prefixes", `${options.runId}-${step.pairId}-${step.conditionId}.jsonl`),
        guardedSecrets,
        captureReasoning: options.captureReasoning,
      });
      return state;
    });

    // -- Stage 3: execute ---------------------------------------------------
    const snapshotFiles = await readSnapshotFiles(snapshot);
    const isOverlap = options.schedulingPolicy === "overlap";

    const scheduledPairs = options.repetitions ?? 1;
    for (let p = 1; p <= scheduledPairs; p++) {
      const baselineState = states.find((state) => state.step.repetition === p && state.step.conditionId === "baseline")!;
      const treatmentState = states.find((state) => state.step.repetition === p && state.step.conditionId === "treatment")!;
      const pairStates: readonly [ConditionState, ConditionState] = [baselineState, treatmentState];
      if (signal.aborted || paidCallsBlocked) {
        for (const state of pairStates) {
          state.notStartedReason = stopReason ?? "the run stopped before this pair started";
          state.cleanup.push(...(await confirmNeverCreated(options.sandbox, journal, state, Date.now() + cleanupReserveMs)));
        }
        continue;
      }

      options.onProgress?.({ type: "pair-preparing", pairIndex: p, totalPairs: scheduledPairs, timestampMs: Date.now() });
      for (const state of pairStates) state.imageDigest = image.digest;
      const prepared = new Map<ConditionId, PreparedCondition>();
      let preparationFailure: StructuredFailure | null = null;
      for (const state of pairStates) {
        try {
          const preparationDeadline = Date.now() + operationAllowanceMs;
          // The guest must OUTLIVE setup: its supervisor covers setup + prompt + capture +
          // cleanup. Derive that lifetime from the arm wall clock (finite) or leave it
          // unbounded (unlimited). Setup CLI operations stay bounded by the outer
          // preparation boundedEffect above, not by this longer guest-lifetime deadline.
          const guestSupervisorMs = resolveGuestTimeouts(wallClockMs).supervisorMs;
          const guestLifetimeDeadlineAtMs = guestSupervisorMs === null ? Number.POSITIVE_INFINITY : Date.now() + guestSupervisorMs;
          const preparationHandle = boundedEffect(preparationDeadline, `${state.step.conditionId} preparation`, (preparationSignal) => prepareCondition({
            state,
            sandbox: options.sandbox,
            harness: options.harness,
            journal,
            frozen,
            limits: resolved.limits,
            target: options.target,
            imageDigest: image.digest,
            skillGuestPath,
            snapshotFiles,
            guardedSecrets,
            credentials: options.credentials ?? [],
            signal: AbortSignal.any([signal, preparationSignal]),
            deadlineAtMs: guestLifetimeDeadlineAtMs,
            skillToolBundle,
            skillToolBundleSha256,
            captureReasoning: options.captureReasoning,
            isFinalized: () => finalized,
          }), "interrupted");
          pendingEffects.push({ handle: preparationHandle as BoundedEffect<unknown>, conditionId: state.step.conditionId });
          prepared.set(state.step.conditionId, await preparationHandle.result);
        } catch (error: unknown) {
          preparationFailure = structuredFrom(error);
          state.status = "infrastructure-failure";
          state.notStartedReason = null;
          state.failures.push(preparationFailure);
          runFailures.push(preparationFailure);
          break;
        }
      }

      if (preparationFailure !== null || prepared.size !== 2) {
        for (const state of pairStates) {
          if (state.status === "not-started") state.notStartedReason = `pair preparation failed before the shared readiness barrier`;
        }
        stop(`pair ${p} preparation failed: ${preparationFailure?.code ?? "interrupted"}`);
      } else {
        options.onProgress?.({ type: "both-arms-ready", pairIndex: p, totalPairs: scheduledPairs, timestampMs: Date.now() });
        const dispatched = new Set<ConditionId>();
        const cleaned = new Set<ConditionId>();
        let cleanupVerified = true;
        const runArm = async (state: ConditionState): Promise<void> => {
          if (signal.aborted) return;
          dispatched.add(state.step.conditionId);
          options.onProgress?.({ type: "arm-execution-started", pairIndex: p, arm: state.step.conditionId, timestampMs: Date.now() });
          try {
            await dispatchArmPrompt({ state, harness: options.harness, prepared: prepared.get(state.step.conditionId)!, limits: resolved.limits, signal, isFinalized: () => finalized });
            if (state.status === "infrastructure-failure") stop(`${state.step.conditionId} failed: ${state.failures[0]?.code ?? "infrastructure failure"}`);
          } catch (error: unknown) {
            const failure = structuredFrom(error);
            state.status = "infrastructure-failure";
            state.notStartedReason = null;
            // A local arm that throws before the harness could derive a stop cause still
            // seals a concrete cause: an external cancellation is `external-cancellation`
            // (matching the guest classification of the same event), and every other
            // pre-cause throw is an `infrastructure-error`, never a silent null/unknown.
            if (state.stopCause === null) {
              state.stopCause = failure.code === "interrupted" ? "external-cancellation" : "infrastructure-error";
            }
            state.failures.push(failure);
            runFailures.push(failure);
            if (failure.code === "secret-quarantine") blockPaidCalls("a secret quarantine blocks every further paid call in this run", true);
            stop(`${state.step.conditionId} failed: ${failure.code}`);
          } finally {
            options.onProgress?.({ type: "arm-execution-completed", pairIndex: p, arm: state.step.conditionId, outcome: state.status, durationMs: state.timing?.durationMs ?? 0, timestampMs: Date.now() });
          }
        };
        const exportArm = async (state: ConditionState): Promise<void> => {
          if (!dispatched.has(state.step.conditionId)) return;
          try {
            const exportSignal = isOverlap && state.status !== "infrastructure-failure" ? captureController.signal : signal;
            const captureHandle = boundedEffect(Date.now() + operationAllowanceMs, `${state.step.conditionId} capture`,
              (captureSignal) => exportArmOutput({ state, prepared: prepared.get(state.step.conditionId)!, limits: resolved.limits, guardedSecrets,
                signal: AbortSignal.any([exportSignal, captureSignal]), faults: options.faults, isFinalized: () => finalized }), "interrupted");
            pendingEffects.push({ handle: captureHandle as BoundedEffect<unknown>, conditionId: state.step.conditionId });
            await captureHandle.result;
          } catch (error: unknown) {
            const failure = structuredFrom(error);
            state.status = "infrastructure-failure";
            state.failures.push(failure);
            runFailures.push(failure);
            if (failure.code === "secret-quarantine") blockPaidCalls("a secret quarantine blocks every further paid call in this run", true);
            stop(`${state.step.conditionId} export failed: ${failure.code}`);
          }
        };
        const cleanupArm = async (state: ConditionState, deadline = Date.now() + cleanupReserveMs): Promise<void> => {
          if (cleaned.has(state.step.conditionId)) return;
          cleaned.add(state.step.conditionId);
          const outcomes = await destroyConditionResources(options.sandbox, journal, state, deadline);
          state.cleanup.push(...outcomes);
          if (outcomes.some((outcome) => outcome.status === "failed" || !outcome.verified)) {
            cleanupVerified = false;
            blockPaidCalls("a cleanup failure blocks every further paid call in this run");
            stop("a cleanup failure stopped the run");
          }
        };

        if (isOverlap) {
          await Promise.all(pairStates.map(runArm));
          await Promise.all(pairStates.map(exportArm));
          options.onProgress?.({ type: "cleanup-started", pairIndex: p, timestampMs: Date.now() });
          for (const state of pairStates) await cleanupArm(state);
        } else {
          await runArm(baselineState);
          await exportArm(baselineState);
          options.onProgress?.({ type: "cleanup-started", pairIndex: p, timestampMs: Date.now() });
          const baselineCleanupDeadline = Date.now() + cleanupReserveMs;
          await cleanupArm(baselineState, baselineCleanupDeadline);
          await verifyAbsent(options.sandbox, journal, "guest", baselineState.step.guestName, "treatment", baselineCleanupDeadline);
          await verifyAbsent(options.sandbox, journal, "network", baselineState.step.networkName, "treatment", baselineCleanupDeadline);
          if (!signal.aborted && !paidCallsBlocked) {
            await runArm(treatmentState);
            await exportArm(treatmentState);
          } else {
            treatmentState.notStartedReason = stopReason ?? "baseline outcome stopped serial dispatch";
          }
          await cleanupArm(treatmentState);
        }
        options.onProgress?.({ type: "cleanup-verified", pairIndex: p, verified: cleanupVerified, ...(cleanupVerified ? {} : { failureClass: "cleanup-failed" }), timestampMs: Date.now() });
      }

      if (preparationFailure !== null || prepared.size !== 2) {
        options.onProgress?.({ type: "cleanup-started", pairIndex: p, timestampMs: Date.now() });
        let verified = true;
        for (const state of pairStates) {
          const outcomes = await destroyConditionResources(options.sandbox, journal, state, Date.now() + cleanupReserveMs);
          state.cleanup.push(...outcomes);
          if (outcomes.some((outcome) => outcome.status === "failed" || !outcome.verified)) verified = false;
        }
        options.onProgress?.({ type: "cleanup-verified", pairIndex: p, verified, ...(verified ? {} : { failureClass: "cleanup-failed" }), timestampMs: Date.now() });
      }

    }

  } catch (error: unknown) {
    const failure = structuredFrom(error);
    runFailures.push(failure);
    if (stopReason === null) stopReason = `${failure.code}: ${failure.message}`;
    stop(stopReason);
  }

  // A condition that never started is sealed together with its KNOWN cleanup outcome.
  // The in-loop path above already records one; this pass covers the conditions the
  // execute loop never reached at all, because a throw escaped it. `cleanup: []` would
  // be indistinguishable from "cleanup ran and found nothing".
  for (const state of states) {
    if (state.status !== "not-started" || state.cleanup.length > 0) continue;
    state.cleanup.push(...(await resolveNotStartedCleanup(options.sandbox, journal, state, Date.now() + cleanupReserveMs)));
  }

  // Close every evaluator-owned prefix before promotion. This also covers arms that
  // failed during attestation or were never dispatched. Capture defects are evidence
  // infrastructure failures; only secret-quarantine blocks later paid dispatch.
  for (const state of states) {
    try {
      finalizeNativeCapture(state);
    } catch (error: unknown) {
      const failure = structuredFrom(error);
      state.status = "infrastructure-failure";
      state.notStartedReason = null;
      state.failures.push(failure);
      runFailures.push(failure);
      if (failure.code === "secret-quarantine") {
        blockPaidCalls("a secret quarantine blocks every further paid call in this run", true);
      }
      if (stopReason === null) stopReason = `${state.step.conditionId} native capture failed: ${failure.code}`;
      stop(stopReason);
    }
  }

  // -- Stage 4: validate ----------------------------------------------------
  // Deliberately its OWN top-level try/catch, not nested inside stage 3. An arm that
  // executed and produced a candidate MUST still be validated even when a post-execution
  // stage-3 step (a teardown, a verified-absence check) threw; the contract forbids
  // skipping a stage. A failure here is an INFRASTRUCTURE outcome, never a task failure.
  try {
    for (const state of states) {
      if (state.exported === null) continue;
      options.onProgress?.({
        type: "capture-grading-started",
        pairIndex: state.step.repetition,
        arm: state.step.conditionId,
        timestampMs: Date.now(),
      });
      try {
        const projection = projectCandidate({
          exportedFiles: state.exported.files,
          outputPath: frozen.config.outputPath,
          maxFileBytes: resolved.limits.maxExportedFileBytes,
          mode: candidateMode,
          maxTotalBytes: resolved.limits.maxWorkspaceBytes,
        });
        state.candidate = projection;
        // Gradeable task-limit outputs are still scored; grading has its own
        // bounded infrastructure window and observes external cancellation.
        const validatorPath = frozenSnapshot?.validatorPath ?? frozen.validatorPath;
        const validatorSource = frozenSnapshot?.validatorSource ?? frozen.validatorBytes.toString("utf8");
        const validatorEntryPath = frozenSnapshot?.validatorEntryPath ?? frozen.validatorEntryPath;
        const validatorBundle = frozen.validatorBundle?.map((file) => ({ path: file.path, base64: file.base64 }));
        const gradingDeadlineMs = operationAllowanceMs;
        const gradingCleanupDeadline = Date.now() + gradingDeadlineMs + cleanupReserveMs;
        assertNotAborted(validationController.signal, "validation");
        const gradingHandle = boundedEffect(Date.now() + gradingDeadlineMs, "validation", (gradingSignal) => options.validatorRunner.run({
          validatorPath,
          validatorSource,
          validatorEntryPath,
          validatorBundle,
          input: {
            outputPath: frozen.config.outputPath,
            fixtureFiles: fixtureFileMap(frozen.fixtureFiles),
            candidateFiles: projection.candidateFiles,
            oracle: frozen.oracle,
          },
          deadlineMs: gradingDeadlineMs,
          cleanupDeadlineAtMs: gradingCleanupDeadline,
          signal: AbortSignal.any([validationController.signal, gradingSignal]),
        }), "interrupted");
        pendingEffects.push({ handle: gradingHandle as BoundedEffect<unknown>, conditionId: state.step.conditionId });
        const validation = await gradingHandle.result;
        if (finalized || validationController.signal.aborted) throw new EvalError("interrupted", "validation completed after cancellation", { at: "validation" });
        state.validation = validation;
        if (state.validation.failure !== null || state.validation.outcome.status === "infrastructure-failure") {
          const failure = state.validation.failure ?? {
            code: "validator-infrastructure",
            failureClass: "infrastructure" as const,
            message: "validator returned an infrastructure outcome without failure detail",
            at: "validator run",
          };
          state.status = "infrastructure-failure";
          state.failures.push(failure);
          runFailures.push(failure);
          if (stopReason === null) stopReason = `validation failed: ${failure.code}`;
        } else if (frozen.rubric !== undefined && state.validation.outcome.status === "graded") {
          // Authoritative central rubric scoring
          try {
            const rubricScore = scoreWithRubric(frozen.rubric, state.validation.outcome.checks);
            state.validation = {
              ...state.validation,
              outcome: {
                ...state.validation.outcome,
                score: rubricScore.score,
                fullPass: rubricScore.fullPass,
                rubricScore,
              } as any,
            };
          } catch (rubricError: unknown) {
            const failure = structuredFrom(rubricError);
            state.status = "infrastructure-failure";
            state.failures.push(failure);
            runFailures.push(failure);
            state.validation = {
              ...state.validation,
              failure,
              outcome: {
                status: "infrastructure-failure",
                score: null,
                fullPass: null,
                checks: state.validation.outcome.checks,
              },
            };
            if (stopReason === null) stopReason = `rubric scoring failed: ${failure.message}`;
          }
        }
        options.onProgress?.({
          type: "capture-grading-completed",
          pairIndex: state.step.repetition,
          arm: state.step.conditionId,
          disposition: state.status,
          timestampMs: Date.now(),
        });
      } catch (error: unknown) {
        const failure = structuredFrom(error);
        state.failures.push(failure);
        runFailures.push(failure);
        state.status = "infrastructure-failure";
        options.onProgress?.({
          type: "capture-grading-completed",
          pairIndex: state.step.repetition,
          arm: state.step.conditionId,
          disposition: "infrastructure-failure",
          timestampMs: Date.now(),
        });
      }
    }
  } catch (error: unknown) {
    const failure = structuredFrom(error);
    runFailures.push(failure);
    if (stopReason === null) stopReason = `validation stage failed: ${failure.code}`;
    stop(stopReason);
  }

  // -- Stage 5: clean up ----------------------------------------------------
  // Every journaled exact identity, on success, error, signal, or timeout.
  // Shared immutable cached images are shared build assets, not per-run
  // resources that must be destroyed after every run. Final run cleanup never deletes
  // a shared cached image or another run's resources.
  const sweep: CleanupRecord[] = [];
  // The final sweep is a bounded infrastructure operation anchored at cleanup start, so it
  // stays bounded even when the arm ran unlimited (there is no overall run-time ceiling).
  const sweepDeadlineAtMs = Date.now() + cleanupReserveMs;
  // Give every timed-out operation a bounded chance to settle before exact inspection.
  const settledPending = new Set<typeof pendingEffects[number]>();
  for (const pending of pendingEffects) {
    const remaining = Math.min(5_000, sweepDeadlineAtMs - Date.now());
    if (remaining <= 0) break;
    const settled = await settlesWithin(pending.handle.settled, remaining);
    if (settled) settledPending.add(pending);
  }
  const journalEntries = journal.entries();
  for (const identity of journaledIdentities(journalEntries)) {
    if (identity.kind === "image") continue;
    const creationObserved = journalEntries.some((entry) => entry.event === "observed" && entry.action === "create" && entry.kind === identity.kind && entry.name === identity.name && entry.status === "created");
    const creationPending = pendingEffects.find((pending) => pending.conditionId === identity.conditionId);
    if (!creationObserved && creationPending !== undefined && !settledPending.has(creationPending)) {
      const outcome = {
        kind: identity.kind,
        name: identity.name,
        status: "failed",
        verified: false,
        detail: `${identity.kind} ${identity.name} creation did not settle within the cleanup window`,
        failure: { code: "cleanup-failed", failureClass: "infrastructure" as const, message: "creation unresolved; absence was not inspected", at: identity.name },
      } satisfies CleanupRecord;
      sweep.push(outcome);
      blockPaidCalls("a cleanup failure blocks every further paid call in this run");
      runFailures.push(outcome.failure);
      continue;
    }
    const inspectHandle = boundedEffect(sweepDeadlineAtMs, `final inspect ${identity.kind} ${identity.name}`, (signal) =>
      options.sandbox.inspectResource(identity.kind, identity.name, signal),
    );
    let inspectSettled = false;
    void inspectHandle.settled.then(() => { inspectSettled = true; });
    const presence = await inspectHandle.result.catch(() => "present" as const);
    const outcome = !inspectSettled
      ? {
          kind: identity.kind,
          name: identity.name,
          status: "failed",
          verified: false,
          detail: `${identity.kind} ${identity.name} exact-identity inspection did not settle within the cleanup window`,
          failure: { code: "cleanup-failed", failureClass: "infrastructure" as const, message: "cleanup inspection unresolved", at: identity.name },
        } satisfies CleanupRecord
      : presence === "absent"
      ? {
          kind: identity.kind,
          name: identity.name,
          status: "already-absent",
          verified: true,
          detail: `${identity.kind} ${identity.name} remained absent during the final exact-identity sweep`,
          failure: null,
        } satisfies CleanupRecord
      : await destroyExact(options.sandbox, journal, identity.kind, identity.name, identity.conditionId, sweepDeadlineAtMs);
    sweep.push(outcome);
    if (outcome.status === "failed") {
      blockPaidCalls("a cleanup failure blocks every further paid call in this run");
      runFailures.push(
        outcome.failure ?? {
          code: "cleanup-failed",
          failureClass: "infrastructure",
          message: `failed to destroy ${identity.kind} ${identity.name}`,
          at: identity.name,
        },
      );
    }
  }

  const incompleteState = states.find((state) => state.status === "infrastructure-failure" || state.status === "not-started");
  const cleanupFailure = [...states.flatMap((state) => state.cleanup), ...sweep].find((record) => !record.verified || record.status === "failed");
  if (stopReason === null && cleanupFailure) stopReason = `cleanup failed: ${cleanupFailure.name}`;
  if (stopReason === null && incompleteState) stopReason = `${incompleteState.step.conditionId} ended ${incompleteState.status}`;
  if (stopReason === null && runFailures.length > 0) stopReason = `run recorded infrastructure failure: ${runFailures[0]!.code}`;

  // -- Stage 6: seal --------------------------------------------------------
  // Guarded: a record-write failure here must surface as a structured `evidence-invalid`
  // failure, not as a raw error, and must not leave a half-sealed run unannounced. The
  // signal handlers stay installed for the whole of this stage.
  finalized = true;
  sealing = true;
  options.onProgress?.({ type: "sealing-started", timestampMs: Date.now() });
  let receiptPath: string;
  try {
    receiptPath = await sealRun({
      store,
      options,
      frozen,
      plan,
      states,
      sweep,
      stopReason,
      runFailures,
    });
    const verification = await verifyRun(runDir);
    options.onProgress?.({
      type: "finalization-completed",
      success: verification.ok,
      error: verification.ok ? undefined : "hash chain verification failed",
      timestampMs: Date.now(),
    });
    if (!verification.ok) {
      throw new EvalError("evidence-invalid", "sealed receipt failed hash-chain verification", { at: "receipt.json" });
    }
    // Canonical session.json now exists and its receipt verifies. Deleting earlier
    // would destroy the only recoverable prefix if sealing failed.
    for (const state of states) state.nativeCapture?.removeAfterSeal();
  } catch (error: unknown) {
    const failure = toStructuredFailure(error, "evidence-invalid");
    options.onProgress?.({ type: "finalization-completed", success: false, error: failure.message, timestampMs: Date.now() });
    // A regenerable view, outside the hash chain, so the incomplete tree is not silent.
    await store
      .writeView(
        "seal-failure.txt",
        [
          `run ${options.runId}`,
          `sealing FAILED [${failure.code}] at ${failure.at ?? "(unknown)"}: ${failure.message}`,
          "This run is half-sealed: it has no valid receipt and MUST NOT be reported as a result.",
          "",
        ].join("\n"),
      )
      .catch(() => undefined);
    throw new EvalError(
      "evidence-invalid",
      `sealing run ${options.runId} failed and the evidence tree at ${runDir} is incomplete: [${failure.code}] ${failure.message}`,
      failure.at === null ? {} : { at: failure.at },
    );
  } finally {
    sealing = false;
    releaseCancellation();
  }

  return {
    runId: options.runId,
    runDir,
    receiptPath,
    status: stopReason === null ? "complete" : "partial",
    stopReason,
    journalPath: journal.path,
    failures: runFailures,
  };
}

function isTestDoubleRun(options: {
  readonly harness: Harness;
  readonly sandbox: Sandbox;
  readonly validatorRunner: ValidatorRunner;
}): boolean {
  return options.harness.testDouble || options.sandbox.testDouble || options.validatorRunner.testDouble;
}

// ---------------------------------------------------------------------------
// Freeze: frozen input records
// ---------------------------------------------------------------------------

async function writeFrozenInputs(
  store: EvidenceStore,
  input: {
    readonly plan: RunPlan;
    readonly target: Target;
    readonly limits: Limits;
    readonly limitProvenance: Readonly<Record<string, string>>;
    readonly executionPolicy: ExecutionPolicy;
    readonly networkPolicy: NetworkPolicy;
    readonly guestPolicy: GuestPolicy;
    readonly frozen: FrozenCase;
    readonly snapshot: SkillSnapshot;
    readonly skillGuestPath: string;
    readonly skillToolBundle: SkillToolBundle;
    readonly image: { reference: string; digest: string; runtimeProfileId: string; testDouble: boolean };
    readonly mode: RunMode;
    readonly harnessId: string;
    readonly sandboxId: string;
    readonly validatorRunnerId: string;
    readonly testDouble: boolean;
  },
): Promise<void> {
  await store.writeRecord("inputs/plan.json", input.plan);
  await store.writeRecord("inputs/target.json", {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    provider: input.target.provider,
    model: input.target.model,
    thinking: input.target.thinking,
    mode: input.mode,
    harnessId: input.harnessId,
    sandboxId: input.sandboxId,
    validatorRunnerId: input.validatorRunnerId,
    testDouble: input.testDouble,
    image: input.image,
  });
  await store.writeRecord("inputs/policy.json", {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    execution: input.executionPolicy,
    network: input.networkPolicy,
    guest: input.guestPolicy,
    limits: input.limits,
    limitProvenance: input.limitProvenance,
    runtimeProfileId: input.frozen.runtimeProfileId,
  });
  await store.writeRecord("inputs/case.json", {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    suiteId: input.frozen.suite.id,
    selector: input.frozen.selector,
    caseId: input.frozen.config.id,
    caseVersion: input.frozen.config.version,
    prompt: input.frozen.config.prompt,
    promptSha256: input.frozen.promptSha256,
    outputPath: input.frozen.config.outputPath,
    allowedTools: [...input.frozen.config.allowedTools],
    runtimeProfileId: input.frozen.runtimeProfileId,
    candidateMode: input.frozen.config.candidateMode,
    oracleSha256: input.frozen.oracleSha256,
    validatorSha256: input.frozen.validatorSha256,
    validatorClosureSha256: input.frozen.validatorClosureSha256,
    fixtureTreeSha256: input.frozen.fixtureTreeSha256,
    fixtureFiles: input.frozen.fixtureFiles.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
  });
  await store.writeRecord("inputs/skill-snapshot.json", {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    sourcePath: input.snapshot.sourcePath,
    guestPath: input.skillGuestPath,
    treeSha256: input.snapshot.treeSha256,
    totalBytes: input.snapshot.totalBytes,
    fileCount: input.snapshot.files.length,
    files: input.snapshot.files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    // Recorded explicitly: baseline is planned against these bytes and stages none of them.
    stagedInConditions: ["treatment"],
    boundToConditions: ["baseline", "treatment"],
  });
  await store.writeRecord("inputs/skill-tool-bundle.json", input.skillToolBundle);

  // Promote full frozen input snapshot bytes into evidence store
  const frozenEntries: ManifestEntry[] = [];

  // 1. Prompt
  const promptBytes = Buffer.from(input.frozen.config.prompt, "utf8");
  await store.writeFile("inputs/frozen/case/prompt.txt", promptBytes);
  frozenEntries.push({ path: "case/prompt.txt", sha256: sha256Hex(promptBytes), bytes: promptBytes.byteLength });

  // 2. Case config
  const caseConfigBytes = Buffer.from(canonicalJson(input.frozen.config, "case.config"), "utf8");
  await store.writeFile("inputs/frozen/case/case.json", caseConfigBytes);
  frozenEntries.push({ path: "case/case.json", sha256: sha256Hex(caseConfigBytes), bytes: caseConfigBytes.byteLength });

  // 3. Oracle bytes
  await store.writeFile("inputs/frozen/case/oracle.json", input.frozen.oracleBytes);
  frozenEntries.push({ path: "case/oracle.json", sha256: sha256Hex(input.frozen.oracleBytes), bytes: input.frozen.oracleBytes.byteLength });

  // 4. Validator files
  if (input.frozen.validatorBundle !== undefined) {
    for (const file of input.frozen.validatorBundle) {
      const content = Buffer.from(file.base64, "base64");
      const relPath = `inputs/frozen/case/validator/${file.path}`;
      await store.writeFile(relPath, content);
      frozenEntries.push({
        path: `case/validator/${file.path}`,
        sha256: file.sha256,
        bytes: file.bytes,
      });
    }
  } else {
    const validatorRelName = basename(input.frozen.config.validator);
    const validatorRelPath = `inputs/frozen/case/validator/${validatorRelName}`;
    await store.writeFile(validatorRelPath, input.frozen.validatorBytes);
    frozenEntries.push({
      path: `case/validator/${validatorRelName}`,
      sha256: sha256Hex(input.frozen.validatorBytes),
      bytes: input.frozen.validatorBytes.byteLength,
    });
  }

  // 5. Fixture files
  for (const file of input.frozen.fixtureFiles) {
    const content = Buffer.from(file.base64, "base64");
    await store.writeFile(`inputs/frozen/fixture/${file.path}`, content);
    frozenEntries.push({ path: `fixture/${file.path}`, sha256: file.sha256, bytes: file.bytes });
  }

  // 6. Skill files
  for (const file of input.snapshot.files) {
    const filePath = join(input.snapshot.snapshotDir, ...file.path.split("/"));
    const content = await readFile(filePath);
    await store.writeFile(`inputs/frozen/skill/${file.path}`, content);
    frozenEntries.push({ path: `skill/${file.path}`, sha256: file.sha256, bytes: file.bytes });
  }

  // 7. Provenance, if present
  if (input.frozen.preparationProvenance !== null) {
    const provBytes = Buffer.from(canonicalJson(input.frozen.preparationProvenance, "preparationProvenance"), "utf8");
    await store.writeFile("inputs/frozen/provenance.json", provBytes);
    await store.writeRecord("inputs/provenance.json", {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      provenance: input.frozen.preparationProvenance,
    });
    frozenEntries.push({ path: "provenance.json", sha256: sha256Hex(provBytes), bytes: provBytes.byteLength });
  }

  // 8. Rubric, if present
  if (input.frozen.rubricBytes !== undefined) {
    await store.writeFile("inputs/frozen/case/rubric.json", input.frozen.rubricBytes);
    await store.writeFile("inputs/rubric.json", input.frozen.rubricBytes);
    frozenEntries.push({
      path: "case/rubric.json",
      sha256: input.frozen.rubricSha256 ?? sha256Hex(input.frozen.rubricBytes),
      bytes: input.frozen.rubricBytes.byteLength,
    });
  }

  // 9. Snapshot manifest
  const frozenManifest = buildManifestTree(frozenEntries, EVIDENCE_SCHEMA_VERSION);
  await store.writeRecord("inputs/frozen/manifest.json", {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    treeSha256: frozenManifest.treeSha256,
    entries: frozenManifest.entries,
  });
}

async function readSnapshotFiles(
  snapshot: SkillSnapshot,
): Promise<ReadonlyArray<{ path: string; base64: string; mode: number }>> {
  const files: Array<{ path: string; base64: string; mode: number }> = [];
  for (const file of snapshot.files) {
    const bytes = await readFile(join(snapshot.snapshotDir, ...file.path.split("/")));
    files.push({ path: file.path, base64: bytes.toString("base64"), mode: 0o444 });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Execute: one condition
// ---------------------------------------------------------------------------

interface PreparedCondition {
  readonly guest: Guest;
  readonly network: { name: string };
  readonly request: HarnessRequest;
}

async function prepareCondition(input: {
  readonly state: ConditionState;
  readonly sandbox: Sandbox;
  readonly harness: Harness;
  readonly journal: RunJournal;
  readonly frozen: FrozenCase;
  readonly limits: Limits;
  readonly target: Target;
  readonly imageDigest: string;
  readonly skillGuestPath: string;
  readonly snapshotFiles: ReadonlyArray<{ path: string; base64: string; mode: number }>;
  readonly guardedSecrets: readonly GuardedSecret[];
  readonly credentials: readonly CredentialDeliveryRequest[];
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
  readonly skillToolBundle: SkillToolBundle;
  readonly skillToolBundleSha256: string;
  readonly captureReasoning?: boolean;
  readonly isFinalized?: () => boolean;
}): Promise<PreparedCondition> {
  const { state, sandbox, journal, frozen, signal } = input;
  const conditionId = state.step.conditionId;
  const cancelled = (): void => {
    if (input.signal.aborted || input.isFinalized?.() === true) throw new EvalError("interrupted", "condition preparation completed after cancellation", { at: "condition preparation" });
  };

  await journal.record({
    event: "intent",
    action: "create",
    kind: "network",
    name: state.step.networkName,
    conditionId,
    status: null,
  });
  const networkHandle = boundedEffect(input.deadlineAtMs, `create network ${state.step.networkName}`, (creationSignal) =>
    sandbox.createNetwork(state.step.networkName, EVAL_NETWORK_POLICY, AbortSignal.any([signal, creationSignal]), input.deadlineAtMs));
  state.creationHandles.network = networkHandle;
  const network = await networkHandle.result;
  cancelled();
  await journal.record({
    event: "observed",
    action: "create",
    kind: "network",
    name: network.name,
    conditionId,
    status: "created",
  });
  cancelled();

  await journal.record({
    event: "intent",
    action: "create",
    kind: "guest",
    name: state.step.guestName,
    conditionId,
    status: null,
  });
  const boundaryDeadlineAtMs = Number.isFinite(input.deadlineAtMs) ? input.deadlineAtMs : undefined;
  const guestHandle = boundedEffect(input.deadlineAtMs, `create guest ${state.step.guestName}`, (creationSignal) =>
    sandbox.createGuest({
      name: state.step.guestName,
      networkName: network.name,
      imageDigest: input.imageDigest,
      limits: input.limits,
      policy: EVAL_GUEST_POLICY,
      // Creation is bounded by the signal from boundedEffect. Its setup deadline must
      // not become the lifetime of a guest that will execute after preparation.
      signal: AbortSignal.any([signal, creationSignal]),
      env: {
        HOME: EVAL_HOME_DIR,
        TMPDIR: "/tmp",
        EVAL_CONDITION: conditionId,
        EVAL_WORKSPACE: EVAL_WORKSPACE_ROOT,
      },
    }));
  state.creationHandles.guest = guestHandle;
  const guest: Guest = await guestHandle.result;
  await journal.record({
    event: "observed",
    action: "create",
    kind: "guest",
    name: guest.name,
    conditionId,
    status: "created",
  });
  cancelled();

  const guestAttestation = await guest.attest(signal, boundaryDeadlineAtMs);
  cancelled();
  state.attestation = guestAttestation;

  for (const cred of input.credentials) {
    cancelled();
    await guest.deliverCredential({ ...cred, signal, deadlineAtMs: boundaryDeadlineAtMs });
    cancelled();
  }

  cancelled();
  await guest.stage({
    destDir: EVAL_WORKSPACE_ROOT,
    files: frozen.fixtureFiles.map((file) => ({ path: file.path, base64: file.base64, mode: 0o644 })),
    readOnly: false,
    signal,
  });

  cancelled();
  if (state.plan.skillPaths.length === 1) {
    await guest.stage({
      destDir: input.skillGuestPath,
      files: [...input.snapshotFiles],
      readOnly: true,
      signal,
    });
    cancelled();
  }

  const request: HarnessRequest = {
    conditionId,
    prompt: frozen.config.prompt,
    workspaceRoot: EVAL_WORKSPACE_ROOT,
    skillPaths: [...state.plan.skillPaths],
    allowedTools: [...frozen.config.allowedTools],
    skillToolBundle: conditionId === "treatment" ? input.skillToolBundle : null,
    skillToolBundleSha256: input.skillToolBundleSha256,
    limits: input.limits,
    target: input.target,
    signal,
    deadlineAtMs: boundaryDeadlineAtMs,
    guardedSecrets: input.guardedSecrets,
    captureReasoning: input.captureReasoning,
    ...(state.nativeCapture === null ? {} : {
      nativeSessionRecorder: { record: state.nativeCapture.record.bind(state.nativeCapture) },
    }),
  };

  const harnessAttestation = await input.harness.attest(guest, request);
  cancelled();
  state.runtime = harnessAttestation.runtime;

  cancelled();
  return { guest, network, request };
}

async function dispatchArmPrompt(input: {
  readonly state: ConditionState;
  readonly harness: Harness;
  readonly prepared: PreparedCondition;
  readonly limits: Limits;
  readonly signal: AbortSignal;
  readonly isFinalized?: () => boolean;
}): Promise<void> {
  const { state, harness, prepared, limits, signal } = input;
  const cancelled = (): void => {
    if (signal.aborted || input.isFinalized?.() === true) throw new EvalError("interrupted", "arm completed after cancellation", { at: "arm dispatch" });
  };
  const conditionController = new AbortController();
  const onRunAbort = (): void => {
    conditionController.abort(signal.reason);
  };
  if (signal.aborted) {
    conditionController.abort(signal.reason);
  } else {
    signal.addEventListener("abort", onRunAbort, { once: true });
  }

  // Unlimited arm (wallClockMs === null): arm NO wall-clock watchdog and pass no deadline
  // to the harness. Cancellation and the guest's own infrastructure liveness still apply.
  let armTimer: DeadlineTimer | null = null;
  if (limits.wallClockMs !== null) {
    const wallClockMs = limits.wallClockMs;
    armTimer = scheduleTimeout(() => {
      const reason = new Error(`wall-clock deadline of ${wallClockMs}ms elapsed`);
      reason.name = "ArmBudgetExceeded";
      conditionController.abort(reason);
    }, wallClockMs);
    armTimer.unref();
  }

  try {
    const requestWithSignal: HarnessRequest = {
      ...prepared.request,
      deadlineAtMs: limits.wallClockMs !== null ? Date.now() + limits.wallClockMs : undefined,
      signal: conditionController.signal,
    };
    const result = await harness.run(prepared.guest, requestWithSignal);
    cancelled();
    // A recorder failure is the authoritative cause: the SDK carrier may legitimately
    // contain the entry whose bounded durable append was rejected. Preserve the last
    // fsynced prefix and classify the arm as ungradeable infrastructure instead of
    // relabelling that expected tail difference as a promotion mismatch.
    const captureFailure = state.nativeCapture?.failure();
    if (captureFailure) throw captureFailure;
    const livePrefix = state.nativeCapture?.snapshot();
    if (livePrefix && livePrefix.entries.length > 0 && result.nativeSessionEntries) {
      try {
        // The harness already sanitized result.nativeSessionEntries (either the guest's
        // per-record sanitization relayed over frames, or the local path's own single pass
        // over the SDK's raw in-memory entries), so this sanitization is not adding a second
        // *sanitization* pass over trusted data - it is independently re-verifying an
        // *untrusted* claim. A harness is arbitrary code (including test doubles and
        // future harnesses); if its reported entries still carry a live secret, that must
        // surface as secret-quarantine specifically, because only that code blocks every
        // further paid call in the run (see the `blockPaidCalls` call sites keyed on it) -
        // a plain mismatch below would only fail this one condition.
        const carrier = sanitizeNativeSessionEntries(
          result.nativeSessionEntries as readonly NativeSessionEntry[],
          prepared.request.guardedSecrets ?? [],
          { captureReasoning: prepared.request.captureReasoning },
        );
        if (canonicalJson(carrier.entries, "native result carrier") !==
            canonicalJson(livePrefix.entries, "native durable prefix")) {
          throw new EvalError("evidence-invalid", "native result carrier does not match the durable SDK prefix", {
            at: `session:${state.step.conditionId}`,
          });
        }
      } catch (error: unknown) {
        state.nativePromotionFailure = error instanceof EvalError
          ? error
          : new EvalError("evidence-invalid", "native result carrier verification failed", { at: `session:${state.step.conditionId}` });
        throw error;
      }
    }
    cancelled();
    state.runtime = result.runtime;
    cancelled();
    state.messages = result.messages;
    cancelled();
    state.toolSteps = result.toolSteps;
    cancelled();
    state.sessionEntries = (result.nativeSessionEntries as readonly NativeSessionEntry[]) ?? [];
    state.sessionRedactions = result.nativeSessionRedactions ?? {
      count: 0,
      entries: [],
    };
    cancelled();
    state.usage = result.usage;
    cancelled();
    state.timing = result.timing;
    state.stopCause = result.stopCause;
    state.providerStopReason = result.providerStopReason;
    state.failures.push(...result.failures);
    state.notStartedReason = null;
    state.status = result.outcome;
  } finally {
    if (armTimer !== null) armTimer.cancel();
    signal.removeEventListener("abort", onRunAbort);
    if (!input.isFinalized?.() && !signal.aborted) finalizeNativeCapture(state);
  }
}

function finalizeNativeCapture(state: ConditionState): void {
  if (state.nativeCapture === null || state.nativePrefix !== null) return;
  const completed = state.status === "completed";
  const reason = completed ? null : `native capture ended with condition status ${state.status}`;
  const prefix = state.nativeCapture.finish(completed, reason);
  state.nativePrefix = prefix;
  if (prefix.entries.length > 0) {
    state.sessionEntries = prefix.entries;
    state.sessionRedactions = prefix.redactions;
  }
  const failure = state.nativeCapture.failure();
  if (failure) throw failure;
}

async function exportArmOutput(input: {
  readonly state: ConditionState;
  readonly prepared: PreparedCondition;
  readonly limits: Limits;
  readonly guardedSecrets: readonly GuardedSecret[];
  readonly signal: AbortSignal;
  readonly isFinalized?: () => boolean;
  readonly faults?: {
    readonly simulateSurvivingSecretHit?: boolean;
  };
}): Promise<void> {
  const { state, prepared, limits, signal } = input;
  const exported = await prepared.guest.exportFiles({
    root: EVAL_WORKSPACE_ROOT,
    maxFiles: limits.maxExportedFiles,
    maxFileBytes: limits.maxExportedFileBytes,
    maxTotalBytes: limits.maxWorkspaceBytes,
    signal,
  });
  if (signal.aborted || input.isFinalized?.() === true) throw new EvalError("interrupted", "export completed after cancellation", { at: "output capture" });

  const redactionEntries: SecretRedaction[] = [];
  let totalRedactions = 0;

  const hasNativeEntries = state.sessionEntries.length > 0;

  const redactedFiles = exported.files.map((file) => {
    const rawBytes = Buffer.from(file.base64, "base64");
    const redacted = redactSecretBytes(rawBytes, input.guardedSecrets, `workspace:${file.path}`);
    if (redacted.count > 0) {
      redactionEntries.push(...redacted.redactions);
      totalRedactions += redacted.count;
      const newBuf = Buffer.from(redacted.bytes);
      return {
        path: file.path,
        bytes: newBuf.byteLength,
        sha256: sha256Hex(newBuf),
        base64: newBuf.toString("base64"),
      };
    }
    return file;
  });

  // Native session redactions: carry into condition total once without double counting
  if (hasNativeEntries && state.sessionRedactions && state.sessionRedactions.count > 0) {
    redactionEntries.push(...state.sessionRedactions.entries);
    totalRedactions += state.sessionRedactions.count;
  }

  // Messages and tool steps:
  // If native entries exist and were already sanitized, messages and tool steps are derived views
  // from already-sanitized session entries. We do NOT add their redactions to condition totals
  // to avoid counting derived copies twice.
  // If native session redactions are not present, messages and tool steps are primary transcript
  // provenance and their redactions count toward condition totals.
  const redactedMessages = state.messages.map((message) => {
    const redacted = redactSecrets(message.text, input.guardedSecrets, `messages[${message.index}]`);
    if (redacted.count > 0) {
      if (!hasNativeEntries || !state.sessionRedactions || state.sessionRedactions.count === 0) {
        redactionEntries.push(...redacted.redactions);
        totalRedactions += redacted.count;
      }
      return {
        ...message,
        text: redacted.text,
      };
    }
    return message;
  });

  const redactedToolSteps = state.toolSteps.map((step) => {
    const redacted = redactSecrets(step.summary, input.guardedSecrets, `toolSteps[${step.index}]`);
    if (redacted.count > 0) {
      if (!hasNativeEntries || !state.sessionRedactions || state.sessionRedactions.count === 0) {
        redactionEntries.push(...redacted.redactions);
        totalRedactions += redacted.count;
      }
      return {
        ...step,
        summary: redacted.text,
      };
    }
    return step;
  });

  if (input.faults?.simulateSurvivingSecretHit && input.guardedSecrets.length > 0) {
    redactedMessages.push({
      index: 9999,
      role: "assistant",
      text: `surviving leak: ${input.guardedSecrets[0]?.value}`,
      truncated: false,
    });
  }

  const survivingHits = scanManyForSecrets(
    [
      ...redactedFiles.map((file) => ({ path: `workspace:${file.path}`, content: Buffer.from(file.base64, "base64") })),
      ...redactedMessages.map((message) => ({ path: `messages[${message.index}]`, content: message.text })),
      ...redactedToolSteps.map((step) => ({ path: `toolSteps[${step.index}]`, content: step.summary })),
    ],
    input.guardedSecrets,
  );

  if (survivingHits.length > 0) {
    if (signal.aborted || input.isFinalized?.() === true) throw new EvalError("interrupted", "output capture completed after cancellation", { at: "output capture" });
    state.messages = [];
    state.toolSteps = [];
    state.exported = null;
    throw new EvalError(
      "secret-quarantine",
      `${state.step.conditionId} secret redaction could not be verified; surviving hit(s): ${[...new Set(survivingHits.map((hit) => `${hit.label}/${hit.encoding}`))].join(", ")}; the exported workspace was discarded`,
      { at: survivingHits[0]?.path ?? state.step.conditionId },
    );
  }

  state.exported = { ...exported, files: redactedFiles };
  state.messages = redactedMessages;
  state.toolSteps = redactedToolSteps;
  state.redactions = {
    count: totalRedactions,
    entries: redactionEntries,
  };
}

async function executeCondition(input: {
  readonly state: ConditionState;
  readonly sandbox: Sandbox;
  readonly harness: Harness;
  readonly journal: RunJournal;
  readonly frozen: FrozenCase;
  readonly limits: Limits;
  readonly target: Target;
  readonly imageDigest: string;
  readonly skillGuestPath: string;
  readonly snapshotFiles: ReadonlyArray<{ path: string; base64: string; mode: number }>;
  readonly guardedSecrets: readonly GuardedSecret[];
  readonly credentials: readonly CredentialDeliveryRequest[];
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
  readonly skillToolBundle: SkillToolBundle;
  readonly skillToolBundleSha256: string;
  readonly captureReasoning?: boolean;
  readonly faults?: {
    readonly simulateSurvivingSecretHit?: boolean;
  };
}): Promise<void> {
  const prepared = await prepareCondition(input);
  await dispatchArmPrompt({
    state: input.state,
    harness: input.harness,
    prepared,
    limits: input.limits,
    signal: input.signal,
  });
  await exportArmOutput({
    state: input.state,
    prepared,
    limits: input.limits,
    guardedSecrets: input.guardedSecrets,
    signal: input.signal,
    faults: input.faults,
  });
}

/**
 * Confirms, by exact-identity lookup, that a condition which never started also never
 * created its guest or network. Recorded so a not-started seal carries a real cleanup
 * outcome rather than an assumption.
 */
async function confirmNeverCreated(
  sandbox: Sandbox,
  journal: RunJournal,
  state: ConditionState,
  deadlineAtMs: number,
): Promise<readonly CleanupRecord[]> {
  const records: CleanupRecord[] = [];
  for (const [kind, name] of [
    ["guest", state.step.guestName],
    ["network", state.step.networkName],
  ] as ReadonlyArray<readonly [ResourceKind, string]>) {
    const presenceHandle = boundedEffect(deadlineAtMs, `confirm absent ${kind} ${name}`, (cleanupSignal) => sandbox.inspectResource(kind, name, cleanupSignal));
    const presence = await presenceHandle.result.catch(() => "present" as const);
    await journal.record({
      event: "observed",
      action: "verify",
      kind,
      name,
      conditionId: state.step.conditionId,
      status: presence,
    });
    records.push({
      kind,
      name,
      status: presence === "absent" ? "already-absent" : "failed",
      verified: presence === "absent",
      detail:
        presence === "absent"
          ? `${kind} ${name} was confirmed absent by exact-identity lookup; its condition never started`
          : `${kind} ${name} was found present although its condition never started`,
      failure:
        presence === "absent"
          ? null
          : {
              code: "cleanup-failed",
              failureClass: "infrastructure",
              message: `${kind} ${name} exists although its condition never started`,
              at: name,
            },
    });
  }
  return records;
}

/**
 * The known cleanup outcome for a condition the execute loop never reached.
 *
 * When nothing was ever journaled for the condition, that is stated affirmatively rather
 * than left as an empty array: "no resource was journaled" and "cleanup ran and found
 * nothing" are different claims and must not be sealed identically. When something WAS
 * journaled, the real exact-identity lookup runs.
 */
async function resolveNotStartedCleanup(
  sandbox: Sandbox,
  journal: RunJournal,
  state: ConditionState,
  deadlineAtMs: number,
): Promise<readonly CleanupRecord[]> {
  const journaled = journal
    .entries()
    .some((entry) => entry.action === "create" && entry.conditionId === state.step.conditionId);
  if (journaled) return confirmNeverCreated(sandbox, journal, state, deadlineAtMs);
  return ([
    ["guest", state.step.guestName],
    ["network", state.step.networkName],
  ] as ReadonlyArray<readonly [ResourceKind, string]>).map(([kind, name]) => ({
    kind,
    name,
    status: NO_RESOURCE_JOURNALED_STATUS,
    verified: true,
    detail: `no ${kind} was journaled for ${state.step.conditionId}; the condition never started and nothing could have been created`,
    failure: null,
  }));
}

// ---------------------------------------------------------------------------
// Cleanup helpers (exact identity only)
// ---------------------------------------------------------------------------

function outcomeToRecord(
  kind: ResourceKind,
  name: string,
  outcome: DestroyOutcome,
  detail: string | null,
): CleanupRecord {
  return {
    kind,
    name,
    status: outcome.status,
    verified: outcome.verified,
    detail,
    failure: outcome.failure,
  };
}

interface BoundedEffect<T> {
  readonly result: Promise<T>;
  /** Settles only when the underlying operation settles, including late rejection. */
  readonly settled: Promise<void>;
}

function boundedEffect<T>(deadlineAtMs: number, label: string, effect: (signal: AbortSignal) => Promise<T>, failureCode: "cleanup-failed" | "interrupted" = "cleanup-failed"): BoundedEffect<T> {
  // A non-finite deadline (positive infinity) means "no timer": run the effect without a
  // watchdog. This is how an explicitly-unlimited window is represented; it never collapses
  // to an immediate timeout the way setTimeout(Infinity) would (Node clamps that to 1ms).
  if (!Number.isFinite(deadlineAtMs)) {
    const work = effect(new AbortController().signal);
    const settled = work.then(() => undefined, () => undefined);
    work.catch(() => undefined);
    return { result: work, settled };
  }
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 0) {
    const error = Promise.reject<T>(new EvalError(failureCode, `${label} exceeded its operation deadline`, { at: label }));
    return { result: error, settled: error.then(() => undefined, () => undefined) };
  }
  const controller = new AbortController();
  let timer: DeadlineTimer | null = null;
  const work = effect(controller.signal);
  const settled = work.then(() => undefined, () => undefined);
  work.catch(() => undefined);
  const result = Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = scheduleTimeout(() => {
        const failure = new EvalError(failureCode, `${label} exceeded its operation deadline`, { at: label });
        controller.abort(failure);
        reject(failure);
      }, remaining);
    }),
  ]).finally(() => {
    if (timer !== null) timer.cancel();
  });
  return { result, settled };
}

/** Waits for an operation to settle without leaving the losing timeout alive. */
async function settlesWithin(settled: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function destroyExact(
  sandbox: Sandbox,
  journal: RunJournal,
  kind: ResourceKind,
  name: string,
  conditionId: ConditionId | null,
  deadlineAtMs = Number.POSITIVE_INFINITY,
): Promise<CleanupRecord> {
  await journal.record({ event: "intent", action: "destroy", kind, name, conditionId, status: null });
  let outcome: DestroyOutcome;
  let detail: string | null = null;
  try {
    const destroyHandle = boundedEffect(deadlineAtMs, `destroy ${kind} ${name}`, (signal) => sandbox.destroyResource(kind, name, signal));
    // `settled` absorbs rejection; only the bounded result's fulfillment is a successful destroy.
    let destroySucceeded = false;
    void destroyHandle.result.then(() => { destroySucceeded = true; }, () => undefined);
    try {
      outcome = await destroyHandle.result;
    } catch (error: unknown) {
      const settleRemaining = Math.min(5_000, deadlineAtMs - Date.now());
      let didSettle = false;
      void destroyHandle.settled.then(() => { didSettle = true; });
      if (settleRemaining > 0) {
        await settlesWithin(destroyHandle.settled, settleRemaining);
      }
      if (!didSettle) {
        outcome = { status: "failed", verified: false, failure: { code: "cleanup-failed", failureClass: "infrastructure", message: `destroy ${kind} ${name} did not settle`, at: name } };
      } else if (destroySucceeded) {
        // The bounded result timed out, but the retained operation did complete;
        // exact re-inspection below is still the authority for verified absence.
        outcome = { status: "destroyed", verified: false, failure: null };
        detail = `destroying ${kind} ${name} settled after its operation deadline`;
      } else {
        outcome = { status: "failed", verified: false, failure: toStructuredFailure(error, "cleanup-failed") };
        detail = `destroying ${kind} ${name} timed out before its settled result was usable`;
      }
    }
  } catch (error: unknown) {
    outcome = { status: "failed", verified: false, failure: toStructuredFailure(error, "cleanup-failed") };
    detail = `destroying ${kind} ${name} threw`;
  }
  if (outcome.status !== "failed") {
    // Trust nothing: confirm absence by exact-identity lookup rather than by the
    // destroy call's own return value.
    const inspectHandle = boundedEffect(deadlineAtMs, `inspect ${kind} ${name}`, (signal) => sandbox.inspectResource(kind, name, signal));
    const presence = await inspectHandle.result.catch(() => "present" as const);
    if (presence === "present") {
      detail = `${kind} ${name} reported ${outcome.status} but was still present on re-inspection`;
      outcome = {
        status: "failed",
        verified: false,
        failure: {
          code: "cleanup-failed",
          failureClass: "infrastructure",
          message: `${kind} ${name} is still present after destruction`,
          at: name,
        },
      };
    } else if (detail === null) {
      detail = `${kind} ${name} was ${outcome.status} and confirmed absent by exact-identity lookup`;
    }
  }
  if (detail === null && outcome.failure !== null) detail = outcome.failure.message;
  await journal.record({
    event: "observed",
    action: "destroy",
    kind,
    name,
    conditionId,
    status: outcome.status,
  });
  return outcomeToRecord(kind, name, outcome, detail);
}

async function verifyAbsent(
  sandbox: Sandbox,
  journal: RunJournal,
  kind: ResourceKind,
  name: string,
  conditionId: ConditionId,
  deadlineAtMs: number,
): Promise<void> {
  const presenceHandle = boundedEffect(deadlineAtMs, `verify absent ${kind} ${name}`, (cleanupSignal) => sandbox.inspectResource(kind, name, cleanupSignal));
  const presence = await presenceHandle.result;
  await journal.record({ event: "observed", action: "verify", kind, name, conditionId, status: presence });
  if (presence === "present") {
    throw new EvalError(
      "cleanup-failed",
      `${kind} ${name} from the previous condition is still present; the next condition must not start`,
      { at: name },
    );
  }
}

async function destroyConditionResources(
  sandbox: Sandbox,
  journal: RunJournal,
  state: ConditionState,
  deadlineAtMs = Number.POSITIVE_INFINITY,
): Promise<readonly CleanupRecord[]> {
  const records: CleanupRecord[] = [];
  const resourceNames: ReadonlyArray<readonly ["guest" | "network", string]> = [
    ["guest", state.step.guestName],
    ["network", state.step.networkName],
  ];
  for (const [kind, name] of resourceNames) {
    const creation = state.creationHandles[kind];
    if (creation !== undefined) {
      const remaining = Math.max(0, Math.min(5_000, deadlineAtMs - Date.now()));
      const settled = await settlesWithin(creation.settled, remaining);
      if (!settled) {
        const failure = { code: "cleanup-failed" as const, failureClass: "infrastructure" as const, message: `${kind} ${name} creation unresolved; cleanup was not attempted`, at: name };
        records.push({ kind, name, status: "failed", verified: false, detail: failure.message, failure });
        continue;
      }
    }
    records.push(await destroyExact(sandbox, journal, kind, name, state.step.conditionId, deadlineAtMs));
  }
  return records;
}

// ---------------------------------------------------------------------------
// Seal
// ---------------------------------------------------------------------------

function conditionDirFor(step: ScheduleStep): string {
  return `pairs/${step.pairId}/${step.conditionId}`;
}

/**
 * A condition is gradeable only when its outcome is a TASK outcome.
 *
 * `completed` and `task-limit` are task outcomes and may score zero. `not-started` and
 * `infrastructure-failure` carry `score: null` and are never recorded as task failures.
 */
function isGradeable(state: ConditionState): boolean {
  return state.status === "completed" || state.status === "task-limit";
}

async function sealRun(input: {
  readonly store: EvidenceStore;
  readonly options: RunOptions;
  readonly frozen: FrozenCase;
  readonly plan: RunPlan | null;
  readonly states: readonly ConditionState[];
  readonly sweep: readonly CleanupRecord[];
  readonly stopReason: string | null;
  readonly runFailures: readonly StructuredFailure[];
}): Promise<string> {
  const { store, options, frozen } = input;
  const testDouble = isTestDoubleRun(options);
  const evidenceLabel = testDouble
    ? "TEST-DOUBLE EVIDENCE — produced by deterministic doubles; this is not a measured result"
    : "measured evidence";

  const byPair = new Map<string, ConditionState[]>();
  for (const state of input.states) {
    const list = byPair.get(state.step.pairId) ?? [];
    list.push(state);
    byPair.set(state.step.pairId, list);
  }

  const pairRefs: Array<{
    pairId: string;
    repetition: number;
    path: string;
    conditions: Array<{ conditionId: ConditionId; dir: string }>;
  }> = [];

  for (const [pairId, states] of byPair) {
    const conditionRefs: Array<{ conditionId: ConditionId; dir: string }> = [];
    for (const state of states) {
      const dir = conditionDirFor(state.step);
      await sealCondition(store, dir, state, testDouble, evidenceLabel, frozen, options.guardedSecrets ?? [], options.captureReasoning);
      conditionRefs.push({ conditionId: state.step.conditionId, dir });
    }

    const baseline = states.find((state) => state.step.conditionId === "baseline");
    const treatment = states.find((state) => state.step.conditionId === "treatment");
    const pairPath = `pairs/${pairId}/pair.json`;
    // A delta is written only when computePairDelta says both arms are gradeable.
    const delta =
      baseline === undefined || treatment === undefined
        ? { gradeable: false, delta: null, reason: "the pair does not contain both conditions" }
        : computePairDelta(
            {
              conditionId: "baseline",
              gradeable: isGradeable(baseline),
              validation: baseline.validation?.outcome ?? null,
            },
            {
              conditionId: "treatment",
              gradeable: isGradeable(treatment),
              validation: treatment.validation?.outcome ?? null,
            },
          );

    await store.writeRecord(pairPath, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      pairId,
      repetition: states[0]?.step.repetition ?? 0,
      runId: options.runId,
      suiteId: frozen.suite.id,
      caseId: frozen.config.id,
      caseVersion: frozen.config.version,
      ...(frozen.rubric !== undefined ? { rubricVersion: frozen.rubric.rubricVersion } : {}),
      testDouble,
      evidenceLabel,
      conditions: conditionRefs.map((ref) => ({ conditionId: ref.conditionId, dir: ref.dir })),
      gradeable: delta.gradeable,
      delta: delta.delta,
      deltaReason: delta.reason,
    });
    pairRefs.push({
      pairId,
      repetition: states[0]?.step.repetition ?? 0,
      path: pairPath,
      conditions: conditionRefs,
    });
  }

  await store.writeRecord("cleanup.json", {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    runId: options.runId,
    sweep: input.sweep.map((record) => ({ ...record })),
  });

  const manifest = await store.sealManifest();

  // The receipt is written last, and only now that every cleanup outcome is known.
  const receipt = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    runId: options.runId,
    suiteId: frozen.suite.id,
    caseSelector: frozen.selector,
    caseId: frozen.config.id,
    caseVersion: frozen.config.version,
    ...(frozen.rubric !== undefined ? { rubricVersion: frozen.rubric.rubricVersion } : {}),
    mode: options.mode,
    status: input.stopReason === null ? "complete" : "partial",
    stopReason: input.stopReason,
    testDouble,
    evidenceLabel,
    createdAt: options.createdAt,
    finalizedAt: new Date().toISOString(),
    source: { revision: options.source.revision, dirty: options.source.dirty },
    evaluatorBuild: options.evaluatorBuild,
    planSha256: input.plan?.planSha256 ?? "",
    manifest: { treeSha256: manifest.tree.treeSha256, fileSha256: manifest.fileSha256 },
    pairs: pairRefs.map((ref) => ({
      pairId: ref.pairId,
      repetition: ref.repetition,
      path: ref.path,
      conditions: ref.conditions.map((condition) => ({
        conditionId: condition.conditionId,
        dir: condition.dir,
      })),
    })),
    cleanup: input.sweep.map((record) => ({ ...record })),
    failures: input.runFailures.map((failure) => ({ ...failure })),
  };
  const sealed = await store.sealReceipt(receipt);

  // Regenerable, outside the hash chain, never authoritative.
  await store.writeView(
    "summary.txt",
    [
      `run ${options.runId}`,
      `suite ${frozen.suite.id}  case ${frozen.selector}`,
      `mode ${options.mode}  status ${receipt.status}`,
      evidenceLabel,
      "",
      "This file is regenerable and is deliberately excluded from manifest.json.",
      "",
    ].join("\n"),
  );

  return sealed.path;
}

async function sealCondition(
  store: EvidenceStore,
  dir: string,
  state: ConditionState,
  testDouble: boolean,
  evidenceLabel: string,
  frozen: FrozenCase,
  guardedSecrets: readonly GuardedSecret[],
  captureReasoning?: boolean,
): Promise<void> {
  const gradeable = isGradeable(state);
  await store.writeRecord(`${dir}/condition.json`, {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    conditionId: state.step.conditionId,
    order: state.step.order,
    repetition: state.step.repetition,
    pairId: state.step.pairId,
    status: state.status,
    notStartedReason: state.notStartedReason,
    failureClass: state.status === "not-started" || state.status === "infrastructure-failure"
      ? "infrastructure"
      : "task",
    gradeable,
    skillPaths: [...state.plan.skillPaths],
    imageDigest: state.imageDigest,
    guestName: state.step.guestName,
    networkName: state.step.networkName,
    parity: state.plan.parity,
    runtime: state.runtime === null ? null : { ...state.runtime, allowedTools: [...state.runtime.allowedTools], skillPaths: [...state.runtime.skillPaths] },
    timing: state.timing === null ? null : { ...state.timing },
    usage: state.usage === null ? null : { ...state.usage },
    // Structured stop cause plus preserved provider raw stop reason. A never-started or
    // pre-execution arm records null for both; readers treat null as unavailable.
    stopCause: state.stopCause,
    providerStopReason: state.providerStopReason,
    redactions: {
      count: state.redactions.count,
      locations: [...new Set(state.redactions.entries.map((e) => e.path))].sort(),
    },
    cleanup: state.cleanup.map((record) => ({ ...record })),
    testDouble,
    evidenceLabel,
  });
  await sealAttestation(store, dir, state, testDouble, evidenceLabel);

  // Native session retention: state.sessionEntries is the durable prefix when the arm's
  // native session recorder captured at least one entry (the common Pi-harness case), but
  // falls back to whatever the Harness implementation itself reported otherwise (e.g. a
  // scripted or fake harness that never calls the recorder). The Harness interface is
  // implemented by more than the Pi adapter, so this redaction pass is not defense in
  // depth over already-trusted data - it is the actual, only sanitization point for those
  // other implementations. Independently re-verify and rescan even when a positive
  // redaction count was already supplied: a hostile or mismatched final carrier cannot
  // be hidden by an authentic-looking prefix.
  if (state.nativePromotionFailure) throw state.nativePromotionFailure;
  const completed = state.status === "completed";
  const rawEntries = state.sessionEntries;
  const hasNativeEntries = rawEntries.length > 0;
  let sanitizedEntries = rawEntries;
  let sessionRedactions = state.sessionRedactions ?? { count: 0, entries: [] };
  if (hasNativeEntries && guardedSecrets.length > 0) {
    const res = sanitizeNativeSessionEntries(rawEntries, guardedSecrets, { captureReasoning });
    sanitizedEntries = res.entries;
    if (sessionRedactions.count === 0) {
      if (res.count > 0) {
        sessionRedactions = { count: res.count, entries: res.redactions };
      }
    } else if (res.count > 0) {
      // Independent rescan and existing provenance must not double count
      const existingPaths = new Set(sessionRedactions.entries.map((e) => e.path));
      const novel = res.redactions.filter((e) => !existingPaths.has(e.path));
      if (novel.length > 0) {
        sessionRedactions = {
          count: sessionRedactions.count + novel.reduce((sum, e) => sum + e.count, 0),
          entries: [...sessionRedactions.entries, ...novel],
        };
      }
    }
  }

  const tailStatus = !hasNativeEntries
    ? "unavailable"
    : state.status === "completed"
    ? "completed"
    : state.status === "not-started"
    ? "not-started"
    : state.status === "task-limit"
    ? "truncated"
    : "interrupted";
  const incompleteTail = !hasNativeEntries ? false : !completed;
  const incompleteReason = !hasNativeEntries
    ? "native session entries unavailable for this condition"
    : state.notStartedReason ?? (completed ? null : `condition ended with status ${state.status}`);

  await store.writeRecord(`${dir}/session.json`, {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    conditionId: state.step.conditionId,
    available: hasNativeEntries,
    completed,
    tailStatus,
    incompleteTail,
    incompleteReason,
    ...(captureReasoning !== undefined ? { reasoningCaptured: captureReasoning } : {}),
    entries: sanitizedEntries,
    entryCount: sanitizedEntries.length,
    redactions: {
      count: hasNativeEntries ? sessionRedactions.count : 0,
      locations: hasNativeEntries
        ? [...new Set(sessionRedactions.entries.map((e) => e.path))].sort()
        : [],
    },
  });

  // Note: duplicate canonical transcript formats (messages.json and tool-steps.json)
  // are removed. Message and tool views are derived from session.json by readers.

  await store.writeRecord(`${dir}/redactions.json`, {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    conditionId: state.step.conditionId,
    count: state.redactions.count,
    entries: state.redactions.entries.map((entry) => ({
      path: entry.path,
      label: entry.label,
      encoding: entry.encoding,
      count: entry.count,
    })),
  });

  // The RAW bounded exported workspace, kept separate from the projected candidate.
  await store.writeRecord(`${dir}/workspace.json`, {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    conditionId: state.step.conditionId,
    root: EVAL_WORKSPACE_ROOT,
    exported: state.exported !== null,
    truncated: state.exported?.truncated ?? false,
    skipped: [...(state.exported?.skipped ?? [])],
    files: (state.exported?.files ?? []).map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      base64: file.base64,
    })),
  });

  // The projected candidate the validator ACTUALLY scored.
  // Graded projection references workspace bytes where possible instead of duplicating base64.
  const workspaceFilesMap = new Map((state.exported?.files ?? []).map((f) => [f.path, f]));
  const candidateFiles = Object.entries(state.candidate?.candidateFiles ?? {})
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([path, base64]) => {
      const bytes = Buffer.from(base64, "base64");
      const sha256 = sha256Hex(bytes);
      const inWorkspace = workspaceFilesMap.has(path);
      return {
        path,
        bytes: bytes.byteLength,
        sha256,
        present: true,
        workspaceRef: inWorkspace ? path : null,
        base64: inWorkspace ? null : base64,
      };
    });

  // Record explicit missing candidate omission — never backfill with fixture bytes!
  const outputPath = frozen.config.outputPath;
  if (
    frozen.config.candidateMode === "file" &&
    candidateFiles.length === 0 &&
    state.exported !== null
  ) {
    candidateFiles.push({
      path: outputPath,
      bytes: 0,
      sha256: "",
      present: false,
      workspaceRef: null,
      base64: null,
    });
  }

  await store.writeRecord(`${dir}/candidate.json`, {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    conditionId: state.step.conditionId,
    candidateMode: frozen.config.candidateMode,
    outputPath: frozen.config.outputPath,
    projected: state.candidate !== null,
    includedPaths: [...(state.candidate?.includedPaths ?? [])],
    skipped: (state.candidate?.skipped ?? []).map((entry) => ({ path: entry.path, reason: entry.reason })),
    files: candidateFiles,
  });

  await store.writeRecord(`${dir}/validation.json`, {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    conditionId: state.step.conditionId,
    gradeable,
    runnerId: state.validation?.runnerId ?? null,
    runnerTestDouble: state.validation?.testDouble ?? null,
    durationMs: state.validation?.durationMs ?? null,
    // An ungradeable condition never carries a task score.
    outcome:
      state.validation === null || !gradeable
        ? null
        : {
            status: state.validation.outcome.status,
            score: state.validation.outcome.score,
            fullPass: state.validation.outcome.fullPass,
            checks: state.validation.outcome.checks.map((check) => ({ ...check })),
            ...((state.validation.outcome as any).rubricScore !== undefined
              ? { rubricScore: (state.validation.outcome as any).rubricScore }
              : {}),
          },
    failure: state.validation?.failure ?? null,
  });
  await store.writeRecord(`${dir}/errors.json`, {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    conditionId: state.step.conditionId,
    failures: state.failures.map((failure) => ({ ...failure })),
  });
}

/**
 * Seals what the guest was OBSERVED to be, as its own artifact.
 *
 * Why it is separate from `inputs/policy.json`: that file records the DECLARED intent for
 * the whole run and is hashed into the parity binding. This one records what one
 * condition's guest actually reported — real uid/gid, cleared groups, CapEff, NoNewPrivs,
 * an attempted write to `/`, the mount table, the resolvers in effect, and each egress
 * probe with its target, expectation, outcome, and timing. Keeping them apart is the
 * whole point: a reader must be able to compare intent against observation, which is
 * impossible once they are merged.
 *
 * A condition that never started has no observation. That is recorded affirmatively,
 * because an empty object or an absent file is indistinguishable from an observation that
 * was made and then lost.
 */
async function sealAttestation(
  store: EvidenceStore,
  dir: string,
  state: ConditionState,
  testDouble: boolean,
  evidenceLabel: string,
): Promise<void> {
  const observed = state.attestation;
  await store.writeRecord(`${dir}/attestation.json`, {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    conditionId: state.step.conditionId,
    guestName: state.step.guestName,
    networkName: state.step.networkName,
    attested: observed !== null,
    notAttestedReason:
      observed !== null
        ? null
        : `${state.step.conditionId} was not attested because the condition never started (status ${state.status}): ${state.notStartedReason ?? "no guest was ever created"}`,
    // The gate decision the runner acted on, kept next to the raw observation it came from.
    summary:
      observed === null
        ? null
        : {
            uid: observed.uid,
            gid: observed.gid,
            noNewPrivileges: observed.noNewPrivileges,
            capabilitiesDropped: observed.capabilitiesDropped,
            readOnlyRoot: observed.readOnlyRoot,
            hostMounts: [...observed.hostMounts],
            egress: { ...observed.egress },
            checkedAt: observed.checkedAt,
          },
    // The real values, verbatim. Never a boolean summary of them.
    observed:
      observed === null
        ? null
        : {
            ...observed.observed,
            init: { ...observed.observed.init, groups: [...observed.observed.init.groups] },
            self: { ...observed.observed.self, groups: [...observed.observed.self.groups] },
            readOnlyRootProbe: { ...observed.observed.readOnlyRootProbe },
            declaredWritablePaths: [...observed.observed.declaredWritablePaths],
            hostBackedMounts: observed.observed.hostBackedMounts.map((mount) => ({ ...mount })),
            unexpectedWritableMounts: observed.observed.unexpectedWritableMounts.map((mount) => ({ ...mount })),
            resolvers: observed.observed.resolvers.map((resolver) => ({ ...resolver })),
            allowedTcpPorts:
              observed.observed.allowedTcpPorts === "all" ? "all" : [...observed.observed.allowedTcpPorts],
            egressProbes: observed.observed.egressProbes.map((probe) => ({ ...probe })),
            dnsProbe: { ...observed.observed.dnsProbe },
          },
    // The declared policy this observation is to be compared against. A hash, not a copy:
    // `inputs/policy.json` stays the single sealed home of the declared intent.
    declaredPolicySha256: {
      network: canonicalJsonSha256(EVAL_NETWORK_POLICY),
      guest: canonicalJsonSha256(EVAL_GUEST_POLICY),
    },
    declaredPolicyPath: "inputs/policy.json",
    testDouble,
    evidenceLabel,
  });
}
