/**
 * Pure contracts for the skill evaluation subsystem.
 *
 * This module owns identifiers, schemas, limits, and structured errors. It must stay
 * free of filesystem, process, container, provider, harness, and suite-specific
 * concerns (see docs/ARCHITECTURE.md sections 1-2).
 */

export const INPUT_SCHEMA_VERSION = 1;
/**
 * Sealed-evidence schema version.
 *
 * v2 is an ADDITIVE evolution of v1: it introduces optional per-condition fields
 * (`stopCause`, `providerStopReason`) alongside the pre-existing usage counters. The
 * compatibility contract is deliberately one-directional and non-reinterpreting:
 *
 * - Historical v1 evidence sealed before these fields existed simply omits them. Readers
 *   MUST treat an absent/invalid `stopCause` as `unknown` and an absent/non-string
 *   `providerStopReason` as `null`. No default cause is fabricated, and a finite output
 *   limit recorded in an older plan is never retro-reinterpreted as a stop cause.
 * - The hash chain (receipt -> manifest -> pair -> condition) is unchanged, so v1 runs
 *   keep verifying byte-for-byte; only the read model gained new nullable columns.
 * - `providerStopReason` persists the RAW provider reason (e.g. MAX_TOKENS/STOP), which is
 *   independent of the normalized `stopReason`/`stopCause` used for classification.
 *
 * Because every new field is optional and defaulted to an explicitly "unavailable" value,
 * bumping to v2 required no migration and cannot silently upgrade the meaning of old data.
 */
export const EVIDENCE_SCHEMA_VERSION = 2;
export const SCHEMA_VERSION = INPUT_SCHEMA_VERSION;

/** The public condition vocabulary is exactly these two arms, in this order. */
export const CONDITION_IDS = ["baseline", "treatment"] as const;
export type ConditionId = (typeof CONDITION_IDS)[number];

export const PROVIDER_IDS = ["anthropic", "google", "openai"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** One declared credential variable per allowlisted direct provider. */
export const PROVIDER_CREDENTIAL_VARIABLES: Readonly<Record<ProviderId, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * Thinking levels the harness runtime accepts. Mirrors Pi's own set so a level we freeze
 * can always be requested verbatim; `minimal` and `max` exist there and were missing here.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const RUNTIME_PROFILE_IDS = ["default"] as const;
export type RuntimeProfileId = string;

/**
 * How much of the exported workspace is handed to the validator.
 *
 * - `workspace` grades every eligible exported file, bounded by per-file and aggregate
 *   byte budgets so a guest cannot enlarge the graded surface without limit. This is
 *   the collection contract of every NEW evaluation run, for every case.
 * - `file` grades exactly the requested output path. It is retained only to read and
 *   inspect historical evidence sealed before workspace collection became universal;
 *   a fresh case source may no longer request it.
 */
export const CANDIDATE_MODES = ["file", "workspace"] as const;
export type CandidateMode = (typeof CANDIDATE_MODES)[number];

/** Collection policy every fresh evaluation run resolves to, with no authored field. */
export const FRESH_RUN_CANDIDATE_MODE: CandidateMode = "workspace";

/**
 * In workspace mode, outputPath may use this marker when the task deliverable is the
 * whole project rather than a single primary file. This is a logical selection, not a file.
 */
export const WORKSPACE_OUTPUT_MARKER = "__workspace__";

/** Execution modes. `measured` forbids every test double; `fake` self-labels evidence. */
export const RUN_MODES = ["measured", "fake"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const LIMIT_KEYS = [
  "wallClockMs",
  "maxOutputTokens",
  "maxToolSteps",
  "maxProviderRequests",
  "maxExportedFiles",
  "maxExportedFileBytes",
  "maxWorkspaceBytes",
  "cpus",
  "memoryMiB",
  "pids",
  "diskMiB",
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

/**
 * The four TASK budgets bound a single arm's own execution. Each accepts a positive
 * safe integer (a finite cumulative cap) or `null`, which means UNLIMITED: no
 * harness-imposed cumulative cap for that dimension is enforced anywhere. Every other
 * limit key names a RESOURCE or isolation bound and is always a positive integer that
 * can never be disabled.
 *
 * `wallClockMs`         - per-arm prompt deadline in ms.
 * `maxOutputTokens`     - cumulative output tokens across the arm's provider responses.
 * `maxToolSteps`        - cumulative tool invocations for the arm.
 * `maxProviderRequests` - cumulative provider requests for the arm.
 */
export const TASK_LIMIT_KEYS = [
  "wallClockMs",
  "maxOutputTokens",
  "maxToolSteps",
  "maxProviderRequests",
] as const satisfies readonly LimitKey[];
export type TaskLimitKey = (typeof TASK_LIMIT_KEYS)[number];

const TASK_LIMIT_KEY_SET: ReadonlySet<string> = new Set<string>(TASK_LIMIT_KEYS);

/** @notice Distinguishes nullable task budgets from mandatory resource bounds. */
export function isTaskLimitKey(key: string): key is TaskLimitKey {
  return TASK_LIMIT_KEY_SET.has(key);
}

/**
 * A task budget is a positive integer (a finite cumulative cap) or `null` (UNLIMITED).
 * Unlimited is represented explicitly as `null` and must never be smuggled as a huge
 * finite number or `Infinity`, because a finite value silently caps a legitimately
 * unlimited arm. Resource/isolation budgets are always positive integers.
 */
export type TaskLimit = number | null;
/** @deprecated Use {@link TaskLimit}; retained for import compatibility. */
export type WallClockLimit = TaskLimit;
export type Limits = Readonly<{ [K in LimitKey]: K extends TaskLimitKey ? TaskLimit : number }>;
export type PartialLimits = Readonly<Partial<{ [K in LimitKey]: K extends TaskLimitKey ? TaskLimit : number }>>;

/** Existing five-minute operation bound, also used to reserve non-prompt work. */
export const CONDITION_OPERATION_ALLOWANCE_MS = 300_000;
/** Existing bounded resource cleanup allowance, separate from prompt execution. */
export const CONDITION_CLEANUP_ALLOWANCE_MS = 20_000;

/**
 * Lowest-precedence values. The four TASK budgets default to `null` (UNLIMITED): a
 * fresh standard run imposes no harness cumulative wall-clock, output-token, tool-step,
 * or provider-request cap. A finite cap is only ever an explicit opt-in through CLI,
 * case, suite, or profile configuration. Every RESOURCE/isolation budget defaults to a
 * positive integer that can never be disabled.
 */
export const SAFE_DEFAULT_LIMITS: Limits = {
  // Unlimited by default; an explicit finite value starts at each condition's prompt.
  wallClockMs: null,
  maxOutputTokens: null,
  maxToolSteps: null,
  maxProviderRequests: null,
  maxExportedFiles: 64,
  maxExportedFileBytes: 262_144,
  maxWorkspaceBytes: 2_097_152,
  cpus: 2,
  memoryMiB: 2_048,
  pids: 256,
  diskMiB: 2_048,
};

/**
 * @notice Derives nested guest and host lifetimes without consuming either arm's prompt allowance.
 * @param wallClockMs Per-arm prompt allowance, or `null` for an unlimited arm.
 * @returns Readiness, supervisor, and host-stream timeouts in milliseconds, or `null` fields when the arm is unlimited.
 * @dev Serial execution reserves sibling setup, execution, capture, and cleanup; the host closes last. Unlimited execution relies on cancellation and separate bounded infrastructure operations, with no guest-lifetime cap.
 */
export function resolveGuestTimeouts(wallClockMs: WallClockLimit): {
  readonly prePromptMs: number | null;
  readonly supervisorMs: number | null;
  readonly streamMs: number | null;
} {
  if (wallClockMs === null) {
    return { prePromptMs: null, supervisorMs: null, streamMs: null };
  }
  if (!Number.isSafeInteger(wallClockMs) || wallClockMs <= 0) {
    throw new EvalError("limit-invalid", "wallClockMs must be a positive integer or null (unlimited)", { at: "limits.wallClockMs" });
  }
  const prePromptMs = 2 * CONDITION_OPERATION_ALLOWANCE_MS + wallClockMs + CONDITION_CLEANUP_ALLOWANCE_MS;
  const lifetimeMs = CONDITION_OPERATION_ALLOWANCE_MS + prePromptMs + Math.max(wallClockMs, 180_000);
  return { prePromptMs, supervisorMs: lifetimeMs + 10_000, streamMs: lifetimeMs + 30_000 };
}

export interface RuntimeProfile {
  readonly id: RuntimeProfileId;
  readonly description: string;
  readonly limits: PartialLimits;
}

/**
 * Allowlisted runtime profiles. A profile identifier maps through
 * container/image-lock.json to a pinned base identity; that lock file is added
 * with the container sandbox implementation and is not required to resolve a profile.
 */
export const RUNTIME_PROFILES: Readonly<Record<RuntimeProfileId, RuntimeProfile>> = {
  default: {
    id: "default",
    description: "Common harness runtime with no language toolchain beyond the runtime itself.",
    limits: {},
  },
};

export const LIMIT_SOURCES = ["cli", "case", "suite", "profile", "default"] as const;
export type LimitSource = (typeof LIMIT_SOURCES)[number];

// ---------------------------------------------------------------------------
// Structured stop causes
// ---------------------------------------------------------------------------

/**
 * The precise reason an arm stopped, distinct from the coarse outcome vocabulary. This
 * disambiguates a harness-imposed cumulative-budget exhaustion from a provider-native
 * response truncation without redefining the historical `completed`/`task-limit`/
 * `infrastructure-failure` outcome set.
 *
 * - `completed`                 - the arm finished on its own.
 * - `wall-clock`                - a finite per-arm wall-clock budget elapsed.
 * - `cumulative-output-tokens`  - a finite cumulative output-token budget was exhausted.
 * - `tool-steps`                - a finite cumulative tool-step budget was exhausted.
 * - `provider-requests`         - a finite cumulative provider-request budget was exhausted.
 * - `provider-response-length`  - the PROVIDER natively truncated a response (its own
 *                                 per-response/context limit), NOT a harness cumulative
 *                                 cap. An unlimited arm can only ever report this, never
 *                                 a cumulative-* cause.
 * - `external-cancellation`     - the run or a user cancelled the arm.
 * - `infrastructure-error`      - an infrastructure/provider/protocol failure.
 * - `unexpected-abort`          - an abort with no attributable cause.
 * - `unknown`                   - unavailable in historical evidence, or unclassifiable.
 */
export const STOP_CAUSES = [
  "completed",
  "wall-clock",
  "cumulative-output-tokens",
  "tool-steps",
  "provider-requests",
  "provider-response-length",
  "external-cancellation",
  "infrastructure-error",
  "unexpected-abort",
  "unknown",
] as const;
export type StopCause = (typeof STOP_CAUSES)[number];

/** Coarse execution outcome returned by every harness implementation. */
export type HarnessOutcome = "completed" | "task-limit" | "infrastructure-failure";

/** The terminal classes the harness computes before mapping to an outcome/stop cause. */
export type TerminalClass =
  | "completed"
  | "task-limit"
  | "interrupted"
  | "execution-failure"
  | "unexpected-abort";

/**
 * @notice Derives a precise, machine-readable stop cause from terminal signals.
 * @dev Pure and side-effect free so both the in-guest agent and the host adapter classify
 * identically. A finite cumulative budget names itself through `taskLimitReason`; a
 * provider-native `length` truncation with NO harness reason is reported distinctly and is
 * never relabeled as cumulative output-token exhaustion.
 */
export function deriveStopCause(input: {
  readonly terminalClass: TerminalClass;
  readonly semanticAbortCause: "external" | "arm-budget" | null;
  readonly taskLimitReason: string | null;
  readonly stopReason: string | null;
}): StopCause {
  switch (input.terminalClass) {
    case "completed":
      return "completed";
    case "interrupted":
      return "external-cancellation";
    case "execution-failure":
      return "infrastructure-error";
    case "unexpected-abort":
      return "unexpected-abort";
    case "task-limit": {
      const reason = input.taskLimitReason;
      if (reason !== null) {
        if (reason.includes("output token")) return "cumulative-output-tokens";
        if (reason.includes("tool steps")) return "tool-steps";
        if (reason.includes("provider requests")) return "provider-requests";
        if (reason.includes("wall-clock")) return "wall-clock";
      }
      // A harness-initiated arm wall-clock abort carries no cumulative reason string.
      if (input.semanticAbortCause === "arm-budget") return "wall-clock";
      // Provider-native truncation with no harness cap: report it as its own cause.
      if (input.stopReason === "length") return "provider-response-length";
      return "unknown";
    }
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Readiness probes
// ---------------------------------------------------------------------------

/**
 * Shared readiness vocabulary. Harnesses and sandboxes are peers: both report
 * readiness in the same shape, so the shape lives in core rather than in one of them
 * importing the other (which would make the two peer modules circular).
 */
export const PROBE_STATUSES = ["ok", "missing", "unsupported"] as const;
export type ProbeStatus = (typeof PROBE_STATUSES)[number];

export interface ProbeDetail {
  readonly name: string;
  readonly status: ProbeStatus;
  readonly detail: string;
}

/** A readiness report. `ready` is false whenever any required detail is not `ok`. */
export interface ProbeReport {
  readonly ready: boolean;
  readonly details: readonly ProbeDetail[];
}

// ---------------------------------------------------------------------------
// Structured errors
// ---------------------------------------------------------------------------

export type FailureClass = "task" | "infrastructure";

export const EVAL_ERROR_CODES = [
  "input-invalid",
  "path-unsafe",
  "limit-invalid",
  "selector-ambiguous",
  "parity-violation",
  "not-implemented",
  "platform-unsupported",
  "credential-missing",
  "protocol-drift",
  "provider-error",
  "evidence-invalid",
  "cleanup-failed",
  "secret-quarantine",
  "validator-infrastructure",
  "interrupted",
] as const;
export type EvalErrorCode = (typeof EVAL_ERROR_CODES)[number];

export interface StructuredFailure {
  readonly code: EvalErrorCode;
  readonly failureClass: FailureClass;
  readonly message: string;
  readonly at: string | null;
}

/** The only error type crossing module boundaries inside the subsystem. */
export class EvalError extends Error {
  readonly code: EvalErrorCode;
  readonly failureClass: FailureClass;
  readonly at: string | null;

  constructor(code: EvalErrorCode, message: string, options: { at?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "EvalError";
    this.code = code;
    // An EvalError is never a task outcome. Input problems abort before dispatch, and
    // everything else that escapes as an EvalError is an infrastructure outcome.
    this.failureClass = "infrastructure";
    this.at = options.at ?? null;
  }

  toStructured(): StructuredFailure {
    return { code: this.code, failureClass: this.failureClass, message: this.message, at: this.at };
  }
}

/**
 * Cooperative cancellation check.
 *
 * Every long-running operation accepts an optional AbortSignal and must call this on
 * entry and at each iteration of any walk, so a wall-clock deadline or a signal stops
 * work promptly and surfaces as an `interrupted` infrastructure outcome rather than an
 * abandoned promise that leaks a guest.
 */
export function assertNotAborted(signal: AbortSignal | undefined, at: string): void {
  if (signal?.aborted === true) {
    throw new EvalError("interrupted", `${at} was aborted`, { at });
  }
}

export function toStructuredFailure(error: unknown, fallbackCode: EvalErrorCode): StructuredFailure {
  if (error instanceof EvalError) return error.toStructured();
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { code: fallbackCode, failureClass: "infrastructure", message: message.slice(0, 2_000), at: null };
}

// ---------------------------------------------------------------------------
// Suite and case schemas
// ---------------------------------------------------------------------------

export interface SuiteConfig {
  readonly schemaVersion: number;
  readonly id: string;
  readonly skillPath: string;
  readonly runtimeProfileId: RuntimeProfileId;
  readonly limits: PartialLimits;
}

export interface CaseConfig {
  readonly id: string;
  readonly version: number;
  readonly prompt: string;
  readonly outputPath: string;
  readonly allowedTools: readonly string[];
  readonly validator: string;
  readonly runtimeProfileId: RuntimeProfileId | null;
  readonly limits: PartialLimits;
  readonly fixtureDir: string;
  readonly oracle: string;
  readonly candidateMode: CandidateMode;
}

// ---------------------------------------------------------------------------
// Trusted preparation contract (at most one function at the run boundary)
// ---------------------------------------------------------------------------

export interface PreparedFixtureFile {
  readonly path: string;
  readonly content: string | Uint8Array;
}

export interface PreparedCaseData {
  readonly fixtureFiles?: readonly PreparedFixtureFile[];
  readonly oracle?: unknown;
  readonly provenance?: Readonly<Record<string, string>>;
}

export type CasePreparer = (context: {
  readonly suiteId: string;
  readonly caseSelector: string;
  /** Composes caller cancellation and the deadline; trusted work must cooperate to stop. */
  readonly signal: AbortSignal;
  /** Absolute epoch deadline anchored to invocation, including elapsed preflight time. */
  readonly deadlineAtMs: number;
}) => Promise<PreparedCaseData>;

// ---------------------------------------------------------------------------
// Native session evidence record
// ---------------------------------------------------------------------------

export interface NativeSessionRecord {
  readonly schemaVersion: number;
  readonly conditionId: ConditionId;
  readonly available: boolean;
  readonly completed: boolean;
  readonly tailStatus: string;
  readonly incompleteTail: boolean;
  readonly incompleteReason: string | null;
  readonly reasoningCaptured?: boolean;
  readonly entries: readonly unknown[];
  readonly entryCount: number;
  readonly redactions: {
    readonly count: number;
    readonly locations: readonly string[];
  };
}

// ---------------------------------------------------------------------------
// Validator contract (owner-authored case validators implement this)
// ---------------------------------------------------------------------------

export interface ValidationCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly message: string;
}

export interface ValidationOutcome {
  readonly status: "graded" | "infrastructure-failure";
  readonly score: number | null;
  readonly fullPass: boolean | null;
  readonly checks: readonly ValidationCheck[];
}

export interface SnapshotValidationInput {
  readonly outputPath: string;
  readonly fixtureFiles: Readonly<Record<string, string>>;
  readonly candidateFiles: Readonly<Record<string, string>>;
  readonly oracle: unknown;
}

export interface CaseValidatorModule {
  validateSnapshot(input: SnapshotValidationInput): ValidationOutcome;
}

// ---------------------------------------------------------------------------
// Strict decoding helpers
// ---------------------------------------------------------------------------

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireRecord(value: unknown, at: string): JsonRecord {
  if (!isRecord(value)) throw new EvalError("input-invalid", `${at} must be a JSON object`, { at });
  return value;
}

/** Rejects unknown and missing keys so every boundary fails closed. */
export function requireKeys(
  value: unknown,
  spec: { required: readonly string[]; optional?: readonly string[] },
  at: string,
): JsonRecord {
  const record = requireRecord(value, at);
  const optional = spec.optional ?? [];
  const known = new Set<string>([...spec.required, ...optional]);
  const unknownKeys = Object.keys(record).filter((key) => !known.has(key)).sort();
  if (unknownKeys.length > 0) {
    throw new EvalError("input-invalid", `${at} has unknown field(s): ${unknownKeys.join(", ")}`, { at });
  }
  const missing = spec.required.filter((key) => record[key] === undefined).sort();
  if (missing.length > 0) {
    throw new EvalError("input-invalid", `${at} is missing required field(s): ${missing.join(", ")}`, { at });
  }
  return record;
}

export function requireString(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EvalError("input-invalid", `${at} must be a non-empty string`, { at });
  }
  return value;
}

export function requirePositiveInteger(value: unknown, at: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new EvalError("input-invalid", `${at} must be a positive safe integer`, { at });
  }
  return value as number;
}

export function requireUniqueStringArray(value: unknown, at: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new EvalError("input-invalid", `${at} must be a non-empty array`, { at });
  }
  const entries = value.map((entry, index) => requireString(entry, `${at}[${index}]`));
  if (new Set(entries).size !== entries.length) {
    throw new EvalError("input-invalid", `${at} contains duplicate entries`, { at });
  }
  return entries;
}

export function requireEnum<T extends string>(value: unknown, allowed: readonly T[], at: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new EvalError("input-invalid", `${at} must be one of: ${allowed.join(", ")}`, { at });
  }
  return value as T;
}

/**
 * @notice Validates limit overrides and normalizes unlimited task budgets.
 * @param value Untrusted partial configuration; omitted values inherit.
 * @param at Configuration path used in validation errors.
 * @returns Typed overrides with unlimited task budgets represented as null.
 */
export function decodePartialLimits(value: unknown, at: string): PartialLimits {
  if (value === undefined) return {};
  const record = requireKeys(value, { required: [], optional: LIMIT_KEYS }, at);
  const limits: Partial<Record<LimitKey, number | null>> = {};
  for (const key of LIMIT_KEYS) {
    if (record[key] === undefined) continue;
    const raw = record[key];
    if (isTaskLimitKey(key)) {
      // `0` or `null` mean UNLIMITED: no harness cumulative cap for this task dimension.
      // Any other value must be a positive safe integer. Unlimited is stored explicitly
      // as `null`; a huge sentinel or `Infinity` is never accepted.
      if (raw === null || raw === 0) {
        limits[key] = null;
        continue;
      }
      if (!Number.isSafeInteger(raw) || (raw as number) < 0) {
        throw new EvalError("limit-invalid", `${at}.${key} must be a positive integer, 0, or null (unlimited)`, { at: `${at}.${key}` });
      }
      limits[key] = raw as number;
      continue;
    }
    // Resource/isolation bounds can never be disabled: null/0 are rejected here.
    if (!Number.isSafeInteger(raw) || (raw as number) <= 0) {
      throw new EvalError("limit-invalid", `${at}.${key} must be a positive safe integer`, { at: `${at}.${key}` });
    }
    limits[key] = raw as number;
  }
  return limits as PartialLimits;
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

export interface DecodeConfigOptions {
  readonly allowedProfileIds?: readonly string[];
  readonly profileCatalog?: Readonly<Record<string, unknown>>;
}

export function decodeSuiteConfig(value: unknown, at: string, options?: DecodeConfigOptions): SuiteConfig {
  const record = requireKeys(
    value,
    { required: ["schemaVersion", "id", "skillPath"], optional: ["runtimeProfileId", "limits"] },
    at,
  );
  const schemaVersion = requirePositiveInteger(record.schemaVersion, `${at}.schemaVersion`);
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new EvalError("input-invalid", `${at}.schemaVersion must be ${SCHEMA_VERSION}`, { at: `${at}.schemaVersion` });
  }
  const allowedProfiles =
    options?.allowedProfileIds ??
    (options?.profileCatalog !== undefined ? Object.keys(options.profileCatalog) : RUNTIME_PROFILE_IDS);
  return {
    schemaVersion,
    id: requireString(record.id, `${at}.id`),
    skillPath: requireString(record.skillPath, `${at}.skillPath`),
    runtimeProfileId: record.runtimeProfileId === undefined || record.runtimeProfileId === null
      ? "default"
      : requireEnum(record.runtimeProfileId, allowedProfiles, `${at}.runtimeProfileId`),
    limits: decodePartialLimits(record.limits, `${at}.limits`),
  };
}

/** Resolves bounded workspace collection for a fresh authored case. */
function resolveCandidateMode(raw: unknown, at: string): CandidateMode {
  const authored = raw === undefined ? null : requireEnum(raw, CANDIDATE_MODES, `${at}.candidateMode`);
  if (authored === "file") {
    throw new EvalError(
      "input-invalid",
      `${at}.candidateMode: "file" is obsolete for a new run. Every fresh evaluation grades the bounded final workspace, so remove the candidateMode field from this configuration. Historical receipts keep their recorded mode for inspection.`,
      { at: `${at}.candidateMode` },
    );
  }
  // An explicit `workspace` stays accepted for compatibility: it already agrees.
  return authored ?? FRESH_RUN_CANDIDATE_MODE;
}

/**
 * @notice Validates a newly authored case with workspace-wide output collection.
 * @param value Untrusted case configuration.
 * @param at Configuration path used in validation errors.
 * @param options Allowed runtime profiles for this configuration.
 * @returns A validated case for a fresh run, not historical evidence.
 */
export function decodeFreshCaseConfig(
  value: unknown,
  at: string,
  options?: DecodeConfigOptions,
): CaseConfig {
  const record = requireKeys(
    value,
    {
      required: ["id", "version", "prompt", "outputPath", "allowedTools", "validator"],
      optional: ["runtimeProfileId", "limits", "fixtureDir", "oracle", "candidateMode"],
    },
    at,
  );
  const allowedTools = requireUniqueStringArray(record.allowedTools, `${at}.allowedTools`);
  for (const [index, tool] of allowedTools.entries()) {
    if (!TOOL_NAME_PATTERN.test(tool)) {
      throw new EvalError("input-invalid", `${at}.allowedTools[${index}] is not a valid tool name`, { at });
    }
    if (tool === "glob") {
      throw new EvalError(
        "input-invalid",
        `${at}.allowedTools: "glob" is no longer provided; use "find" (Pi native)`,
        { at: `${at}.allowedTools` },
      );
    }
  }
  const candidateMode = resolveCandidateMode(record.candidateMode, at);
  const outputPath = requireString(record.outputPath, `${at}.outputPath`);
  const allowedProfiles =
    options?.allowedProfileIds ??
    (options?.profileCatalog !== undefined ? Object.keys(options.profileCatalog) : RUNTIME_PROFILE_IDS);
  return {
    id: requireString(record.id, `${at}.id`),
    version: requirePositiveInteger(record.version, `${at}.version`),
    prompt: requireString(record.prompt, `${at}.prompt`),
    outputPath,
    allowedTools,
    validator: requireString(record.validator, `${at}.validator`),
    runtimeProfileId: record.runtimeProfileId === undefined || record.runtimeProfileId === null
      ? null
      : requireEnum(record.runtimeProfileId, allowedProfiles, `${at}.runtimeProfileId`),
    limits: decodePartialLimits(record.limits, `${at}.limits`),
    fixtureDir: record.fixtureDir === undefined ? "fixture" : requireString(record.fixtureDir, `${at}.fixtureDir`),
    oracle: record.oracle === undefined ? "oracle.json" : requireString(record.oracle, `${at}.oracle`),
    candidateMode,
  };
}

/**
 * Fails closed on validator output drift. A validator that returns an unexpected shape
 * is a validator-infrastructure failure, never a task score.
 */
export function decodeValidationOutcome(value: unknown, at: string): ValidationOutcome {
  const record = requireKeys(value, { required: ["status", "score", "fullPass", "checks"] }, at);
  const status = requireEnum(record.status, ["graded", "infrastructure-failure"] as const, `${at}.status`);
  if (!Array.isArray(record.checks) || record.checks.length === 0) {
    throw new EvalError("protocol-drift", `${at}.checks must be a non-empty array`, { at: `${at}.checks` });
  }
  const checks = record.checks.map((entry, index) => {
    const check = requireKeys(entry, { required: ["id", "passed", "message"] }, `${at}.checks[${index}]`);
    if (typeof check.passed !== "boolean") {
      throw new EvalError("protocol-drift", `${at}.checks[${index}].passed must be a boolean`, { at });
    }
    return {
      id: requireString(check.id, `${at}.checks[${index}].id`),
      passed: check.passed,
      message: typeof check.message === "string" ? check.message : "",
    };
  });
  if (status === "infrastructure-failure") {
    if (record.score !== null || record.fullPass !== null) {
      throw new EvalError("protocol-drift", `${at} infrastructure failures must report null score and fullPass`, { at });
    }
    return { status, score: null, fullPass: null, checks };
  }
  if (typeof record.score !== "number" || !Number.isFinite(record.score) || record.score < 0 || record.score > 1) {
    throw new EvalError("protocol-drift", `${at}.score must be a number in [0, 1] when graded`, { at: `${at}.score` });
  }
  if (typeof record.fullPass !== "boolean") {
    throw new EvalError("protocol-drift", `${at}.fullPass must be a boolean when graded`, { at: `${at}.fullPass` });
  }
  return { status, score: record.score, fullPass: record.fullPass, checks };
}
