/**
 * The narrow contract through which a prompt is executed by an agent runtime.
 *
 * A harness never decides parity, scoring, cleanup, or evidence layout. It returns
 * normalized, bounded evidence and an outcome classification, and it must attest its
 * effective runtime identity before the prompt is sent.
 */

import type { NativeSessionEntryRecorder } from "../artifacts/native-prefix.ts";
import type { SkillToolBundle } from "../core/skill-tools.ts";
import type { ConditionId, Limits, ProbeDetail, StopCause, StructuredFailure } from "../core/types.ts";
import type { Target } from "../core/experiment.ts";
import type { Guest } from "../sandboxes/sandbox.ts";
import type { GuardedSecret, SecretRedaction } from "../core/secret-scan.ts";

export interface HarnessRequest {
  readonly conditionId: ConditionId;
  readonly prompt: string;
  /** Absolute guest path of the task workspace. */
  readonly workspaceRoot: string;
  /** Zero paths for baseline, exactly one frozen skill path for treatment. */
  readonly skillPaths: readonly string[];
  readonly allowedTools: readonly string[];
  readonly ambientTools: readonly string[];
  /** The frozen skill-declared tool bundle. Null for baseline; the resolved bundle for treatment. */
  readonly skillToolBundle: SkillToolBundle | null;
  /** Hash of the bundle bound to BOTH arms; the empty-bundle hash when the skill declares none. */
  readonly skillToolBundleSha256: string;
  readonly limits: Limits;
  readonly target: Target;
  /**
   * Cooperative cancellation. Implementations MUST check it on entry and at each
   * iteration of any long-running loop, and fail with EvalError `interrupted` when
   * aborted, so a wall-clock deadline or a signal can stop work and still clean up.
   */
  readonly signal?: AbortSignal;
  /** Absolute invocation active-work deadline; an arm allowance may only shorten it. */
  readonly deadlineAtMs?: number;
  /** Optional guarded secrets to scan against before recording offending frame excerpts. */
  readonly guardedSecrets?: readonly GuardedSecret[];
  /** Evaluator-owned write-only sink for incremental sanitized native entries. */
  readonly nativeSessionRecorder?: NativeSessionEntryRecorder;
}

export interface NormalizedMessage {
  readonly index: number;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly text: string;
  readonly truncated: boolean;
}

export interface NormalizedToolStep {
  readonly index: number;
  readonly tool: string;
  readonly summary: string;
  readonly outcome: "ok" | "error" | "denied";
  readonly durationMs: number;
}

export interface HarnessUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly providerRequests: number;
  readonly toolSteps: number;
}

export interface HarnessTiming {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

/** Resolved runtime facts, recorded in evidence for every condition. */
export interface RuntimeIdentity {
  readonly harnessId: string;
  readonly harnessVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly thinking: string;
  readonly allowedTools: readonly string[];
  readonly ambientTools: readonly string[];
  readonly skillPaths: readonly string[];
  /** Effective Pi tools and client identity; absent for historical evidence and non-Pi doubles. */
  readonly activeTools?: readonly string[];
  readonly mcpClientId?: string;
  readonly seededMcpServers?: readonly string[];
  readonly ambientDiscoveryDisabled: boolean;
  readonly implicitRetryDisabled: boolean;
  readonly testDouble: boolean;
}

export interface HarnessAttestation {
  readonly runtime: RuntimeIdentity;
  readonly checkedAt: string;
}

export type HarnessOutcome = "completed" | "task-limit" | "infrastructure-failure";

export interface NativeSessionRedactions {
  readonly count: number;
  readonly entries: readonly SecretRedaction[];
}

export interface HarnessRunResult {
  readonly outcome: HarnessOutcome;
  /**
   * Precise, structured reason the arm stopped. Distinguishes a harness cumulative-budget
   * exhaustion from a provider-native response truncation and from external cancellation.
   * Coarse `outcome` is retained for compatibility; this refines it.
   */
  readonly stopCause: StopCause;
  /** Provider raw stop reason (e.g. "length", "stop", "aborted", "error"), when known. */
  readonly providerStopReason: string | null;
  readonly messages: readonly NormalizedMessage[];
  readonly toolSteps: readonly NormalizedToolStep[];
  readonly usage: HarnessUsage;
  readonly timing: HarnessTiming;
  readonly runtime: RuntimeIdentity;
  readonly failures: readonly StructuredFailure[];
  readonly nativeSessionEntries?: readonly unknown[];
  readonly nativeSessionRedactions?: NativeSessionRedactions;
}

// ProbeDetail is shared readiness vocabulary owned by core: harness and sandbox are
// peers and must not import from each other.
export type { ProbeDetail };

export interface HarnessProbe {
  readonly ready: boolean;
  readonly details: readonly ProbeDetail[];
}

export interface Harness {
  readonly id: string;
  /** True for deterministic test doubles. Evidence must self-label such runs. */
  readonly testDouble: boolean;
  probe(signal?: AbortSignal): Promise<HarnessProbe>;
  /** Must be called and recorded before the prompt is dispatched. */
  attest(guest: Guest, request: HarnessRequest): Promise<HarnessAttestation>;
  run(guest: Guest, request: HarnessRequest): Promise<HarnessRunResult>;
}
