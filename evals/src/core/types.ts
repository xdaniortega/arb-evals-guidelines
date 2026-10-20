/**
 * Pure contracts for the skill evaluation subsystem.
 *
 * This module owns identifiers, schemas, limits, and structured errors. It must stay
 * free of filesystem, process, container, provider, harness, and suite-specific
 * concerns (see evals/ARCHITECTURE.md sections 1-2).
 */

export const INPUT_SCHEMA_VERSION = 1;
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
 *   reproduce historical evidence sealed before workspace collection became universal;
 *   a fresh case source may no longer request it.
 */
export const CANDIDATE_MODES = ["file", "workspace"] as const;
export type CandidateMode = (typeof CANDIDATE_MODES)[number];

/**
 * Where a case configuration was read from. The caller states this at an explicit
 * boundary, so the fresh-run default can never leak into retained evidence and a
 * historical recorded mode is never re-interpreted with today's default.
 *
 * - `fresh`: authored source for a new run. No mode is authored, and the effective
 *   policy resolves to `workspace` before freezing, policy hashing, and dispatch.
 * - `retained`: bytes read back from sealed evidence (`--from`, reproduction, frozen
 *   snapshots). The recorded mode is preserved verbatim.
 */
export const CASE_CONFIG_SOURCES = ["fresh", "retained"] as const;
export type CaseConfigSource = (typeof CASE_CONFIG_SOURCES)[number];

/** Collection policy every fresh evaluation run resolves to, with no authored field. */
export const FRESH_RUN_CANDIDATE_MODE: CandidateMode = "workspace";

/**
 * Documented historical-format default: a case configuration sealed before workspace
 * collection became universal graded exactly the requested output path. Applied only to
 * retained evidence whose execution policy records no mode.
 */
export const HISTORICAL_CANDIDATE_MODE: CandidateMode = "file";

/** Explicit decoder context for one case configuration. */
export interface CaseConfigDecoder {
  readonly source: CaseConfigSource;
  /**
   * Retained inputs only: the mode recorded by that run's verified execution policy.
   * A recorded mode contradicting the retained case configuration is rejected rather
   * than reconciled.
   */
  readonly recordedCandidateMode?: CandidateMode | null;
}

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
export type Limits = Readonly<Record<LimitKey, number>>;
export type PartialLimits = Readonly<Partial<Record<LimitKey, number>>>;

/** Maximum execution time from prompt receipt, independently for each Pi child. */
export const MAX_ARM_WALL_CLOCK_MS = 600_000;
/** Existing five-minute operation bound, also used to reserve non-prompt work. */
export const CONDITION_OPERATION_ALLOWANCE_MS = 300_000;
/** Existing bounded resource cleanup allowance, separate from prompt execution. */
export const CONDITION_CLEANUP_ALLOWANCE_MS = 20_000;

/** Lowest-precedence limit values. Every field must resolve to a positive integer. */
export const SAFE_DEFAULT_LIMITS: Limits = {
  // Starts at each condition's prompt; preparation and sibling execution use separate time.
  wallClockMs: 300_000,
  maxOutputTokens: 8_000,
  maxToolSteps: 120,
  maxProviderRequests: 200,
  maxExportedFiles: 64,
  maxExportedFileBytes: 262_144,
  maxWorkspaceBytes: 2_097_152,
  cpus: 2,
  memoryMiB: 2_048,
  pids: 256,
  diskMiB: 2_048,
};

export interface RuntimeProfile {
  readonly id: RuntimeProfileId;
  readonly description: string;
  readonly limits: PartialLimits;
}

/**
 * Allowlisted runtime profiles. A profile identifier maps through
 * evals/container/image-lock.json to a pinned base identity; that lock file is added
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

/** Decodes a partial limit override, rejecting unknown limit keys and invalid values. */
export function decodePartialLimits(value: unknown, at: string): PartialLimits {
  if (value === undefined) return {};
  const record = requireKeys(value, { required: [], optional: LIMIT_KEYS }, at);
  const limits: Partial<Record<LimitKey, number>> = {};
  for (const key of LIMIT_KEYS) {
    if (record[key] === undefined) continue;
    if (!Number.isSafeInteger(record[key]) || (record[key] as number) <= 0) {
      throw new EvalError("limit-invalid", `${at}.${key} must be a positive safe integer`, { at: `${at}.${key}` });
    }
    limits[key] = record[key] as number;
  }
  return limits;
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

/**
 * Resolves the effective collection policy for one decoded configuration.
 *
 * Fresh and retained inputs deliberately do NOT share a default: a fresh source with no
 * mode is a new run that collects the bounded final workspace, while retained bytes with
 * no mode are old evidence that must keep meaning what they meant when sealed.
 */
function resolveCandidateMode(raw: unknown, decoder: CaseConfigDecoder, at: string): CandidateMode {
  const authored = raw === undefined ? null : requireEnum(raw, CANDIDATE_MODES, `${at}.candidateMode`);
  if (decoder.source === "fresh") {
    if (authored === "file") {
      throw new EvalError(
        "input-invalid",
        `${at}.candidateMode: "file" is obsolete for a new run. Every fresh evaluation grades the bounded final workspace, so remove the candidateMode field from this configuration. Historical receipts keep their recorded mode and stay reproducible with --from.`,
        { at: `${at}.candidateMode` },
      );
    }
    // An explicit `workspace` stays accepted for compatibility: it already agrees.
    return authored ?? FRESH_RUN_CANDIDATE_MODE;
  }
  const recorded = decoder.recordedCandidateMode ?? null;
  if (authored !== null) {
    if (recorded !== null && recorded !== authored) {
      throw new EvalError(
        "evidence-invalid",
        `${at}.candidateMode is ${authored} but the retained execution policy recorded ${recorded}`,
        { at: `${at}.candidateMode` },
      );
    }
    return authored;
  }
  // A supported older format omits the field: recover it from the verified execution
  // policy, otherwise from the documented historical-format default. Never from today's.
  return recorded ?? HISTORICAL_CANDIDATE_MODE;
}

/**
 * Decodes a case configuration for an explicitly stated source.
 *
 * Prefer the `decodeFreshCaseConfig` / `decodeRetainedCaseConfig` boundary helpers so
 * every call site names which contract it is reading.
 */
export function decodeCaseConfig(
  value: unknown,
  at: string,
  decoder: CaseConfigDecoder,
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
  }
  const candidateMode = resolveCandidateMode(record.candidateMode, decoder, at);
  const outputPath = requireString(record.outputPath, `${at}.outputPath`);
  if (candidateMode === "file" && outputPath === WORKSPACE_OUTPUT_MARKER) {
    throw new EvalError(
      "input-invalid",
      `${at}.outputPath cannot be ${WORKSPACE_OUTPUT_MARKER} in file candidateMode`,
      { at: `${at}.outputPath` },
    );
  }
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

/** Fresh authored source for a NEW run: no authored mode, effective policy `workspace`. */
export function decodeFreshCaseConfig(value: unknown, at: string, options?: DecodeConfigOptions): CaseConfig {
  return decodeCaseConfig(value, at, { source: "fresh" }, options);
}

/** Retained sealed evidence: keeps its recorded collection policy, never today's default. */
export function decodeRetainedCaseConfig(
  value: unknown,
  at: string,
  context: { readonly recordedCandidateMode?: CandidateMode | null } = {},
  options?: DecodeConfigOptions,
): CaseConfig {
  return decodeCaseConfig(
    value,
    at,
    { source: "retained", recordedCandidateMode: context.recordedCandidateMode ?? null },
    options,
  );
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
