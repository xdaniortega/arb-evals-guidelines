/**
 * The narrow contract through which images, networks, guests, staging, bounded export,
 * and destruction happen. A sandbox never interprets prompts, scores, or provider
 * semantics, and it never exposes host state to a guest.
 */

import type { Limits, ProbeDetail, RuntimeProfileId, StructuredFailure } from "../core/types.ts";
import type { Readable, Writable } from "node:stream";

export interface ImageSpec {
  readonly runtimeProfileId: RuntimeProfileId;
  /** Allowlisted build context directory. Never the repository root. */
  readonly contextDir: string;
  /** Called only after cache miss and immediately before build work begins. */
  readonly onBuildStarted?: () => void;
  readonly signal?: AbortSignal;
  readonly deadlineAtMs?: number;
  /** Reproduction-only: acquire exactly this retained immutable image or refuse; never build/substitute. */
  readonly expectedIdentity?: { readonly reference: string; readonly digest: string };
}

export interface ImageIdentity {
  readonly reference: string;
  readonly digest: string;
  readonly runtimeProfileId: RuntimeProfileId;
  readonly testDouble: boolean;
  /** Observed reuse state for honest progress reporting. */
  readonly cacheHit?: boolean;
}

export type AllowedTcpPorts = "all" | readonly number[];

export interface NetworkPolicy {
  readonly allowPublicDns: boolean;
  readonly allowPublicTcpPorts: AllowedTcpPorts;
  readonly denyRanges: readonly string[];
}

export interface NetworkIdentity {
  readonly name: string;
  readonly policySha256: string;
}

export interface GuestPolicy {
  readonly readOnlyRoot: boolean;
  readonly writablePaths: readonly string[];
  readonly uid: number;
  readonly gid: number;
  readonly noNewPrivileges: boolean;
  readonly dropCapabilities: boolean;
}

export interface GuestSpec {
  readonly name: string;
  /** Absolute host deadline shared by creation, readiness and the guest lifetime. */
  readonly deadlineAtMs?: number;
  readonly signal?: AbortSignal;
  readonly networkName: string;
  readonly imageDigest: string;
  readonly limits: Limits;
  readonly policy: GuestPolicy;
  /** Non-secret environment only. Credentials are delivered in memory after attestation. */
  readonly env: Readonly<Record<string, string>>;
}

export interface StagedFile {
  readonly path: string;
  readonly base64: string;
  readonly mode: number;
}

export interface StageRequest {
  /** Absolute guest directory. */
  readonly destDir: string;
  readonly files: readonly StagedFile[];
  readonly readOnly: boolean;
  /**
   * Cooperative cancellation. Implementations MUST check it on entry and at each
   * iteration of any walk, and fail with EvalError `interrupted` when aborted, so the
   * runner can honour a wall-clock deadline or a signal and still clean up.
   */
  readonly signal?: AbortSignal;
}

export interface GuestExecRequest {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** See StageRequest.signal. */
  readonly signal?: AbortSignal;
}

export interface GuestExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

export interface ExportRequest {
  readonly root: string;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  /** See StageRequest.signal. */
  readonly signal?: AbortSignal;
}

export interface ExportedTree {
  readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: number; readonly sha256: string; readonly base64: string }>;
  readonly truncated: boolean;
  readonly skipped: readonly string[];
}

/** One mount as it was actually seen in the guest's mount table. */
export interface ObservedMount {
  readonly source: string;
  readonly target: string;
  readonly fstype: string;
  readonly readOnly: boolean;
}

/** One resolver actually in effect, and whether its address is in private space. */
export interface ObservedResolver {
  readonly address: string;
  readonly private: boolean;
}

/**
 * One egress probe, with what was EXPECTED and what actually happened.
 *
 * Both are recorded because a probe result alone is not evidence: "port 80 refused" is
 * only meaningful next to "port 80 was expected to be refused", and the pair is what makes
 * an enforcement claim falsifiable by a later reader.
 */
export interface ObservedEgressProbe {
  readonly label: string;
  readonly category: "private" | "public";
  readonly host: string;
  readonly port: number;
  readonly expectation: "blocked" | "connected";
  readonly outcome: "blocked" | "connected";
  readonly detail: string;
  readonly durationMs: number;
}

/**
 * The RAW observed record behind a `GuestAttestation`.
 *
 * `GuestAttestation`'s scalar fields are a decision surface: they answer "may this guest
 * be credentialed". They are deliberately lossy, and a boolean summary is not evidence.
 * This record is the underlying observation, sealed verbatim so a reader can compare the
 * DECLARED policy in `inputs/policy.json` against what was actually seen inside the guest.
 *
 * It must never contain a credential or a secret value.
 */
export interface ObservedAttestation {
  /** Who produced the observation, e.g. `apple-container-guest` or `fake-sandbox-double`. */
  readonly source: string;
  /** True when the record was produced by a test double rather than a real guest. */
  readonly testDouble: boolean;
  readonly checkedAt: string;
  /** PID 1 after the privilege drop, read from /proc/1/status. */
  readonly init: {
    readonly uid: number | null;
    readonly gid: number | null;
    readonly groups: readonly number[];
    readonly capEff: string | null;
    readonly capPrm: string | null;
    readonly noNewPrivs: boolean;
  };
  /** The process that answered the attestation request. */
  readonly self: {
    readonly uid: number | null;
    readonly gid: number | null;
    readonly groups: readonly number[];
  };
  /** A real attempted write to `/`, not a configuration flag. */
  readonly readOnlyRootProbe: { readonly readOnly: boolean; readonly detail: string };
  readonly declaredWritablePaths: readonly string[];
  readonly mountCount: number;
  readonly hostBackedMounts: readonly ObservedMount[];
  readonly unexpectedWritableMounts: readonly ObservedMount[];
  readonly resolvers: readonly ObservedResolver[];
  readonly anyResolverPrivate: boolean;
  /** The TCP ports the DECLARED network policy permits, as the guest was told them. */
  readonly allowedTcpPorts: AllowedTcpPorts;
  readonly egressProbes: readonly ObservedEgressProbe[];
  readonly dnsProbe: { readonly ok: boolean; readonly detail: string; readonly durationMs: number };
}

/** Privilege and egress attestation, required before any credential is delivered. */
export interface GuestAttestation {
  readonly uid: number;
  readonly gid: number;
  readonly noNewPrivileges: boolean;
  readonly capabilitiesDropped: boolean;
  readonly readOnlyRoot: boolean;
  readonly hostMounts: readonly string[];
  readonly egress: {
    readonly publicDnsAllowed: boolean;
    readonly deniedRangesEnforced: boolean;
    readonly resolverInherited: boolean;
  };
  readonly checkedAt: string;
  /** The full observation this summary was derived from. Sealed into evidence. */
  readonly observed: ObservedAttestation;
}

/**
 * A provider credential handed to a guest at runtime.
 *
 * This is the ONLY route by which a credential may reach a guest. It exists so that a
 * credential never has to appear in an image, a build context, an argument vector, a
 * GuestSpec, a staged file, a log, a trace, a hash, a view, or an artifact.
 */
export interface CredentialDeliveryRequest {
  /** Allowlisted environment variable name inside the guest, e.g. `GEMINI_API_KEY`. */
  readonly variable: string;
  /**
   * The secret value. It is held in memory only. Implementations MUST NOT write it to
   * disk, include it in a run specification, echo it, or record it anywhere.
   */
  readonly value: string;
  readonly signal?: AbortSignal;
  readonly deadlineAtMs?: number;
}

export type DestroyStatus = "destroyed" | "already-absent" | "failed";

export interface DestroyOutcome {
  readonly status: DestroyStatus;
  readonly verified: boolean;
  readonly failure: StructuredFailure | null;
}

export interface GuestStreamSession {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr?: Readable;
  kill(signal?: NodeJS.Signals): void;
  readonly exitCode?: Promise<number | null>;
}

export interface GuestStreamRequest {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface Guest {
  readonly name: string;
  readonly networkName: string;
  readonly imageDigest: string;
  readonly hostWorkspaceDir?: string;
  resolveGuestPath?(guestPath: string): string;
  stage(request: StageRequest): Promise<void>;
  exec(request: GuestExecRequest): Promise<GuestExecResult>;
  execStream?(request: GuestStreamRequest): Promise<GuestStreamSession>;
  exportFiles(request: ExportRequest): Promise<ExportedTree>;
  attest(signal?: AbortSignal, deadlineAtMs?: number): Promise<GuestAttestation>;
  /**
   * Delivers one provider credential into the guest, in memory, over the already
   * established control channel, as an allowlisted environment entry.
   *
   * Implementations MUST:
   * - refuse with EvalError `secret-quarantine` if `attest()` has not already succeeded
   *   for this guest, because a credential may only be delivered after privilege and
   *   egress attestation;
   * - keep the value in memory only for the lifetime of the guest, and never persist,
   *   log, hash, export, or otherwise record it;
   * - record at most the variable NAME in any evidence or diagnostic output.
   */
  deliverCredential(request: CredentialDeliveryRequest): Promise<void>;
  destroy(): Promise<DestroyOutcome>;
}

export type ResourceKind = "image" | "network" | "guest";

export interface ResourceOwnership {
  readonly status: "owned" | "foreign" | "unknown";
  /** Non-secret metadata keys that were actually inspected. */
  readonly labels: Readonly<Record<string, string>>;
  readonly reason: string | null;
}

export interface SandboxProbe {
  readonly ready: boolean;
  readonly details: readonly ProbeDetail[];
}

export type { ProbeDetail };

export interface Sandbox {
  readonly id: string;
  /** True for deterministic test doubles. Evidence must self-label such runs. */
  readonly testDouble: boolean;
  probe(signal?: AbortSignal): Promise<SandboxProbe>;
  buildImage(spec: ImageSpec): Promise<ImageIdentity>;
  createNetwork(name: string, policy: NetworkPolicy, signal?: AbortSignal, deadlineAtMs?: number): Promise<NetworkIdentity>;
  destroyNetwork(name: string, signal?: AbortSignal): Promise<DestroyOutcome>;
  createGuest(spec: GuestSpec): Promise<Guest>;
  /** Exact-identity lookup used by cleanup and recovery. Never a name or label scan. */
  inspectResource(kind: ResourceKind, name: string, signal?: AbortSignal): Promise<"present" | "absent">;
  /** Exact-object ownership metadata. Recovery refuses destruction when unavailable. */
  inspectResourceOwnership?(kind: ResourceKind, name: string, expectedLabels: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<ResourceOwnership>;
  destroyResource(kind: ResourceKind, name: string, signal?: AbortSignal): Promise<DestroyOutcome>;
}
