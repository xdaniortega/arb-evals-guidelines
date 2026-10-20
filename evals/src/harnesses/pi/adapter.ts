/**
 * Real harness adapter for the Pi agent runtime powered by the Pi SDK.
 *
 * Implements the host-side SDK cutover:
 * - Wires the real pinned @earendil-works/pi-coding-agent SDK session into production composition.
 * - Configures, inspects (attests) and executes ONE session per arm.
 * - Enforces strict arm isolation: baseline has zero skills, treatment has exactly one.
 * - Preserves the outer watchdog: wall-clock deadlines, signal abort, task-budget enforcement,
 *   and secret scanning.
 * - Eliminates the superseded RPC client, throwaway attestation process, and duplicate
 *   message parsing.
 * - Classifies provider errors, task limits, and protocol drift into stable structured outcomes.
 */

import { scheduleTimeout, type DeadlineTimer } from "../../core/timing.ts";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { GuestStreamSession } from "../../sandboxes/sandbox.ts";
import type { Api, Context, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { deriveMessagesFromNativeSession, deriveToolStepsFromNativeSession } from "../../artifacts/queries.ts";
import { canonicalJson } from "../../core/experiment.ts";
import { scanForSecrets } from "../../core/secret-scan.ts";
import { assertNotAborted, CONDITION_OPERATION_ALLOWANCE_MS, deriveStopCause, EvalError, resolveGuestTimeouts, SAFE_DEFAULT_LIMITS, STOP_CAUSES, toStructuredFailure } from "../../core/types.ts";
import type { ConditionId, StopCause, StructuredFailure, TerminalClass } from "../../core/types.ts";
import { validateTargetConfiguration } from "../../runner/models.ts";
import type { Guest } from "../../sandboxes/sandbox.ts";
import { sanitizeNativeSessionEntries, type NativeSessionEntry } from "./export-viewer.ts";
import type { ScriptedStep } from "./scripted-stream.ts";
import type {
  Harness,
  HarnessAttestation,
  HarnessOutcome,
  HarnessProbe,
  HarnessRequest,
  HarnessRunResult,
  HarnessUsage,
  NormalizedMessage,
  NormalizedToolStep,
  RuntimeIdentity,
} from "../harness.ts";
import {
  createPiSdkSession,
  type PiSdkSessionInstance,
} from "./sdk-session.ts";
import { buildAmbientTools } from "./ambient-tools.ts";
import { MCP_CLIENT_POLICY, MCP_CLIENT_TOOL_NAME } from "./mcp-tools.ts";

export const PI_HARNESS_ID = "pi";
export const PI_PINNED_VERSION = "0.85.0";

const MAX_MESSAGE_CHARS = 16_000;
const MAX_REMOTE_FRAME_BYTES = 1024 * 1024;
const MAX_REMOTE_OUTPUT_BYTES = 16 * 1024 * 1024;
// Initialization allowance; serial readiness additionally includes sibling execution,
// capture and cleanup, without subtracting them from this child's prompt budget.
export const REMOTE_PRE_PROMPT_TIMEOUT_MS = CONDITION_OPERATION_ALLOWANCE_MS;
export const REMOTE_PROCESS_LIFETIME_MS = 180_000;
export const REMOTE_CLEANUP_MARGIN_MS = 30_000;
const REMOTE_CLOSE_TIMEOUT_MS = 2_000;

type RemoteFrame = Record<string, any>;
type RemoteRedactions = { count: number; entries: import("../../core/secret-scan.ts").SecretRedaction[] };
interface RemoteSession {
  readonly stream: GuestStreamSession;
  readonly ready: Promise<RemoteFrame>;
  readonly result: Promise<RemoteFrame>;
  readonly records: NativeSessionEntry[];
  readonly redactions: import("../../core/secret-scan.ts").SecretRedaction[];
  redactionCount: number;
  sessionId: string | null;
  readyHeader: RemoteFrame | null;
  prompted: boolean;
  resultSeen: boolean;
  terminalSeen: boolean;
  failed: boolean;
  failure: unknown | null;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function exactFields(frame: RemoteFrame, fields: readonly string[], at: string): void {
  const expected = new Set(fields);
  const unknown = Object.keys(frame).filter((key) => !expected.has(key));
  const missing = fields.filter((key) => !(key in frame));
  if (unknown.length > 0 || missing.length > 0) {
    throw new EvalError("protocol-drift", `${at} fields drifted (unknown=${unknown.join(",") || "none"}; missing=${missing.join(",") || "none"})`, { at });
  }
}

function validateRedactions(value: unknown, at: string): RemoteRedactions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EvalError("protocol-drift", `${at} must be redaction metadata`, { at });
  const metadata = value as RemoteFrame;
  exactFields(metadata, ["count", "entries"], at);
  if (!Number.isSafeInteger(metadata.count) || metadata.count < 0 || !Array.isArray(metadata.entries)) throw new EvalError("protocol-drift", `${at} is invalid`, { at });
  let count = 0;
  for (const [index, raw] of metadata.entries.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new EvalError("protocol-drift", `${at}.entries[${index}] is invalid`, { at });
    const item = raw as RemoteFrame;
    exactFields(item, ["path", "label", "encoding", "count"], `${at}.entries[${index}]`);
    if (typeof item.path !== "string" || typeof item.label !== "string" ||
        !["raw", "json-escaped", "percent-encoded", "base64", "base64url"].includes(item.encoding) ||
        !Number.isSafeInteger(item.count) || item.count <= 0) throw new EvalError("protocol-drift", `${at}.entries[${index}] is invalid`, { at });
    count += item.count;
  }
  if (count !== metadata.count) throw new EvalError("protocol-drift", `${at}.count does not equal its occurrence count`, { at });
  return structuredClone(metadata) as RemoteRedactions;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

async function awaitRemoteExit(session: RemoteSession): Promise<void> {
  if (session.stream.exitCode === undefined || session.stream.termination === undefined) throw new EvalError("protocol-drift", "guest SDK stream cannot verify process closure", { at: "pi.remote.exit" });
  let timer: NodeJS.Timeout | null = null;
  try {
    const code = await Promise.race([
      session.stream.exitCode,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EvalError("protocol-drift", "guest SDK did not close after result", { at: "pi.remote.exit" })), REMOTE_CLOSE_TIMEOUT_MS); }),
    ]);
    // A forced settlement is not an observed close/error: it remains unresolved and
    // must not be consumed as confirmed termination or as evidence of absence.
    const termination = await session.stream.termination;
    if (termination !== "confirmed") throw new EvalError("cleanup-failed", "guest SDK stream termination was forced without confirmed closure", { at: "pi.remote.exit" });
    if (code !== 0) throw new EvalError("protocol-drift", `guest SDK exited ${String(code)} after result`, { at: "pi.remote.exit" });
  } finally { if (timer !== null) clearTimeout(timer); }
}

function writeRemoteFrame(session: RemoteSession, frame: Record<string, unknown>): void {
  if (session.failed || session.stream.stdin.destroyed) {
    throw new EvalError("protocol-drift", "guest SDK control stream is not writable", { at: "pi.remote" });
  }
  session.stream.stdin.write(`${JSON.stringify(frame)}\n`);
}

export interface PiHarnessOptions {
  /** Custom scripted stream override for testing without live model calls. */
  readonly streamSimpleOverride?: (
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ) => any;
  /** Creates an arm-private scripted delegate when both local sessions must be ready together. */
  readonly streamSimpleOverrideFactory?: (arm: ConditionId) => PiHarnessOptions["streamSimpleOverride"];
  readonly sessionDir?: string;
  readonly apiKey?: string;
  readonly inMemorySession?: boolean;
  readonly probeChecker?: () => Promise<HarnessProbe>;
  readonly onSessionCreated?: (sessionInstance: PiSdkSessionInstance) => void;
  /** JSON-only completion fixture for the image-resident agent. Test composition only. */
  readonly scriptedSteps?: readonly ScriptedStep[];
  readonly faults?: {
    readonly simulateNativeSanitizerFailure?: boolean;
    readonly failConditionId?: ConditionId;
  };
}

function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length > MAX_MESSAGE_CHARS) {
    return { text: text.slice(0, MAX_MESSAGE_CHARS), truncated: true };
  }
  return { text, truncated: false };
}

/**
 * @notice Creates isolated Pi sessions with attested runtime settings and task budgets.
 * @param options Runtime dependencies and explicit test-only substitutions.
 * @returns A harness that configures, executes, and disposes each arm independently.
 */
export function createPiHarness(options: PiHarnessOptions = {}): Harness {
  const scriptedBoundary = options.streamSimpleOverride !== undefined || options.streamSimpleOverrideFactory !== undefined || options.scriptedSteps !== undefined;
  if (options.faults?.simulateNativeSanitizerFailure && !scriptedBoundary) {
    throw new EvalError(
      "parity-violation",
      "adapter faults are rejected outside scripted test composition (streamSimpleOverride required)",
      { at: "harness.faults" },
    );
  }
  if (options.onSessionCreated && options.streamSimpleOverride === undefined && options.streamSimpleOverrideFactory === undefined) {
    throw new EvalError(
      "parity-violation",
      "adapter session callbacks are rejected outside scripted test composition (streamSimpleOverride required)",
      { at: "harness.callbacks" },
    );
  }
  if ((options.streamSimpleOverride !== undefined || options.streamSimpleOverrideFactory !== undefined) && options.scriptedSteps !== undefined) {
    throw new EvalError("parity-violation", "select exactly one local or guest scripted transport boundary", { at: "harness.scripted" });
  }
  const isTestDouble =
    scriptedBoundary ||
    Boolean(options.faults?.simulateNativeSanitizerFailure) ||
    options.onSessionCreated !== undefined;
  const sessions = new Map<ConditionId, PiSdkSessionInstance>();
  const remoteSessions = new Map<ConditionId, RemoteSession>();

  const runtimeFor = (request: HarnessRequest): RuntimeIdentity => ({
    harnessId: PI_HARNESS_ID,
    harnessVersion: PI_PINNED_VERSION,
    provider: request.target.provider,
    model: request.target.model,
    thinking: request.target.thinking,
    allowedTools: [...request.allowedTools],
    ambientTools: [...request.ambientTools],
    activeTools: [...request.allowedTools, MCP_CLIENT_TOOL_NAME],
    mcpClientId: MCP_CLIENT_POLICY.id,
    seededMcpServers: (request.conditionId === "treatment" ? request.skillToolBundle?.servers ?? [] : []).map((server) => server.name).sort(),
    skillPaths: [...request.skillPaths],
    ambientDiscoveryDisabled: true,
    implicitRetryDisabled: true,
    testDouble: isTestDouble,
  });

  async function getOrCreateSession(guest: Guest, request: HarnessRequest): Promise<PiSdkSessionInstance> {
    validateTargetConfiguration(request.target);

    // Enforce arm isolation before session creation or reuse:
    // baseline must have 0 skill paths, treatment must have exactly 1
    if (request.conditionId === "baseline" && request.skillPaths.length !== 0) {
      throw new EvalError(
        "parity-violation",
        `baseline condition requested ${request.skillPaths.length} skill paths (expected exactly 0)`,
        { at: "harness.skills" },
      );
    }
    if (request.conditionId === "treatment" && request.skillPaths.length !== 1) {
      throw new EvalError(
        "parity-violation",
        `treatment condition requested ${request.skillPaths.length} skill paths (expected exactly 1)`,
        { at: "harness.skills" },
      );
    }

    const existing = sessions.get(request.conditionId);
    if (existing) {
      return existing;
    }

    // A host-visible workspace is the deliberately narrow L1/local-synthetic seam.
    // Remote guests are handled by the image-resident framed agent below; they never
    // fall back to a host temporary directory.
    //
    // WHY this is a hard error and not a fallback: the previous fallback silently pointed
    // the agent at an empty host temp directory while the frozen fixture sat at /work and
    // the skill at /opt/skills/<suite> INSIDE the guest. Against a real container the agent
    // therefore ran on the host, in the wrong place, with no skill and no fixture — which
    // both violates the contract's "Pi SDK inside each guest" requirement and produced a
    // run that hung for ~59 minutes and leaked guests. A configuration that cannot be
    // correct must be rejected in milliseconds, not degraded into a plausible-looking one.
    if (guest.hostWorkspaceDir === undefined || guest.resolveGuestPath === undefined) {
      throw new EvalError("platform-unsupported", "local Pi SDK session requested for a remote guest", { at: "pi.harness.guest" });
    }
    const workspaceDir = guest.hostWorkspaceDir;
    mkdirSync(workspaceDir, { recursive: true });

    const rawSkillPath = request.skillPaths[0];
    const skillPath = rawSkillPath ? guest.resolveGuestPath(rawSkillPath) : undefined;

    const instance = await createPiSdkSession({
      cwd: workspaceDir,
      arm: request.conditionId,
      target: request.target,
      skillPath,
      allowedTools: request.allowedTools,
      ambientTools: buildAmbientTools(request.ambientTools, workspaceDir),
      skillToolBundle: request.conditionId === "treatment" ? (request.skillToolBundle ?? null) : null,
      skillToolBundleSha256: request.conditionId === "treatment" ? request.skillToolBundleSha256 : null,
      streamSimpleOverride: options.streamSimpleOverrideFactory?.(request.conditionId) ?? options.streamSimpleOverride,
      apiKey: options.apiKey,
      sessionDir: options.sessionDir,
      inMemorySession: options.inMemorySession,
      budget: request.limits,
      nativeSessionRecorder: request.nativeSessionRecorder,
      signal: request.signal,
      deadlineAtMs: request.deadlineAtMs !== undefined && request.deadlineAtMs > Date.now()
        ? request.deadlineAtMs
        // No request deadline: derive one from a finite arm wall clock, but leave it
        // undefined (no arm deadline) when the arm is unlimited (wallClockMs === null).
        : request.limits.wallClockMs !== null
          ? Date.now() + request.limits.wallClockMs
          : undefined,
      guardedSecrets: request.guardedSecrets,
    });

    sessions.set(request.conditionId, instance);
    options.onSessionCreated?.(instance);
    return instance;
  }

  async function getOrCreateRemoteSession(guest: Guest, request: HarnessRequest): Promise<RemoteSession> {
    const existing = remoteSessions.get(request.conditionId);
    if (existing) return existing;
    if (guest.execStream === undefined) {
      throw new EvalError("platform-unsupported", "remote Pi guest does not support bounded execStream", { at: "pi.remote" });
    }
    if (options.streamSimpleOverride !== undefined || options.streamSimpleOverrideFactory !== undefined) {
      throw new EvalError("parity-violation", "an in-process stream override cannot cross the guest boundary", { at: "pi.remote" });
    }

    // A finite arm wall clock derives a bounded stream timeout; an unlimited arm
    // (wallClockMs === null) has no wall-clock-derived stream timeout, so the guest stream
    // is bounded only by an explicit finite request deadline or by cooperative cancellation.
    const armAllowanceMs = (request.limits?.wallClockMs !== null && request.limits.wallClockMs > 0)
      ? request.limits.wallClockMs
      : null;
    // Own setup + sibling setup/capture + both serial prompt allowances. The supervisor
    // starts before this stream and has a smaller shutdown margin (10s versus 30s).
    const nominalStreamTimeoutMs = armAllowanceMs === null ? null : resolveGuestTimeouts(armAllowanceMs).streamMs;
    const finiteDeadlineRemainingMs = request.deadlineAtMs !== undefined && Number.isFinite(request.deadlineAtMs)
      ? Math.max(1, request.deadlineAtMs - Date.now())
      : null;
    const streamTimeoutMs = finiteDeadlineRemainingMs !== null
      ? (nominalStreamTimeoutMs !== null ? Math.min(nominalStreamTimeoutMs, finiteDeadlineRemainingMs) : finiteDeadlineRemainingMs)
      : (nominalStreamTimeoutMs ?? undefined);
    const stream = await guest.execStream({
      command: ["node", "/opt/eval/run-measured.mjs", "agent"],
      cwd: request.workspaceRoot,
      timeoutMs: streamTimeoutMs,
      signal: request.signal,
    });
    const ready = deferred<RemoteFrame>();
    const result = deferred<RemoteFrame>();
    const session: RemoteSession = {
      stream,
      ready: ready.promise,
      result: result.promise,
      records: [],
      redactions: [],
      redactionCount: 0,
      sessionId: null,
      readyHeader: null,
      prompted: false,
      resultSeen: false,
      terminalSeen: false,
      failed: false,
      failure: null,
    };
    // Attestation may fail before run awaits the result; keep that promise observed.
    session.result.catch(() => undefined);
    remoteSessions.set(request.conditionId, session);

    let buffer = Buffer.alloc(0);
    let totalBytes = 0;
    let sequence = 0;
    let readySeen = false;
    const fail = (error: unknown): void => {
      if (session.failed) return;
      session.failed = true;
      const failure = error instanceof EvalError
        ? error
        : new EvalError("protocol-drift", error instanceof Error ? error.message : "invalid guest SDK frame", { at: "pi.remote" });
      session.failure = failure;
      ready.reject(failure);
      result.reject(failure);
      stream.kill("SIGTERM");
    };
    let stderrBuffer = Buffer.alloc(0);
    stream.stderr?.on("data", (chunk: Buffer) => {
      try {
        stderrBuffer = Buffer.concat([stderrBuffer, chunk]);
        if (stderrBuffer.byteLength > MAX_REMOTE_FRAME_BYTES) throw new Error("guest SDK stderr exceeded 1 MiB");
        if (scanForSecrets({ path: "pi.remote.stderr", content: stderrBuffer }, request.guardedSecrets ?? []).length > 0) {
          throw new EvalError("secret-quarantine", "guest SDK stderr retained a guarded secret", { at: "pi.remote.stderr" });
        }
      } catch (error) { fail(error); }
    });
    stream.stderr?.once("error", fail);
    const accept = (line: Buffer): void => {
      if (line.byteLength === 0) throw new EvalError("protocol-drift", "guest SDK emitted an empty frame", { at: "pi.remote" });
      if (line.byteLength > MAX_REMOTE_FRAME_BYTES) throw new Error("guest SDK frame exceeded 1 MiB");
      if (session.resultSeen) throw new EvalError("protocol-drift", "guest SDK emitted a frame after its terminal result", { at: "pi.remote" });
      const text = line.toString("utf8");
      if (scanForSecrets({ path: "pi.remote.stdout", content: text }, request.guardedSecrets ?? []).length > 0) {
        throw new EvalError("secret-quarantine", "guest SDK frame retained a guarded secret", { at: "pi.remote.stdout" });
      }
      const frame = JSON.parse(text) as RemoteFrame;
      if (!frame || typeof frame !== "object" || Array.isArray(frame) || frame.protocolVersion !== 1 || typeof frame.type !== "string") {
        throw new Error("guest SDK returned an invalid protocol frame");
      }
      if (frame.type === "ready") {
        exactFields(frame, ["type", "protocolVersion", "sessionId", "header", "attestation", "process"], "pi.remote.ready");
        if (readySeen || typeof frame.sessionId !== "string" || frame.sessionId === "" || !frame.header || typeof frame.header !== "object" || Array.isArray(frame.header)) throw new Error("invalid or duplicate guest SDK ready frame");
        exactFields(frame.header, ["type", "version", "id", "timestamp", "cwd"], "pi.remote.ready.header");
        if (frame.header.type !== "session" || frame.header.version !== 3 || frame.header.id !== frame.sessionId || typeof frame.header.timestamp !== "string" || Number.isNaN(Date.parse(frame.header.timestamp)) || typeof frame.header.cwd !== "string") throw new Error("invalid guest SDK ready header");
        readySeen = true;
        session.sessionId = frame.sessionId;
        session.readyHeader = structuredClone(frame.header);
        ready.resolve(frame);
      } else if (frame.type === "record") {
        exactFields(frame, ["type", "protocolVersion", "sequence", "record", "redactions"], "pi.remote.record");
        if (!readySeen || session.prompted && session.terminalSeen || frame.sequence !== sequence + 1 || !frame.record || typeof frame.record !== "object" || Array.isArray(frame.record)) throw new Error("guest SDK native record sequence drifted");
        if (sequence === 0 && canonicalJson(frame.record, "pi.remote.nativeHeader") !== canonicalJson(session.readyHeader, "pi.remote.readyHeader")) throw new Error("guest SDK native header did not canonically match ready session");
        const redactions = validateRedactions(frame.redactions, "pi.remote.record.redactions");
        sequence = frame.sequence;
        session.records.push(frame.record as NativeSessionEntry);
        session.redactions.push(...redactions.entries);
        session.redactionCount += redactions.count;
        request.nativeSessionRecorder?.record(frame.record as NativeSessionEntry, redactions);
      } else if (frame.type === "result") {
        exactFields(frame, ["type", "protocolVersion", "sessionId", "outcome", "usage", "timing", "terminal", "redactions"], "pi.remote.result");
        if (!readySeen || !session.prompted || session.terminalSeen || frame.sessionId !== session.sessionId) throw new Error("guest SDK result did not match the ready session");
        if (!frame.terminal || frame.terminal.streamingStopped !== true) throw new Error("guest SDK result did not verify stopped streaming and descendants");
        const terminalRedactions = validateRedactions(frame.redactions, "pi.remote.result.redactions");
        if (terminalRedactions.count !== session.redactionCount) throw new Error("guest SDK terminal redaction total did not match its durable record prefix");
        session.terminalSeen = true;
        session.resultSeen = true;
        result.resolve(frame);
      } else if (frame.type === "error") {
        exactFields(frame, ["type", "protocolVersion", "state", "error", "streamingStopped"], "pi.remote.error");
        throw new Error(typeof frame.error === "string" ? frame.error : "guest SDK failed without a bounded diagnostic");
      } else {
        throw new Error(`unknown guest SDK frame type: ${frame.type}`);
      }
    };
    stream.stdout.on("data", (chunk: Buffer) => {
      try {
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_REMOTE_OUTPUT_BYTES) throw new Error("guest SDK output exceeded 16 MiB");
        buffer = Buffer.concat([buffer, chunk]);
        let newline: number;
        while ((newline = buffer.indexOf(0x0a)) !== -1) {
          const line = buffer.subarray(0, newline);
          buffer = buffer.subarray(newline + 1);
          accept(line);
        }
        if (buffer.byteLength > MAX_REMOTE_FRAME_BYTES) throw new Error("guest SDK frame exceeded 1 MiB");
      } catch (error) { fail(error); }
    });
    stream.stdout.once("error", fail);
    stream.exitCode?.then((code) => {
      if (buffer.byteLength !== 0) return fail(new Error("guest SDK stream ended with an incomplete frame"));
      if (!session.failed && !session.resultSeen) fail(new Error(`guest SDK exited before a result (code ${String(code)})`));
    }).catch(fail);

    const variable = request.target.provider === "google" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
    writeRemoteFrame(session, {
      type: "init",
      protocolVersion: 1,
      mode: options.scriptedSteps === undefined ? "measured" : "scripted",
      arm: request.conditionId,
      target: request.target,
      skillPath: request.skillPaths[0] ?? null,
      allowedTools: [...request.allowedTools],
      ambientTools: [...request.ambientTools],
      skillToolBundle: request.conditionId === "treatment" ? (request.skillToolBundle ?? null) : null,
      skillToolBundleSha256: request.skillToolBundleSha256,
      processLifetimeMs: REMOTE_PROCESS_LIFETIME_MS,
      armWallClockMs: request.limits.wallClockMs,
      limits: {
        maxProviderRequests: request.limits.maxProviderRequests,
        maxToolSteps: request.limits.maxToolSteps,
        maxOutputTokens: request.limits.maxOutputTokens,
      },
      credentialVariable: variable,
      ...(request.captureReasoning !== undefined ? { captureReasoning: request.captureReasoning } : {}),
      ...(options.scriptedSteps === undefined ? {} : { scriptedSteps: options.scriptedSteps }),
    });
    return session;
  }

  return {
    id: PI_HARNESS_ID,
    testDouble: isTestDouble,

    async probe(signal?: AbortSignal): Promise<HarnessProbe> {
      assertNotAborted(signal, "pi.probe");
      if (options.probeChecker) {
        const probe = await options.probeChecker();
        assertNotAborted(signal, "pi.probe");
        return probe;
      }
      return {
        ready: true,
        details: [
          {
            name: "pi-runtime",
            status: "ok",
            detail: `Pi coding agent pinned at ${PI_PINNED_VERSION}`,
          },
        ],
      };
    },

    async attest(guest: Guest, request: HarnessRequest): Promise<HarnessAttestation> {
      assertNotAborted(request.signal, "pi.attest");
      validateTargetConfiguration(request.target);
      if (request.conditionId === "baseline" && request.skillPaths.length !== 0) throw new EvalError("parity-violation", "baseline must load zero skills");
      if (request.conditionId === "treatment" && request.skillPaths.length !== 1) throw new EvalError("parity-violation", "treatment must load exactly one skill");

      let attestation: any;
      if (guest.hostWorkspaceDir !== undefined && guest.resolveGuestPath !== undefined) {
        const instance = await getOrCreateSession(guest, request);
        attestation = instance.attest();
      } else {
        const session = await getOrCreateRemoteSession(guest, request);
        const frame = await session.ready;
        attestation = frame.attestation;
      }

      if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
        throw new EvalError("parity-violation", "guest SDK readiness omitted attestation", { at: "pi.attestation" });
      }
      exactFields(attestation, ["arm", "target", "modelId", "providerId", "thinkingLevel", "activeTools", "ambientCustomTools", "mcpClientId", "seededMcpServers", "skillToolBundleSha256", "loadedSkills", "agentsFilesCount", "extensionsCount", "promptsCount", "themesCount", "retryEnabled", "compactionEnabled"], "pi.attestation");
      if (!attestation.target || typeof attestation.target !== "object" || Array.isArray(attestation.target)) throw new EvalError("parity-violation", "guest SDK readiness omitted target attestation", { at: "pi.attestation.target" });
      exactFields(attestation.target, ["provider", "model", "thinking"], "pi.attestation.target");
      if (attestation.arm !== request.conditionId || attestation.modelId !== request.target.model ||
          attestation.providerId !== request.target.provider || attestation.thinkingLevel !== request.target.thinking ||
          JSON.stringify(attestation.target) !== JSON.stringify(request.target) ||
          JSON.stringify(attestation.ambientCustomTools) !== JSON.stringify([...request.ambientTools].sort()) ||
          attestation.agentsFilesCount !== 0 || attestation.extensionsCount !== 0 ||
          attestation.promptsCount !== 0 || attestation.themesCount !== 0 ||
          attestation.retryEnabled !== false || attestation.compactionEnabled !== false) {
        throw new EvalError("parity-violation", "guest SDK readiness did not attest the frozen runtime configuration", { at: "pi.attestation" });
      }

      // Server choices are agent behavior; only the shared interface and preparation
      // seeds are attested here. Both arms expose exactly the same generic tool.
      if (attestation.mcpClientId !== MCP_CLIENT_POLICY.id ||
          JSON.stringify(attestation.activeTools) !== JSON.stringify([...request.allowedTools, MCP_CLIENT_TOOL_NAME])) {
        throw new EvalError("parity-violation", "guest MCP client or effective tool set differs from shared policy", { at: "pi.attestation.activeTools" });
      }
      const seededServers = (request.conditionId === "treatment" ? request.skillToolBundle?.servers ?? [] : []).map((server) => server.name).sort();
      if (JSON.stringify(attestation.seededMcpServers) !== JSON.stringify(seededServers)) {
        throw new EvalError("parity-violation", "guest seeded MCP servers differ from condition configuration", { at: "pi.attestation.seededMcpServers" });
      }
      const expectedBundleHash = request.conditionId === "treatment" ? request.skillToolBundleSha256 : null;
      if (attestation.skillToolBundleSha256 !== expectedBundleHash) {
        throw new EvalError("parity-violation", "guest skill tool bundle digest differs from condition configuration", { at: "pi.attestation.skillToolBundleSha256" });
      }
      if (!Array.isArray(attestation.loadedSkills)) throw new EvalError("parity-violation", "guest SDK readiness loadedSkills must be an array", { at: "inspector.skills" });
      const loadedSkills = attestation.loadedSkills;
      for (const skill of loadedSkills) {
        if (!skill || typeof skill !== "object" || Array.isArray(skill)) throw new EvalError("parity-violation", "guest SDK readiness carried invalid skill attestation", { at: "inspector.skills" });
        exactFields(skill, ["name", "path"], "pi.attestation.loadedSkills");
        if (typeof skill.name !== "string" || skill.name === "" || typeof skill.path !== "string") throw new EvalError("parity-violation", "guest SDK readiness carried invalid skill attestation", { at: "inspector.skills" });
      }
      if (request.conditionId === "baseline" && loadedSkills.length !== 0) {
        throw new EvalError("parity-violation", "remote baseline attested unexpected skills", { at: "inspector.skills" });
      }
      if (request.conditionId === "treatment") {
        const loadedSkill = loadedSkills[0];
        const rawSkillPath = request.skillPaths[0];
        const expectedRoot = rawSkillPath && guest.resolveGuestPath ? guest.resolveGuestPath(rawSkillPath) : rawSkillPath;
        const expectedPath = expectedRoot ? posix.join(expectedRoot.replaceAll("\\", "/"), "SKILL.md") : "";
        if (loadedSkills.length !== 1 || !loadedSkill || loadedSkill.path.replaceAll("\\", "/") !== expectedPath) {
          throw new EvalError("parity-violation", `treatment condition skill path mismatch: attested '${loadedSkill?.path ?? "<none>"}', expected '${expectedPath}'`, { at: "inspector.skills" });
        }
      }
      if (guest.hostWorkspaceDir === undefined) {
        const frame = await remoteSessions.get(request.conditionId)!.ready;
        const observedProcess = frame.process;
        if (!observedProcess || typeof observedProcess !== "object" || Array.isArray(observedProcess)) throw new EvalError("parity-violation", "guest SDK readiness omitted process attestation", { at: "pi.attestation.process" });
        exactFields(observedProcess, ["platform", "pid", "uid", "gid", "cwd"], "pi.attestation.process");
        if (observedProcess.platform !== "linux" || !Number.isSafeInteger(observedProcess.pid) || observedProcess.pid <= 1 ||
            observedProcess.uid !== 10_001 || observedProcess.gid !== 10_001 || observedProcess.cwd !== request.workspaceRoot) {
          throw new EvalError("parity-violation", "guest SDK readiness process did not match the isolated guest runtime", { at: "pi.attestation.process" });
        }
      }

      return { runtime: runtimeFor(request), checkedAt: new Date().toISOString() };
    },

    async run(guest: Guest, request: HarnessRequest): Promise<HarnessRunResult> {
      assertNotAborted(request.signal, "pi.run");
      const remote = remoteSessions.get(request.conditionId);
      if (remote !== undefined) {
        remoteSessions.delete(request.conditionId);
        remote.prompted = true;
        const onAbort = (): void => {
          try { writeRemoteFrame(remote, {
            type: "abort",
            reason: request.signal?.reason instanceof Error ? request.signal.reason.message : "host cancelled",
            cause: request.signal?.reason instanceof Error && request.signal.reason.name === "ArmBudgetExceeded" ? "arm-budget" : "external",
          }); }
          catch { remote.stream.kill("SIGTERM"); }
        };
        request.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          writeRemoteFrame(remote, { type: "prompt", prompt: request.prompt });
          const frame = await remote.result;
          remote.stream.stdin.end();
          let closureError: unknown = null;
          try { await awaitRemoteExit(remote); }
          catch (error: unknown) { closureError = error; }
          if (remote.failure !== null) throw remote.failure;
          if (closureError !== null) throw closureError;
          // remote.records already carries entries the guest redacted before sending
          // each `record` frame (native-prefix.ts#record runs on that side); no second
          // redaction pass is needed here.
          const entries = remote.records;
          const messages = deriveMessagesFromNativeSession(entries).map((message) => {
            const bounded = truncateText(message.text);
            return { ...message, text: bounded.text, truncated: bounded.truncated };
          });
          const toolSteps = deriveToolStepsFromNativeSession(entries);
          const outcome = frame.outcome;
          if (outcome !== "completed" && outcome !== "task-limit" && outcome !== "infrastructure-failure") {
            throw new EvalError("protocol-drift", "guest SDK result carried an unknown outcome", { at: "pi.remote.result" });
          }
          const usage = frame.usage;
          const timing = frame.timing;
          const terminal = frame.terminal;
          if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new EvalError("protocol-drift", "guest SDK result omitted usage", { at: "pi.remote.result" });
          exactFields(usage, ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "providerRequests", "toolSteps", "taskLimitReason"], "pi.remote.result.usage");
          for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
            if (usage[key] !== null && !finiteNonNegative(usage[key])) throw new EvalError("protocol-drift", `guest SDK result carried invalid ${key}`, { at: "pi.remote.result" });
          }
          if (!Number.isSafeInteger(usage.providerRequests) || usage.providerRequests < 0 || !Number.isSafeInteger(usage.toolSteps) || usage.toolSteps < 0 ||
              !(usage.taskLimitReason === null || typeof usage.taskLimitReason === "string")) throw new EvalError("protocol-drift", "guest SDK result carried invalid usage counters", { at: "pi.remote.result" });
          if (!timing || typeof timing !== "object" || Array.isArray(timing)) throw new EvalError("protocol-drift", "guest SDK result omitted timing", { at: "pi.remote.result" });
          exactFields(timing, ["startedAt", "completedAt", "durationMs"], "pi.remote.result.timing");
          if (typeof timing.startedAt !== "string" || Number.isNaN(Date.parse(timing.startedAt)) || typeof timing.completedAt !== "string" || Number.isNaN(Date.parse(timing.completedAt)) || !finiteNonNegative(timing.durationMs)) {
            throw new EvalError("protocol-drift", "guest SDK result carried invalid timing", { at: "pi.remote.result" });
          }
          if (!terminal || typeof terminal !== "object" || Array.isArray(terminal)) throw new EvalError("protocol-drift", "guest SDK result omitted terminal state", { at: "pi.remote.result" });
          exactFields(terminal, ["stopReason", "rawStopReason", "classification", "stopCause", "semanticAbortCause", "error", "streamingStopped"], "pi.remote.result.terminal");
          const validClasses = ["completed", "task-limit", "interrupted", "execution-failure", "unexpected-abort"];
          if (!(terminal.rawStopReason === null || typeof terminal.rawStopReason === "string")) {
            throw new EvalError("protocol-drift", "guest SDK result carried an invalid raw provider stop reason", { at: "pi.remote.result" });
          }
          if (!(STOP_CAUSES as readonly string[]).includes(terminal.stopCause)) {
            throw new EvalError("protocol-drift", "guest SDK result carried an unknown stop cause", { at: "pi.remote.result" });
          }
          if (!validClasses.includes(terminal.classification) || terminal.streamingStopped !== true ||
              !(terminal.stopReason === null || typeof terminal.stopReason === "string") ||
              !(terminal.semanticAbortCause === null || terminal.semanticAbortCause === "external" || terminal.semanticAbortCause === "arm-budget") ||
              !(terminal.error === null || typeof terminal.error === "string") ||
              (outcome === "completed" && (terminal.classification !== "completed" || terminal.error !== null || terminal.semanticAbortCause !== null || terminal.stopReason === "error" || terminal.stopReason === "aborted" || terminal.stopReason === "length" || usage.taskLimitReason !== null)) ||
              (outcome === "task-limit" && (terminal.classification !== "task-limit" || terminal.stopReason === "error" || terminal.semanticAbortCause === "external" || (usage.taskLimitReason === null && terminal.stopReason !== "length" && terminal.semanticAbortCause !== "arm-budget"))) ||
              (outcome === "infrastructure-failure" && ["completed", "task-limit"].includes(terminal.classification))) {
            throw new EvalError("protocol-drift", "guest SDK result carried inconsistent terminal state", { at: "pi.remote.result" });
          }
          const failures: StructuredFailure[] = outcome === "infrastructure-failure" ? [{
            code: terminal.classification === "interrupted" ? "interrupted" : terminal.classification === "execution-failure" ? "provider-error" : "protocol-drift",
            failureClass: "infrastructure",
            message: String(terminal.error ?? terminal.classification),
            at: "pi.remote.run",
          }] : [];
          return {
            outcome,
            stopCause: terminal.stopCause as StopCause,
            // Preserve the RAW provider stop reason (e.g. MAX_TOKENS/STOP). Fall back to the
            // normalized reason only when no raw reason was captured, for backwards
            // compatibility with responses that never carried one.
            providerStopReason: typeof terminal.rawStopReason === "string"
              ? terminal.rawStopReason
              : typeof terminal.stopReason === "string" ? terminal.stopReason : null,
            messages,
            toolSteps,
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
              providerRequests: usage.providerRequests,
              toolSteps: usage.toolSteps,
            },
            timing,
            runtime: runtimeFor(request),
            failures,
            nativeSessionEntries: entries,
            nativeSessionRedactions: {
              count: remote.redactionCount,
              entries: remote.redactions,
            },
          };
        } finally {
          request.signal?.removeEventListener("abort", onAbort);
          if (!remote.stream.stdin.destroyed) remote.stream.stdin.end();
        }
      }

      const instance = await getOrCreateSession(guest, request);
      sessions.delete(request.conditionId);

      const runtime = runtimeFor(request);

      let taskLimitReason: string | null = null;
      let wallClockTimedOut = false;
      let timeoutTimer: DeadlineTimer | null = null;

      // Watchdog 1: wall-clock timeout. An unlimited arm (wallClockMs === null) arms no
      // timeout, so it never collapses to an immediate or hidden finite deadline.
      const armWallClockMs = request.limits.wallClockMs;
      if (armWallClockMs !== null && armWallClockMs > 0) {
        timeoutTimer = scheduleTimeout(() => {
          wallClockTimedOut = true;
          taskLimitReason = `wall-clock deadline of ${armWallClockMs}ms elapsed`;
          instance.session.abort();
        }, armWallClockMs);
        timeoutTimer.unref();
      }

      // Watchdog 2: cooperative cancellation via AbortSignal
      const onSignalAbort = () => {
        const reason = request.signal?.reason instanceof Error
          ? request.signal.reason.message
          : String(request.signal?.reason ?? "");
        if (request.signal?.reason instanceof Error && request.signal.reason.name === "ArmBudgetExceeded") {
          wallClockTimedOut = true;
          taskLimitReason = taskLimitReason ?? reason;
        }
        instance.session.abort();
      };
      request.signal?.addEventListener("abort", onSignalAbort, { once: true });

      const startedAt = new Date().toISOString();
      const promptStart = Date.now();
      // For a finite arm, set the prompt-relative deadline; for an unlimited arm, explicitly
      // set deadline to Infinity so the MCP client budget does not cap at its default 180s.
      if (request.limits.wallClockMs !== null) {
        instance.setDeadline?.(promptStart + request.limits.wallClockMs);
      } else {
        instance.setDeadline?.(Number.POSITIVE_INFINITY);
      }
      let executionError: unknown = null;
      let executionFailed = false;

      try {
        try {
          await instance.runPrompt(request.prompt);
        } catch (err: unknown) {
          executionError = err;
          executionFailed = true;
        } finally {
          if (timeoutTimer !== null) timeoutTimer.cancel();
          request.signal?.removeEventListener("abort", onSignalAbort);
        }

        const budgetSnapshot = instance.getBudgetSnapshot();
        taskLimitReason ??= budgetSnapshot.taskLimitReason;

        const completedAt = new Date().toISOString();
        const durationMs = Date.now() - promptStart;

        // Retrieve actual native session entries recorded by SDK SessionManager
        const rawEntries = instance.getNativeSessionEntries();

        if (
          options.faults?.simulateNativeSanitizerFailure &&
          (!options.faults.failConditionId || options.faults.failConditionId === request.conditionId)
        ) {
          throw new EvalError(
            "secret-quarantine",
            `unverifiable secret redaction in native session entry: simulated failure in ${request.conditionId}`,
            { at: `session:${request.conditionId}` },
          );
        }

        // Sanitize COPIES of actual entries (the live entries reused for the next model turn
        // are never touched). This is the only sanitization pass for the local path: the
        // durable native-prefix capture wrote its own sanitized copy from the streamed
        // structuredClone as each entry was appended, but never mutated these live entries.
        // If an unverifiable secret survives, sanitizeNativeSessionEntries throws
        // EvalError("secret-quarantine").
        const sanitizedResult = sanitizeNativeSessionEntries(
          rawEntries,
          request.guardedSecrets ?? [],
          { captureReasoning: request.captureReasoning },
        );

        // Derive transcripts and tool step views from the sanitized copy
        const derivedMessages = deriveMessagesFromNativeSession(sanitizedResult.entries);
        const derivedToolSteps = deriveToolStepsFromNativeSession(sanitizedResult.entries);

        const allMessages = instance.session.messages;
        const lastMsg = allMessages.filter((m: any) => m.role === "assistant").pop() as any;

      let infrastructureFailure: StructuredFailure | null = null;
      if (lastMsg) {
        if (lastMsg.stopReason === "length" && !taskLimitReason) {
          taskLimitReason = "length limit reached";
        } else if (lastMsg.stopReason === "error") {
          const errorMsg = String(lastMsg.errorMessage ?? executionError ?? "model execution error");
          if (errorMsg.includes("protocol-drift") || errorMsg.includes("drift_event")) {
            infrastructureFailure = {
              code: "protocol-drift",
              failureClass: "infrastructure",
              message: errorMsg,
              at: "pi.run",
            };
          } else {
            infrastructureFailure = {
              code: "provider-error",
              failureClass: "infrastructure",
              message: errorMsg,
              at: "pi.run",
            };
          }
        }
      }

      const cancellationError = (request.signal?.aborted || wallClockTimedOut) &&
        (executionError instanceof Error && executionError.name === "AbortError" ||
         executionError instanceof EvalError && executionError.code === "interrupted");
      if (!infrastructureFailure && executionFailed && !cancellationError) {
        const errMsg = executionError instanceof Error ? executionError.message : String(executionError);
        if (errMsg.includes("Thinking level") || errMsg.includes("400") || errMsg.includes("quota") || errMsg.includes("provider") || errMsg.includes("Synthetic upstream")) {
          infrastructureFailure = {
            code: "provider-error",
            failureClass: "infrastructure",
            message: errMsg,
            at: "pi.run",
          };
        } else {
          // Unknown SDK failures are infrastructure, never successful task completion.
          infrastructureFailure = toStructuredFailure(executionError, "protocol-drift");
        }
      }

      // Bounded messages
      const normalizedMessages: NormalizedMessage[] = derivedMessages.map((m) => {
        const trunc = truncateText(m.text);
        return {
          index: m.index,
          role: m.role,
          text: trunc.text,
          truncated: trunc.truncated,
        };
      });

      const usage: HarnessUsage = {
        inputTokens: budgetSnapshot.inputTokens,
        outputTokens: budgetSnapshot.outputTokens,
        cacheReadTokens: budgetSnapshot.cacheReadTokens,
        cacheWriteTokens: budgetSnapshot.cacheWriteTokens,
        providerRequests: budgetSnapshot.providerRequests,
        toolSteps: budgetSnapshot.toolSteps,
      };

      let outcome: HarnessOutcome = "completed";
      const failures: StructuredFailure[] = [];

      if (infrastructureFailure) {
        outcome = "infrastructure-failure";
        failures.push(infrastructureFailure);
      } else if (request.signal?.aborted && !(request.signal.reason instanceof Error && request.signal.reason.name === "ArmBudgetExceeded")) {
        throw new EvalError("interrupted", `prompt cancelled: ${String(request.signal.reason ?? "")}`);
      } else if (taskLimitReason !== null || wallClockTimedOut || request.signal?.aborted) {
        outcome = "task-limit";
      }

      // Precise, structured stop cause. A provider-native `length` truncation observed
      // while the output budget is unlimited resolves to `provider-response-length`, not
      // to a harness cumulative-output-token cause (see deriveStopCause).
      //
      // Classification uses the NORMALIZED stop reason (length/stop/error/...), but the
      // persisted `providerStopReason` preserves the RAW provider reason (e.g.
      // MAX_TOKENS/STOP) verbatim, falling back to the normalized reason only when no raw
      // reason was captured (backwards compatible).
      const normalizedStopReason = typeof lastMsg?.stopReason === "string" ? lastMsg.stopReason : null;
      const rawStopReason = typeof lastMsg?.rawStopReason === "string" ? lastMsg.rawStopReason : null;
      const providerStopReason = rawStopReason ?? normalizedStopReason;
      const terminalClass: TerminalClass = infrastructureFailure
        ? (infrastructureFailure.code === "interrupted" ? "interrupted" : "execution-failure")
        : outcome === "task-limit"
          ? "task-limit"
          : "completed";
      const semanticAbortForCause: "external" | "arm-budget" | null =
        (wallClockTimedOut || (request.signal?.reason instanceof Error && request.signal.reason.name === "ArmBudgetExceeded"))
          ? "arm-budget"
          : request.signal?.aborted
            ? "external"
            : null;
      const stopCause = deriveStopCause({ terminalClass, semanticAbortCause: semanticAbortForCause, taskLimitReason, stopReason: normalizedStopReason });

      return {
        outcome,
        stopCause,
        providerStopReason,
        messages: normalizedMessages,
        toolSteps: derivedToolSteps,
        usage,
        timing: { startedAt, completedAt, durationMs },
        runtime,
        failures,
        nativeSessionEntries: sanitizedResult.entries,
        nativeSessionRedactions: {
          count: sanitizedResult.count,
          entries: sanitizedResult.redactions,
        },
      };
    } finally {
      instance.dispose();
    }
  },
};
}
