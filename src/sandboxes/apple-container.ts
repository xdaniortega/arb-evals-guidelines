/**
 * The Apple Container sandbox: the only non-double implementation of `Sandbox`/`Guest`.
 *
 * WHY it is shaped like this:
 *
 * - **Exact identity, never a scan.** Every lookup and destruction names one identity.
 *   `container list` has no label filter and a pattern sweep would be able to destroy a
 *   resource this run never created, so nothing here ever enumerates.
 * - **The image lock is load-bearing.** A tag is mutable, so `buildImage` verifies the
 *   allowlisted build context against container/image-lock.json, builds, and then
 *   resolves a real content-addressed digest with `container image inspect`. Both arms
 *   of a pair run from that one digest, and `createGuest` re-reads the digest the
 *   runtime actually started so "same image" is observed rather than assumed.
 * - **Attestation is observed, never configured.** `attest()` reads /proc/1/status of
 *   the supervisor inside the guest, attempts a real write to `/`, reads the mount
 *   table, and probes egress. If any fact does not hold the guest is marked unusable and
 *   no credential can ever be delivered to it.
 * - **No credential in a run specification.** `container inspect` prints
 *   `configuration.initProcess.environment` verbatim, so a value passed with `--env`
 *   would be readable by anything that can talk to the runtime. A credential therefore
 *   reaches a guest only over the supervisor's in-memory control socket, after
 *   attestation, with the value arriving on stdin and only the variable NAME in argv.
 * - **Apple Container has no `--no-new-privileges` and no disk quota.** `no_new_privs`
 *   is obtained by `setpriv` in the guest entrypoint and then attested; the disk bound
 *   is the tmpfs set, constrained by the guest memory limit.
 */

import { scheduleTimeout, type DeadlineTimer } from "../core/timing.ts";
import { spawn } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { assertSafeRelativePath, canonicalJsonSha256, sha256Hex } from "../core/experiment.ts";
import { EvalError, assertNotAborted, resolveGuestTimeouts } from "../core/types.ts";
import { scanForSecrets } from "../core/secret-scan.ts";
import type { GuardedSecret } from "../core/secret-scan.ts";
import type {
  AllowedTcpPorts,
  CredentialDeliveryRequest,
  DestroyOutcome,
  ExportRequest,
  ExportedTree,
  Guest,
  GuestAttestation,
  GuestExecRequest,
  GuestExecResult,
  GuestStreamRequest,
  GuestStreamSession,
  GuestSpec,
  ImageIdentity,
  ImageSpec,
  NetworkIdentity,
  NetworkPolicy,
  ObservedAttestation,
  ObservedEgressProbe,
  ResourceKind,
  ResourceOwnership,
  Sandbox,
  SandboxProbe,
  StageRequest,
} from "./sandbox.ts";

/** Labels the producer of an observed attestation record. Never a test double here. */
export const APPLE_CONTAINER_ATTESTATION_SOURCE = "apple-container-guest";

/**
 * The environment entry through which the DECLARED public TCP port allowlist reaches the
 * guest, where it drives BOTH the iptables rule the entrypoint installs and the
 * expectation each public egress probe is judged against.
 *
 * Deriving both from one value is what prevents the declared policy and the enforced rule
 * from silently disagreeing. It carries no secret: it is a list of port numbers.
 */
export const ALLOWED_TCP_PORTS_VARIABLE = "EVAL_ALLOWED_TCP_PORTS";

/** Rejects anything that is not a plain TCP port or explicit "all", so a malformed list cannot be enforced. */
export function encodeAllowedTcpPorts(ports: AllowedTcpPorts, at: string): string {
  if (ports === "all") return "all";
  if (!Array.isArray(ports)) {
    throw new EvalError("input-invalid", `allowPublicTcpPorts must be 'all' or an array of ports`, { at });
  }
  const encoded = [...ports].sort((left, right) => left - right);
  for (const port of encoded) {
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
      throw new EvalError("input-invalid", `allowPublicTcpPorts contains a non-port value: ${String(port)}`, { at });
    }
  }
  if (encoded.length === 0) {
    throw new EvalError("input-invalid", `allowPublicTcpPorts must declare at least one port`, { at });
  }
  return encoded.join(",");
}

export const APPLE_CONTAINER_SANDBOX_ID = "apple-container";

/** The fixed non-root identity baked into the image and asserted by attestation. */
export const GUEST_UID = 10001;
export const GUEST_GID = 10001;

export const GUEST_ENTRYPOINT = "/opt/eval/configure-egress.sh";
export const GUEST_SUPERVISOR = "/opt/eval/run-measured.mjs";
/** tmpfs holding the control socket. Bounded, writable, and declared in attestation. */
export const GUEST_CONTROL_DIR = "/run/eval";

/**
 * Locked PUBLIC resolvers.
 *
 * The runtime's default `/etc/resolv.conf` nameserver is the network gateway, which is a
 * private address; the contract forbids inheriting a host or private resolver, so both
 * arms are given the same public resolvers explicitly.
 */
export const LOCKED_PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"] as const;

/** Platform the locked profile is built and run for. */
export const LOCKED_PLATFORM = "linux/arm64";

const DEFAULT_CLI = "container";
const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 96 * 1024 * 1024;
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 400;

// ---------------------------------------------------------------------------
// Bounded CLI invocation
// ---------------------------------------------------------------------------

export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export interface CliOptions {
  readonly cliPath?: string;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
  /** Absolute deadline; the command cap may only shorten the remaining time. */
  readonly deadlineAtMs?: number;
  /** Injectable only for deterministic CLI-boundary tests; defaults to node spawn. */
  readonly spawnProcess?: typeof spawn;
}

/**
 * @notice Executes the container CLI without a shell and bounds output and operation time.
 * @param args Container subcommand and arguments.
 * @param options Cancellation, deadline, output bounds, and process dependencies.
 * @returns Captured output and explicit exit or timeout status.
 * @dev Termination escalates from SIGTERM to SIGKILL before bounded settlement.
 */
export async function runContainerCli(args: readonly string[], options: CliOptions = {}): Promise<CliResult> {
  const commandCapMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const finiteDeadline = options.deadlineAtMs !== undefined && Number.isFinite(options.deadlineAtMs);
  if (finiteDeadline && options.deadlineAtMs! <= Date.now()) {
    throw new EvalError("interrupted", `container ${args[0] ?? ""} deadline expired before spawn`, { at: `container ${args[0] ?? ""}` });
  }
  const remainingMs = finiteDeadline ? options.deadlineAtMs! - Date.now() : undefined;
  const timeoutMs = remainingMs !== undefined
    ? (commandCapMs !== undefined && Number.isFinite(commandCapMs) ? Math.min(commandCapMs, remainingMs) : remainingMs)
    : commandCapMs;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  assertNotAborted(options.signal, `container ${args[0] ?? ""}`);
  return await new Promise<CliResult>((resolve, reject) => {
    // A separate process group lets cancellation terminate CLI descendants too.
    const child = (options.spawnProcess ?? spawn)(options.cliPath ?? DEFAULT_CLI, [...args], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let escalation: NodeJS.Timeout | null = null;
    let finalSettle: NodeJS.Timeout | null = null;
    let timer: DeadlineTimer | null = null;

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, signal); return; } catch { /* fall back to direct child */ }
      }
      try { child.kill(signal); } catch { /* already gone */ }
    };
    const kill = (): void => {
      signalGroup("SIGTERM");
      if (escalation === null) {
        escalation = setTimeout(() => signalGroup("SIGKILL"), 2_000);
        escalation.unref();
      }
      if (finalSettle === null) {
        // Kept referenced: a pending CLI promise must not let Node exit successfully.
        finalSettle = setTimeout(() => finish(null), 3_000);
      }
    };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) timer.cancel();
      if (escalation !== null) clearTimeout(escalation);
      if (finalSettle !== null) clearTimeout(finalSettle);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), truncated, timedOut, aborted });
    };
    if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = scheduleTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
    }
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Close the race between the entry assertion and listener registration.
    if (options.signal?.aborted) onAbort();

    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.byteLength;
      if (outBytes > maxOutputBytes) {
        truncated = true;
        kill();
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errBytes += chunk.byteLength;
      if (errBytes > maxOutputBytes) {
        truncated = true;
        return;
      }
      err.push(chunk);
    });
    child.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer !== null) timer.cancel();
      if (escalation !== null) clearTimeout(escalation);
      if (finalSettle !== null) clearTimeout(finalSettle);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code: number | null) => {
      finish(code);
    });

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Already-absent recognition
// ---------------------------------------------------------------------------

/**
 * The exact "this identity does not exist" shapes of Apple Container 1.2.2.
 *
 * They are matched precisely rather than by treating any non-zero exit as absence: a
 * runtime that is down, a permission problem, or an unexpected internal error must be a
 * cleanup FAILURE, not a silently benign "already gone".
 */
const ABSENT_PATTERNS: Readonly<Record<string, readonly RegExp[]>> = {
  "guest.inspect": [/container not found:/i],
  "guest.delete": [/notFound: "container with ID .* not found"/i, /container not found:/i],
  "network.inspect": [/network not found:/i],
  "network.delete": [/network not found:/i],
  "image.inspect": [/image not found:/i],
  "image.delete": [/image not found:/i],
};

function looksAbsent(key: string, result: CliResult): boolean {
  const patterns = ABSENT_PATTERNS[key] ?? [];
  const text = `${result.stderr}\n${result.stdout}`;
  return patterns.some((pattern) => pattern.test(text));
}

function cliFailure(at: string, args: readonly string[], result: CliResult): EvalError {
  const detail = (result.stderr.trim() === "" ? result.stdout : result.stderr).trim().slice(0, 1_000);
  return new EvalError(
    "platform-unsupported",
    `container ${args.join(" ")} failed (exit ${String(result.code)}${result.timedOut ? ", timed out" : ""}${result.aborted ? ", aborted" : ""}${result.truncated ? ", output truncated" : ""}): ${detail}`,
    { at },
  );
}

function parseJson(at: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error: unknown) {
    throw new EvalError("protocol-drift", `${at} did not return JSON`, { at, cause: error });
  }
}

function firstDigest(value: unknown): string | null {
  // `container image inspect` returns an array of records whose
  // configuration.descriptor.digest is the content address of the image index.
  if (!Array.isArray(value) || value.length === 0) return null;
  const record = value[0] as { configuration?: { descriptor?: { digest?: unknown } } };
  const digest = record.configuration?.descriptor?.digest;
  return typeof digest === "string" && /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
}

/** The image digest a RUNNING container was actually started from. */
function containerImageDigest(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const record = value[0] as {
    configuration?: { image?: { descriptor?: { digest?: unknown }; digest?: unknown } };
  };
  const image = record.configuration?.image;
  const digest = image?.descriptor?.digest ?? image?.digest;
  return typeof digest === "string" && /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
}

// ---------------------------------------------------------------------------
// Guest-side protocol frames
// ---------------------------------------------------------------------------

interface GuestFrame {
  readonly ok: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

function decodeFrame(at: string, result: CliResult): GuestFrame {
  if (result.aborted || result.timedOut || result.truncated || result.code !== 0) throw cliFailure(at, [], result);
  const lines = result.stdout.split("\n").filter((line) => line.trim().startsWith("{"));
  const last = lines[lines.length - 1];
  if (last === undefined) {
    throw new EvalError(
      "protocol-drift",
      `${at} produced no protocol frame (exit ${String(result.code)}): ${result.stderr.trim().slice(0, 500)}`,
      { at },
    );
  }
  const frame = parseJson(at, last) as GuestFrame;
  if (frame.ok !== true) {
    throw new EvalError("protocol-drift", `${at} failed in the guest: ${String(frame.error ?? "unknown")}`, { at });
  }
  return frame;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AppleContainerSandboxOptions {
  /**
   * The exact run identifier this sandbox may act within. Image references are derived
   * from it, so a lookup by digest resolves to one deterministic reference instead of
   * requiring a scan.
   */
  readonly runId: string;
  /** Labels attached to every created resource, for human inspection only. */
  readonly labels?: Readonly<Record<string, string>>;
  readonly cliPath?: string;
  readonly dnsServers?: readonly string[];
  /** Secrets the boundary loaded, so a run specification can be scanned for a leak. */
  readonly guardedSecrets?: readonly GuardedSecret[];
  readonly commandTimeoutMs?: number;
  /** Bounded supervisor lifetime; a guest that outlives its run is an isolation defect. */
  readonly supervisorMaxMs?: number;
  /** Overrides the readiness wait, for tests. */
  readonly readyTimeoutMs?: number;
  /** Injectable only for deterministic CLI-boundary tests; defaults to node spawn. */
  readonly spawnProcess?: typeof spawn;
}

function normalizedRunId(runId: string): string {
  const normalized = runId.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized === "") throw new EvalError("input-invalid", `runId does not yield a usable image reference: ${runId}`);
  return normalized.slice(0, 40);
}

// ---------------------------------------------------------------------------
// Image lock verification
// ---------------------------------------------------------------------------

interface LockedProfile {
  readonly platform: string;
  readonly baseDigest: string;
  readonly piVersion: string;
  readonly files: Readonly<Record<string, string>>;
}

/**
 * Reads the locked identity for a profile and proves the build context still matches it.
 *
 * This is the difference between "we built from a directory" and "we built the reviewed
 * recipe": an edited entrypoint or supervisor changes the guest's privilege and egress
 * behaviour, and would otherwise be invisible in evidence.
 */
async function loadLockedProfile(contextDir: string, runtimeProfileId: string): Promise<LockedProfile> {
  const lockPath = join(contextDir, "image-lock.json");
  const raw = await readFile(lockPath, "utf8").catch(() => null);
  if (raw === null) {
    throw new EvalError("evidence-invalid", `the build context has no image lock at ${lockPath}`, { at: lockPath });
  }
  const lock = parseJson(lockPath, raw) as {
    profiles?: Record<string, {
      platform?: unknown;
      base?: { digest?: unknown };
      buildContextFiles?: Record<string, unknown>;
      guestRuntime?: { artifactLock?: unknown; compiler?: { package?: unknown; version?: unknown }; sources?: Record<string, unknown>; artifacts?: Record<string, unknown> };
    }>;
  };
  const profile = lock.profiles?.[runtimeProfileId];
  if (profile === undefined) {
    throw new EvalError("evidence-invalid", `${lockPath} has no entry for runtime profile ${runtimeProfileId}`, {
      at: lockPath,
    });
  }
  const files: Record<string, string> = {};
  for (const [name, digest] of Object.entries(profile.buildContextFiles ?? {})) {
    if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new EvalError("evidence-invalid", `${lockPath} has an invalid digest for ${name}`, { at: lockPath });
    }
    const bytes = await readFile(join(contextDir, name)).catch(() => null);
    if (bytes === null) {
      throw new EvalError("evidence-invalid", `the locked build-context file ${name} is missing`, { at: name });
    }
    const actual = `sha256:${sha256Hex(bytes)}`;
    if (actual !== digest) {
      throw new EvalError(
        "evidence-invalid",
        `build-context file ${name} does not match container/image-lock.json (locked ${digest}, found ${actual}); update the lock deliberately`,
        { at: name },
      );
    }
    files[name] = digest;
  }
  const guestRuntime = profile.guestRuntime;
  if (
    guestRuntime?.artifactLock !== "guest-runtime/artifact-lock.json" ||
    guestRuntime.compiler?.package !== "typescript" ||
    guestRuntime.compiler.version !== "5.9.3" ||
    guestRuntime.sources === undefined
  ) {
    throw new EvalError("evidence-invalid", `${lockPath} has no valid locked guest runtime compiler/source closure`, { at: lockPath });
  }
  const artifactLockRaw = await readFile(join(contextDir, guestRuntime.artifactLock), "utf8");
  const artifactLock = parseJson(guestRuntime.artifactLock, artifactLockRaw) as {
    compiler?: { package?: unknown; version?: unknown };
    sources?: Record<string, unknown>;
    artifacts?: Record<string, unknown>;
  };
  if (
    artifactLock.compiler?.package !== guestRuntime.compiler.package ||
    artifactLock.compiler.version !== guestRuntime.compiler.version ||
    JSON.stringify(artifactLock.sources) !== JSON.stringify(guestRuntime.sources)
  ) {
    throw new EvalError("evidence-invalid", "guest runtime artifact lock disagrees with image-lock.json", { at: guestRuntime.artifactLock });
  }
  const lockedArtifacts = artifactLock.artifacts ?? {};
  if (JSON.stringify(lockedArtifacts) !== JSON.stringify(guestRuntime.artifacts)) {
    throw new EvalError("evidence-invalid", "guest runtime artifact set disagrees with image-lock.json", { at: guestRuntime.artifactLock });
  }
  const expectedRuntimeFiles = new Set([guestRuntime.artifactLock, ...Object.keys(lockedArtifacts)]);
  const expectedRuntimeDirs = new Set(["guest-runtime"]);
  for (const file of expectedRuntimeFiles) {
    if (!file.startsWith("guest-runtime/") || file.includes("..") || file.includes("\\")) {
      throw new EvalError("evidence-invalid", `guest runtime lock has an unsafe artifact path: ${file}`, { at: file });
    }
    let parent = file.slice(0, file.lastIndexOf("/"));
    while (parent.startsWith("guest-runtime")) {
      expectedRuntimeDirs.add(parent);
      if (parent === "guest-runtime") break;
      parent = parent.slice(0, parent.lastIndexOf("/"));
    }
  }
  const runtimeRoot = join(contextDir, "guest-runtime");
  const inspectRuntimeTree = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relativePath = `guest-runtime/${relative(runtimeRoot, absolute).split(sep).join("/")}`;
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
        throw new EvalError("evidence-invalid", `guest runtime contains a non-regular entry: ${relativePath}`, { at: relativePath });
      }
      if (metadata.isDirectory()) {
        if (!expectedRuntimeDirs.has(relativePath)) {
          throw new EvalError("evidence-invalid", `guest runtime contains an unexpected directory: ${relativePath}`, { at: relativePath });
        }
        await inspectRuntimeTree(absolute);
      } else if (!expectedRuntimeFiles.has(relativePath)) {
        // Refuse by metadata/path only: unexpected content is never opened.
        throw new EvalError("evidence-invalid", `guest runtime contains an unexpected file: ${relativePath}`, { at: relativePath });
      }
    }
  };
  const runtimeMetadata = await lstat(runtimeRoot).catch(() => null);
  if (runtimeMetadata === null || !runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink()) {
    throw new EvalError("evidence-invalid", "guest runtime root must be a real directory", { at: "guest-runtime" });
  }
  await inspectRuntimeTree(runtimeRoot);

  const lockedRuntimeContextFiles = Object.keys(profile.buildContextFiles ?? {}).filter((path) => path.startsWith("guest-runtime/"));
  if (lockedRuntimeContextFiles.length !== expectedRuntimeFiles.size || lockedRuntimeContextFiles.some((path) => !expectedRuntimeFiles.has(path))) {
    throw new EvalError("evidence-invalid", "image lock guest runtime file set is not exactly the artifact lock closure", { at: guestRuntime.artifactLock });
  }

  const repositoryRoot = join(contextDir, "..");
  const compilerPackage = parseJson(
    "node_modules/typescript/package.json",
    await readFile(join(repositoryRoot, "node_modules", "typescript", "package.json"), "utf8"),
  ) as { version?: unknown };
  if (compilerPackage.version !== guestRuntime.compiler.version) {
    throw new EvalError("evidence-invalid", `locked guest compiler ${String(guestRuntime.compiler.version)} is not installed`, { at: "typescript" });
  }
  for (const [sourcePath, digest] of Object.entries(guestRuntime.sources)) {
    if (!/^src\/[A-Za-z0-9_./-]+\.ts$/.test(sourcePath) || typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new EvalError("evidence-invalid", `guest runtime has an invalid source lock for ${sourcePath}`, { at: sourcePath });
    }
    const sourceBytes = await readFile(join(repositoryRoot, sourcePath)).catch(() => null);
    const actual = sourceBytes === null ? null : `sha256:${sha256Hex(sourceBytes)}`;
    if (actual !== digest) {
      throw new EvalError("evidence-invalid", `guest runtime source ${sourcePath} does not match its compiler lock`, { at: sourcePath });
    }
  }
  for (const [artifactPath, digest] of Object.entries(lockedArtifacts)) {
    if (profile.buildContextFiles?.[artifactPath] !== digest) {
      throw new EvalError("evidence-invalid", `guest runtime artifact ${artifactPath} is not image-locked`, { at: artifactPath });
    }
  }

  const baseDigest = profile.base?.digest;
  if (typeof baseDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(baseDigest)) {
    throw new EvalError("evidence-invalid", `${lockPath} has no valid base digest for ${runtimeProfileId}`, {
      at: lockPath,
    });
  }
  const pi = (profile as { pi?: { package?: unknown; version?: unknown } }).pi;
  if (
    pi === undefined ||
    pi.package !== "@earendil-works/pi-coding-agent" ||
    typeof pi.version !== "string" ||
    pi.version !== "0.85.0"
  ) {
    throw new EvalError(
      "evidence-invalid",
      `${lockPath} must pin @earendil-works/pi-coding-agent version 0.85.0`,
      { at: lockPath },
    );
  }
  const containerfileBytes = await readFile(join(contextDir, "Containerfile"), "utf8");
  const expectedInstall = new RegExp(
    `npm\\s+install\\s+-g(?:\\s+--save-exact)?\\s+${pi.package.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}@${pi.version}`,
  );
  if (!expectedInstall.test(containerfileBytes)) {
    throw new EvalError(
      "evidence-invalid",
      `Containerfile must install pinned Pi package ${pi.package}@${pi.version}`,
      { at: "Containerfile" },
    );
  }
  return {
    platform: typeof profile.platform === "string" ? profile.platform : LOCKED_PLATFORM,
    baseDigest,
    piVersion: pi.version,
    files,
  };
}

// ---------------------------------------------------------------------------
// Guest
// ---------------------------------------------------------------------------

export interface AppleContainerGuestContext {
  readonly spec: GuestSpec;
  readonly cliPath: string;
  readonly timeoutMs: number;
  readonly labels: readonly string[];
  /** The declared allowlist this guest was started with, e.g. "443". */
  readonly allowedTcpPorts: string;
  readonly deadlineAtMs?: number;
  readonly signal?: AbortSignal;
  readonly spawnProcess: typeof spawn;
  destroyed: boolean;
  attested: boolean;
  readonly deliveredCredentialVariables: string[];
  lastAttestation: GuestAttestation | null;
}

export class AppleContainerGuest implements Guest {
  readonly name: string;
  readonly networkName: string;
  readonly imageDigest: string;
  private readonly context: AppleContainerGuestContext;

  constructor(context: AppleContainerGuestContext) {
    this.name = context.spec.name;
    this.networkName = context.spec.networkName;
    this.imageDigest = context.spec.imageDigest;
    this.context = context;
  }

  /** Variable names delivered to this guest, for assertions. Never values. */
  get deliveredCredentialVariables(): readonly string[] {
    return [...this.context.deliveredCredentialVariables];
  }

  /** The last observed attestation, for evidence. Null until `attest()` succeeds. */
  get attestation(): GuestAttestation | null {
    return this.context.lastAttestation;
  }

  private assertAlive(): void {
    if (this.context.destroyed) {
      throw new EvalError("evidence-invalid", `guest ${this.name} was used after destruction`);
    }
  }

  /** Every guest-side call runs as the fixed non-root user, never as root. */
  private async execSupervisor(
    at: string,
    args: readonly string[],
    options: { stdin?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<GuestFrame> {
    const argv = [
      "exec",
      // `--interactive` keeps stdin open; without it a frame written to the child is
      // never seen by the guest and the supervisor reads an empty request.
      ...(options.stdin === undefined ? [] : ["--interactive"]),
      "--user",
      `${GUEST_UID}:${GUEST_GID}`,
      "--env",
      `EVAL_WRITABLE_PATHS=${writablePathsOf(this.context.spec).join(":")}`,
      // The same declared allowlist the entrypoint enforced, so an attestation probe's
      // expectation is derived from policy rather than restated here.
      "--env",
      `${ALLOWED_TCP_PORTS_VARIABLE}=${this.context.allowedTcpPorts}`,
      this.name,
      "node",
      GUEST_SUPERVISOR,
      ...args,
    ];
    const cli: CliOptions = {
      cliPath: this.context.cliPath,
      timeoutMs: options.timeoutMs ?? this.context.timeoutMs,
      ...(this.context.deadlineAtMs === undefined || !Number.isFinite(this.context.deadlineAtMs) ? {} : { deadlineAtMs: this.context.deadlineAtMs }),
    };
    const result = await runContainerCli(argv, {
      ...cli,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.signal === undefined && this.context.signal === undefined ? {} : { signal: options.signal ?? this.context.signal }),
    });
    if (result.code !== 0 && result.stdout.trim() === "") throw cliFailure(at, argv, result);
    return decodeFrame(at, result);
  }

  async stage(request: StageRequest): Promise<void> {
    this.assertAlive();
    assertNotAborted(request.signal, "stage");
    if (!request.destDir.startsWith("/") || request.destDir.includes("..") || request.destDir.includes("\0")) {
      throw new EvalError("path-unsafe", `stage.destDir must be a plain absolute guest path: ${request.destDir}`, {
        at: "stage.destDir",
      });
    }
    const files = request.files.map((file) => {
      assertNotAborted(request.signal, "stage");
      // Validated on the host as well as in the guest: an unsafe spelling must be
      // refused before it is ever sent, and with the same `path-unsafe` code the double
      // uses.
      return { path: assertSafeRelativePath(file.path, "stage.files[].path"), base64: file.base64, mode: file.mode };
    });
    await this.execSupervisor(
      "stage",
      ["stage"],
      {
        stdin: JSON.stringify({ destDir: request.destDir, readOnly: request.readOnly, files }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    );
  }

  async exec(request: GuestExecRequest): Promise<GuestExecResult> {
    this.assertAlive();
    assertNotAborted(request.signal, "exec");
    if (request.command.length === 0) {
      throw new EvalError("input-invalid", "exec.command must not be empty", { at: "exec.command" });
    }
    const argv = [
      "exec",
      "--user",
      `${GUEST_UID}:${GUEST_GID}`,
      "--workdir",
      request.cwd,
      this.name,
      ...request.command,
    ];
    const result = await runContainerCli(argv, {
      cliPath: this.context.cliPath,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    return {
      exitCode: result.code,
      stdout: result.stdout.slice(0, request.maxOutputBytes),
      stderr: result.stderr.slice(0, request.maxOutputBytes),
      truncated: result.truncated || result.stdout.length > request.maxOutputBytes,
      timedOut: result.timedOut || result.aborted,
    };
  }

  async execStream(request: GuestStreamRequest): Promise<GuestStreamSession> {
    this.assertAlive();
    assertNotAborted(request.signal, "execStream");
    if (request.command.length === 0) {
      throw new EvalError("input-invalid", "execStream.command must not be empty", { at: "execStream.command" });
    }
    const argv = [
      "exec",
      "--interactive",
      "--user",
      `${GUEST_UID}:${GUEST_GID}`,
      "--workdir",
      request.cwd,
      this.name,
      ...request.command,
    ];
    const child = this.context.spawnProcess(this.context.cliPath, argv, { stdio: ["pipe", "pipe", "pipe"], detached: true });

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid !== undefined) { try { process.kill(-child.pid, signal); return; } catch { /* direct fallback */ } }
      try { child.kill(signal); } catch { /* already gone */ }
    };
    let escalation: NodeJS.Timeout | null = null;
    let timer: DeadlineTimer | null = null;
    let settlementTimer: NodeJS.Timeout | null = null;
    let settled = false;
    let finish!: (code: number | null, reason?: "confirmed" | "forced") => void;
    const terminate = (): void => {
      if (settled) return;
      signalGroup("SIGTERM");
      if (escalation === null) {
        escalation = setTimeout(() => signalGroup("SIGKILL"), 1_000);
        escalation.unref();
        settlementTimer = setTimeout(() => finish(null, "forced"), 2_000);
      }
    };
    const onAbort = (): void => terminate();
    let resolveTermination!: (reason: "confirmed" | "forced") => void;
    const termination = new Promise<"confirmed" | "forced">((resolve) => { resolveTermination = resolve; });
    const exitCode = new Promise<number | null>((resolve) => {
      finish = (code, reason = "confirmed"): void => {
        if (settled) return;
        settled = true;
        timer?.cancel();
        if (escalation !== null) clearTimeout(escalation);
        if (settlementTimer !== null) clearTimeout(settlementTimer);
        request.signal?.removeEventListener("abort", onAbort);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        resolveTermination(reason);
        resolve(code);
      };
      child.once("close", (code: number | null) => finish(code, "confirmed"));
      child.once("error", () => finish(null, "confirmed"));
    });
    if (request.timeoutMs !== undefined && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0) {
      timer = scheduleTimeout(terminate, request.timeoutMs);
      timer.unref();
    }
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();

    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      kill: (sig?: NodeJS.Signals) => signalGroup(sig ?? "SIGTERM"),
      exitCode,
      termination,
    };
  }

  async exportFiles(request: ExportRequest): Promise<ExportedTree> {
    this.assertAlive();
    assertNotAborted(request.signal, "exportFiles");
    const frame = await this.execSupervisor(
      "exportFiles",
      [
        "export",
        "--root",
        request.root,
        "--max-files",
        String(request.maxFiles),
        "--max-file-bytes",
        String(request.maxFileBytes),
        "--max-total-bytes",
        String(request.maxTotalBytes),
      ],
      request.signal === undefined ? {} : { signal: request.signal },
    );
    const tree = frame.tree as ExportedTree | undefined;
    if (tree === undefined || !Array.isArray(tree.files)) {
      throw new EvalError("protocol-drift", "the guest export frame has no file tree", { at: "exportFiles" });
    }
    // Bounds are applied in the guest and re-checked here: an over-budget frame is
    // protocol drift, not something to silently accept.
    for (const file of tree.files) {
      if (file.bytes > request.maxFileBytes) {
        throw new EvalError("protocol-drift", `exported file ${file.path} exceeds the declared byte bound`, {
          at: file.path,
        });
      }
      if (sha256Hex(Buffer.from(file.base64, "base64")) !== file.sha256) {
        throw new EvalError("evidence-invalid", `exported file ${file.path} does not match its declared hash`, {
          at: file.path,
        });
      }
    }
    if (tree.files.length > request.maxFiles) {
      throw new EvalError("protocol-drift", "the guest exported more files than the declared bound", {
        at: "exportFiles",
      });
    }
    return { files: tree.files, truncated: tree.truncated === true, skipped: [...(tree.skipped ?? [])] };
  }

  /**
   * Reads REAL privilege, mount, and egress facts from inside the running guest.
   *
   * The load-bearing values come from /proc/1/status, i.e. the supervisor the entrypoint
   * exec'd after dropping privilege — not from this process, not from the GuestSpec, and
   * not from the runtime's own configuration. A violation makes the guest unusable and
   * permanently un-credentialable.
   */
  async attest(signal?: AbortSignal, deadlineAtMs?: number): Promise<GuestAttestation> {
    this.assertAlive();
    const finiteDeadline = deadlineAtMs !== undefined && Number.isFinite(deadlineAtMs);
    const frame = await this.execSupervisor("attest", ["attest"], {
      signal: signal ?? this.context.signal,
      timeoutMs: finiteDeadline ? Math.max(1, deadlineAtMs - Date.now()) : undefined,
    });
    const observed = frame.attestation as GuestAttestationFrame | undefined;
    if (observed === undefined) {
      throw new EvalError("protocol-drift", "the guest attestation frame is empty", { at: "attest" });
    }
    const allowedTcpPorts = this.context.allowedTcpPorts === "all" ? "all" : this.context.allowedTcpPorts.split(",").map(Number);
    const failures = attestationViolations(observed, this.context.spec, allowedTcpPorts);
    const record = toObservedAttestation(observed);
    const transportProbe = record.egressProbes.find((probe) => probe.category === "public" && probe.port === 443);
    const attestation: GuestAttestation = {
      uid: observed.init.uid ?? -1,
      gid: observed.init.gid ?? -1,
      noNewPrivileges: observed.init.noNewPrivs === true,
      capabilitiesDropped: /^0+$/.test(observed.init.capEff ?? "x"),
      readOnlyRoot: observed.readOnlyRoot.readOnly === true,
      hostMounts: [
        ...observed.hostBackedMounts.map((mount) => `${mount.fstype}:${mount.target}`),
        ...observed.unexpectedWritableMounts.map((mount) => `${mount.fstype}:${mount.target}`),
      ].sort(),
      egress: {
        publicDnsAllowed: observed.egress.dns.ok === true && transportProbe?.outcome === "connected",
        deniedRangesEnforced: record.egressProbes
          .filter((probe) => probe.expectation === "blocked")
          .every((probe) => probe.outcome === "blocked"),
        resolverInherited: record.anyResolverPrivate,
      },
      checkedAt: observed.checkedAt,
      // The full observation travels with the summary so the runner can seal it verbatim.
      observed: record,
    };
    if (failures.length > 0) {
      this.context.attested = false;
      this.context.lastAttestation = null;
      throw new EvalError(
        "platform-unsupported",
        `guest ${this.name} failed attestation and must not be used: ${failures.join("; ")}`,
        { at: this.name },
      );
    }
    this.context.attested = true;
    this.context.lastAttestation = attestation;
    return attestation;
  }

  /**
   * Delivers one credential over the supervisor's control socket, in memory.
   *
   * Refused before a successful `attest()`, exactly as the double is. The value travels
   * on stdin: `container inspect` prints the init process environment verbatim, so
   * `--env`, `--env-file`, and argv are all disqualified transports.
   */
  async deliverCredential(request: CredentialDeliveryRequest): Promise<void> {
    this.assertAlive();
    if (!this.context.attested) {
      throw new EvalError(
        "secret-quarantine",
        `guest ${this.name} must be attested before a credential is delivered`,
        { at: request.variable },
      );
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(request.variable)) {
      throw new EvalError(
        "secret-quarantine",
        `credential variable name is not an allowlisted environment entry: ${request.variable}`,
        { at: request.variable },
      );
    }
    if (request.value === "") {
      throw new EvalError("credential-missing", `credential ${request.variable} has an empty value`, {
        at: request.variable,
      });
    }
    const finiteDeadline = request.deadlineAtMs !== undefined && Number.isFinite(request.deadlineAtMs);
    await this.execSupervisor("deliverCredential", ["deliver-credential", "--variable", request.variable], {
      stdin: JSON.stringify({ value: request.value }),
      signal: request.signal ?? this.context.signal,
      timeoutMs: finiteDeadline ? Math.max(1, request.deadlineAtMs! - Date.now()) : undefined,
    });
    // Only the NAME is retained, here and in evidence.
    this.context.deliveredCredentialVariables.push(request.variable);
  }

  async destroy(): Promise<DestroyOutcome> {
    if (this.context.destroyed) return { status: "already-absent", verified: true, failure: null };
    const outcome = await destroyGuest(this.context.cliPath, this.context.timeoutMs, this.name);
    if (outcome.status !== "failed") this.context.destroyed = true;
    return outcome;
  }
}

interface GuestMountFrame {
  readonly fstype: string;
  readonly target: string;
  readonly source: string;
  readonly readOnly?: boolean;
}

interface GuestProbeFrame {
  readonly label: string;
  readonly category: string;
  readonly protocol: string;
  readonly host: string;
  readonly port: number;
  readonly expectation: string;
  readonly outcome: string;
  readonly detail: string;
  readonly durationMs: number;
}

interface GuestAttestationFrame {
  readonly checkedAt: string;
  readonly init: {
    uid: number | null;
    gid: number | null;
    groups: number[];
    capEff: string | null;
    capPrm?: string | null;
    noNewPrivs: boolean;
  };
  readonly self: { uid: number | null; gid: number | null; groups: number[] };
  readonly readOnlyRoot: { readOnly: boolean; detail: string };
  readonly declaredWritablePaths: readonly string[];
  readonly mountCount?: number;
  readonly hostBackedMounts: readonly GuestMountFrame[];
  readonly unexpectedWritableMounts: readonly GuestMountFrame[];
  readonly resolvers: ReadonlyArray<{ address: string; private: boolean }>;
  readonly egress: {
    readonly allowedTcpPorts: AllowedTcpPorts;
    readonly probes: readonly GuestProbeFrame[];
    readonly dns: { ok: boolean; detail: string; durationMs: number };
  };
}

function probeOutcome(value: string): ObservedEgressProbe["outcome"] {
  return value === "connected" || value === "blocked" ? value : "inconclusive";
}

/**
 * Projects the guest's raw frame into the sealed observation record.
 *
 * Every field is given an explicit value: `canonicalJson` rejects `undefined`, and a
 * silently absent field would be indistinguishable from an observation that was never
 * made. Nothing is summarised away — this is the record a later reader compares against
 * `inputs/policy.json`.
 */
function toObservedAttestation(frame: GuestAttestationFrame): ObservedAttestation {
  const mount = (entry: GuestMountFrame): { source: string; target: string; fstype: string; readOnly: boolean } => ({
    source: entry.source ?? "",
    target: entry.target ?? "",
    fstype: entry.fstype ?? "",
    readOnly: entry.readOnly === true,
  });
  const probes: ObservedEgressProbe[] = (frame.egress.probes ?? []).map((probe) => ({
    label: String(probe.label),
    category: probe.category as ObservedEgressProbe["category"],
    protocol: probe.protocol as "tcp" | "udp",
    host: String(probe.host),
    port: Number(probe.port),
    expectation: probe.expectation === "connected" ? "connected" : "blocked",
    outcome: probeOutcome(String(probe.outcome)),
    detail: String(probe.detail),
    durationMs: Number(probe.durationMs),
  }));
  const resolvers = frame.resolvers.map((resolver) => ({
    address: String(resolver.address),
    private: resolver.private === true,
  }));
  return {
    source: APPLE_CONTAINER_ATTESTATION_SOURCE,
    testDouble: false,
    checkedAt: frame.checkedAt,
    init: {
      uid: frame.init.uid ?? null,
      gid: frame.init.gid ?? null,
      groups: [...frame.init.groups],
      capEff: frame.init.capEff ?? null,
      capPrm: frame.init.capPrm ?? null,
      noNewPrivs: frame.init.noNewPrivs === true,
    },
    self: { uid: frame.self.uid ?? null, gid: frame.self.gid ?? null, groups: [...frame.self.groups] },
    readOnlyRootProbe: { readOnly: frame.readOnlyRoot.readOnly === true, detail: String(frame.readOnlyRoot.detail) },
    declaredWritablePaths: [...frame.declaredWritablePaths],
    mountCount: typeof frame.mountCount === "number" ? frame.mountCount : -1,
    hostBackedMounts: frame.hostBackedMounts.map(mount),
    unexpectedWritableMounts: frame.unexpectedWritableMounts.map(mount),
    resolvers,
    anyResolverPrivate: resolvers.some((resolver) => resolver.private),
    allowedTcpPorts: frame.egress.allowedTcpPorts === "all"
      ? "all"
      : [...(frame.egress.allowedTcpPorts ?? [])],
    egressProbes: probes,
    dnsProbe: {
      ok: frame.egress.dns.ok === true,
      detail: String(frame.egress.dns.detail),
      durationMs: Number(frame.egress.dns.durationMs ?? -1),
    },
  };
}

/** Every fact the contract requires, checked against what the guest actually reported. */
function attestationViolations(observed: GuestAttestationFrame, spec: GuestSpec, allowedTcpPorts: AllowedTcpPorts): readonly string[] {
  const failures: string[] = [];
  if (observed.init.uid !== GUEST_UID) failures.push(`PID 1 uid is ${String(observed.init.uid)}, expected ${GUEST_UID}`);
  if (observed.init.gid !== GUEST_GID) failures.push(`PID 1 gid is ${String(observed.init.gid)}, expected ${GUEST_GID}`);
  if (observed.init.groups.length > 0) {
    failures.push(`PID 1 has supplementary groups ${observed.init.groups.join(",")}`);
  }
  if (observed.self.uid !== GUEST_UID || observed.self.gid !== GUEST_GID) {
    failures.push(`guest command runs as ${String(observed.self.uid)}:${String(observed.self.gid)}`);
  }
  if (observed.self.groups.some((group) => group !== GUEST_GID)) {
    failures.push(`guest command has extra supplementary groups ${observed.self.groups.join(",")}`);
  }
  if (!/^0+$/.test(observed.init.capEff ?? "x")) failures.push(`PID 1 CapEff is ${String(observed.init.capEff)}`);
  if (observed.init.noNewPrivs !== true) failures.push("PID 1 NoNewPrivs is not set");
  if (spec.policy.readOnlyRoot && observed.readOnlyRoot.readOnly !== true) {
    failures.push(`the root filesystem is writable (${observed.readOnlyRoot.detail})`);
  }
  if (observed.hostBackedMounts.length > 0) {
    failures.push(`host-backed mount(s): ${observed.hostBackedMounts.map((mount) => mount.target).join(",")}`);
  }
  if (observed.unexpectedWritableMounts.length > 0) {
    failures.push(
      `writable mount(s) outside the declared bounded paths: ${observed.unexpectedWritableMounts.map((mount) => mount.target).join(",")}`,
    );
  }
  if (observed.resolvers.length === 0) failures.push("no resolver is configured");
  for (const resolver of observed.resolvers) {
    if (resolver.private) failures.push(`a private resolver was inherited: ${resolver.address}`);
  }
  failures.push(...egressProbeViolations(observed.egress.probes, allowedTcpPorts));
  if (observed.egress.dns.ok !== true) failures.push(`public name resolution failed: ${observed.egress.dns.detail}`);
  return failures;
}

/**
 * @notice Rejects missing or contradictory guest network-isolation observations.
 * @param probes Guest-reported destination and transport probe results.
 * @param ports Public TCP ports allowed by the host policy.
 * @returns Policy violations, empty only when every required observation agrees.
 */
export function egressProbeViolations(probes: readonly GuestProbeFrame[], ports: AllowedTcpPorts): readonly string[] {
  const required = [
    { label: "metadata", category: "private", protocol: "tcp", host: "169.254.169.254", port: 80 },
    { label: "private-10", category: "private", protocol: "tcp", host: "10.0.0.1", port: 80 },
    { label: "private-192", category: "private", protocol: "tcp", host: "192.168.64.1", port: 53 },
    { label: "guest-loopback", category: "private", protocol: "tcp", host: "127.0.0.1", port: 22 },
    { label: "public-80", category: "public", protocol: "tcp", host: "1.1.1.1", port: 80 },
    { label: "public-443", category: "public", protocol: "tcp", host: "1.1.1.1", port: 443 },
    { label: "ipv4-multicast", category: "multicast", protocol: "udp", host: "239.255.42.99", port: 9 },
    { label: "ipv4-broadcast", category: "broadcast", protocol: "udp", host: "255.255.255.255", port: 9 },
    { label: "ipv6-loopback", category: "ipv6", protocol: "udp", host: "::1", port: null },
  ];
  const failures: string[] = [];
  if (probes.length !== required.length) failures.push(`expected ${required.length} egress probes, received ${probes.length}`);
  for (const expected of required) {
    const matches = probes.filter((probe) => probe.label === expected.label);
    if (matches.length !== 1) {
      failures.push(`expected one egress probe ${expected.label}, received ${matches.length}`);
      continue;
    }
    const probe = matches[0]!;
    const expectation = expected.category === "public" && (ports === "all" || ports.includes(expected.port!)) ? "connected" : "blocked";
    const portMatches = expected.port === null ? Number.isInteger(probe.port) && probe.port > 0 && probe.port <= 65_535 : probe.port === expected.port;
    if (probe.category !== expected.category || probe.protocol !== expected.protocol || probe.host !== expected.host || !portMatches) {
      failures.push(`egress probe ${probe.label} has the wrong destination or transport`);
    }
    if (probe.expectation !== expectation || probe.outcome !== expectation) {
      failures.push(`egress probe ${probe.label} ${probe.host}:${String(probe.port)} was ${probe.outcome}, expected ${expectation} (${probe.detail})`);
    }
  }
  return failures;
}

function writablePathsOf(spec: GuestSpec): readonly string[] {
  const paths = [...spec.policy.writablePaths];
  if (!paths.includes(GUEST_CONTROL_DIR)) paths.push(GUEST_CONTROL_DIR);
  return paths;
}

// ---------------------------------------------------------------------------
// Destruction helpers (exact identity only)
// ---------------------------------------------------------------------------

async function destroyGuest(cliPath: string, timeoutMs: number, name: string, signal?: AbortSignal): Promise<DestroyOutcome> {
  const args = ["delete", "--force", name];
  const result = await runContainerCli(args, { cliPath, timeoutMs, signal });
  if (result.code === 0) return { status: "destroyed", verified: true, failure: null };
  if (looksAbsent("guest.delete", result)) return { status: "already-absent", verified: true, failure: null };
  return {
    status: "failed",
    verified: false,
    failure: {
      code: "cleanup-failed",
      failureClass: "infrastructure",
      message: `destroying guest ${name} failed: ${result.stderr.trim().slice(0, 500)}`,
      at: name,
    },
  };
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export interface AppleContainerSandbox extends Sandbox {
  /** The reference this sandbox built for a digest, if it built one. Never a scan. */
  imageReferenceFor(digest: string): string | null;
}

/**
 * @notice Instantiates an Apple Container sandbox manager enforcing guest isolation, egress firewall rules, and deterministic image tags.
 * @param options Sandbox options configuring container CLI path, timeouts, DNS resolvers, labels, and secret redaction.
 * @returns Configured Apple Container sandbox instance capable of managing container images, guest lifecycles, and network policies.
 * @dev Container network egress filtering uses the identical declared policy that is hashed into the parity binding, and image references are deterministically derived from the run ID and recipe digest without filesystem scanning.
 */
export function createAppleContainerSandbox(options: AppleContainerSandboxOptions): AppleContainerSandbox {
  const cliPath = options.cliPath ?? DEFAULT_CLI;
  const timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const dnsServers = options.dnsServers ?? [...LOCKED_PUBLIC_RESOLVERS];
  const guardedSecrets = options.guardedSecrets ?? [];
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const spawnProcess = options.spawnProcess ?? spawn;
  const labels = Object.entries(options.labels ?? { "eval-run": options.runId }).map(
    ([key, value]) => `${key}=${value}`,
  );
  /** digest -> reference this instance built. Cleanup and lookup never scan. */
  const references = new Map<string, string>();
  /**
   * network name -> the DECLARED policy it was created with.
   *
   * A guest's enforced egress rule is derived from this, so the rule the guest installs
   * and the policy hashed into the parity binding are one value, not two that happen to
   * agree.
   */
  const networkPolicies = new Map<string, NetworkPolicy>();

  const recipeDigestFor = (locked: LockedProfile): string => canonicalJsonSha256(locked);

  const referenceFor = (runtimeProfileId: string, recipeDigest?: string): string =>
    recipeDigest !== undefined
      ? `eval-cached-${runtimeProfileId}:${recipeDigest.slice(0, 16)}`
      : `eval-${normalizedRunId(options.runId)}:${runtimeProfileId}`;

  /**
   * Resolves the single exact reference an image identity can have in this run.
   *
   * `container image inspect` cannot take a bare digest, so a digest is resolved through
   * the reference this run built (or would have built). That is still exact identity:
   * one deterministic name derived from the journaled run id, never an enumeration.
   */
  const resolveImageReference = async (name: string, signal?: AbortSignal): Promise<{ reference: string; digest: string | null } | null> => {
    const known = references.get(name);
    if (known !== undefined) return { reference: known, digest: name };
    if (!name.startsWith("sha256:")) return { reference: name, digest: null };
    for (const profileId of ["default"]) {
      const reference = referenceFor(profileId);
      const inspect = await runContainerCli(["image", "inspect", reference], { cliPath, spawnProcess, timeoutMs, signal });
      if (inspect.code !== 0) continue;
      const digest = firstDigest(parseJson("container image inspect", inspect.stdout));
      if (digest === name) return { reference, digest };
    }
    return null;
  };

  const sandbox: AppleContainerSandbox = {
    id: APPLE_CONTAINER_SANDBOX_ID,
    // The whole point of this implementation: evidence produced with it is not
    // test-double evidence.
    testDouble: false,

    imageReferenceFor(digest: string): string | null {
      return references.get(digest) ?? null;
    },

    /** Reports NOT-ready rather than throwing: a missing runtime is a normal answer. */
    async probe(signal?: AbortSignal): Promise<SandboxProbe> {
      const details: Array<{ name: string; status: "ok" | "missing" | "unsupported"; detail: string }> = [];
      let version: CliResult | null = null;
      try {
        version = await runContainerCli(["--version"], { cliPath, spawnProcess, timeoutMs: 15_000, signal });
      } catch (error: unknown) {
        details.push({
          name: "container-cli",
          status: "missing",
          detail: `the ${cliPath} CLI could not be executed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (version !== null) {
        details.push(
          version.code === 0
            ? { name: "container-cli", status: "ok", detail: version.stdout.trim().slice(0, 200) }
            : { name: "container-cli", status: "missing", detail: version.stderr.trim().slice(0, 200) },
        );
        const status = await runContainerCli(["system", "status"], { cliPath, spawnProcess, timeoutMs: 30_000, signal }).catch(() => null);
        assertNotAborted(signal, "sandbox probe");
        if (status === null || status.code !== 0) {
          details.push({
            name: "container-system",
            status: "unsupported",
            detail: "container system status did not succeed; start the runtime with `container system start`",
          });
        } else if (/status\s+running/.test(status.stdout)) {
          details.push({ name: "container-system", status: "ok", detail: "container system status reports running" });
        } else {
          details.push({
            name: "container-system",
            status: "unsupported",
            detail: `container system status is not running: ${status.stdout.trim().slice(0, 200)}`,
          });
        }
      }
      return { ready: details.length > 0 && details.every((entry) => entry.status === "ok"), details };
    },

    async buildImage(spec: ImageSpec): Promise<ImageIdentity> {
      assertNotAborted(spec.signal, "buildImage");
      const locked = await loadLockedProfile(spec.contextDir, spec.runtimeProfileId);
      assertNotAborted(spec.signal, "buildImage");
      const recipeDigest = recipeDigestFor(locked);
      const reference = referenceFor(spec.runtimeProfileId, recipeDigest);

      // Reuse a warm image only under the reference derived from the verified recipe.
      const inspectExisting = await runContainerCli(["image", "inspect", reference], { cliPath, spawnProcess, timeoutMs, signal: spec.signal, deadlineAtMs: spec.deadlineAtMs });
      if (inspectExisting.code === 0) {
        const existingDigest = firstDigest(parseJson("container image inspect", inspectExisting.stdout));
        if (existingDigest !== null) {
          references.set(existingDigest, reference);
          return { reference, digest: existingDigest, runtimeProfileId: spec.runtimeProfileId, testDouble: false, cacheHit: true };
        }
      }

      spec.onBuildStarted?.();
      const buildArgs = [
        "build",
        "--platform",
        locked.platform,
        "--tag",
        reference,
        "--file",
        join(spec.contextDir, "Containerfile"),
        ...labels.flatMap((label) => ["--label", label]),
        spec.contextDir,
      ];
      const build = await runContainerCli(buildArgs, { cliPath, spawnProcess, timeoutMs, signal: spec.signal, deadlineAtMs: spec.deadlineAtMs });
      if (build.code !== 0) throw cliFailure("buildImage", buildArgs, build);
      const inspectArgs = ["image", "inspect", reference];
      const inspect = await runContainerCli(inspectArgs, { cliPath, spawnProcess, timeoutMs, signal: spec.signal, deadlineAtMs: spec.deadlineAtMs });
      if (inspect.code !== 0) throw cliFailure("buildImage.inspect", inspectArgs, inspect);
      const digest = firstDigest(parseJson("container image inspect", inspect.stdout));
      if (digest === null) {
        throw new EvalError("evidence-invalid", `no content-addressed digest was resolved for ${reference}`, {
          at: reference,
        });
      }
      references.set(digest, reference);
      return { reference, digest, runtimeProfileId: spec.runtimeProfileId, testDouble: false, cacheHit: false };
    },

    async createNetwork(name: string, policy: NetworkPolicy, signal?: AbortSignal, deadlineAtMs?: number): Promise<NetworkIdentity> {
      // The network object itself carries no policy: Apple Container networks have no
      // egress rules. The policy is enforced inside the guest by the entrypoint's
      // iptables lock and is verified by attestation, so the hash recorded here binds
      // the INTENDED policy to the pair, and attestation proves it held.
      const args = ["network", "create", ...labels.flatMap((label) => ["--label", label]), name];
      // Validated before creation: an unusable allowlist must fail here rather than
      // produce a guest whose entrypoint refuses to start.
      encodeAllowedTcpPorts(policy.allowPublicTcpPorts, `network ${name}.allowPublicTcpPorts`);
      const result = await runContainerCli(args, { cliPath, spawnProcess, timeoutMs, signal, deadlineAtMs });
      if (result.code !== 0 || result.aborted || result.timedOut || result.truncated) throw cliFailure("createNetwork", args, result);
      networkPolicies.set(name, policy);
      return { name, policySha256: canonicalJsonSha256(policy) };
    },

    async destroyNetwork(name: string, signal?: AbortSignal): Promise<DestroyOutcome> {
      // Apple Container 1.2.2's delete error for a missing network is generic and does
      // not name the absent identity. Inspect the exact identity first so absence is
      // proven without treating an arbitrary delete failure as benign.
      const before = await runContainerCli(["network", "inspect", name], { cliPath, spawnProcess, timeoutMs, signal });
      if (before.code !== 0 && looksAbsent("network.inspect", before)) {
        networkPolicies.delete(name);
        return { status: "already-absent", verified: true, failure: null };
      }
      if (before.code !== 0) {
        return {
          status: "failed",
          verified: false,
          failure: { code: "cleanup-failed", failureClass: "infrastructure", message: `inspecting network ${name} before destruction failed: ${before.stderr.trim().slice(0, 500)}`, at: name },
        };
      }
      const args = ["network", "delete", name];
      const result = await runContainerCli(args, { cliPath, spawnProcess, timeoutMs, signal });
      if (result.code === 0) {
        networkPolicies.delete(name);
        return { status: "destroyed", verified: true, failure: null };
      }
      if (looksAbsent("network.delete", result)) {
        networkPolicies.delete(name);
        return { status: "already-absent", verified: true, failure: null };
      }
      return {
        status: "failed",
        verified: false,
        failure: {
          code: "cleanup-failed",
          failureClass: "infrastructure",
          message: `destroying network ${name} failed: ${result.stderr.trim().slice(0, 500)}`,
          at: name,
        },
      };
    },

    async createGuest(spec: GuestSpec): Promise<Guest> {
      if (spec.policy.uid !== GUEST_UID || spec.policy.gid !== GUEST_GID) {
        throw new EvalError(
          "platform-unsupported",
          `the locked image runs as ${GUEST_UID}:${GUEST_GID}; the requested policy asks for ${spec.policy.uid}:${spec.policy.gid}`,
          { at: spec.name },
        );
      }
      if (!spec.policy.readOnlyRoot || !spec.policy.noNewPrivileges || !spec.policy.dropCapabilities) {
        throw new EvalError(
          "platform-unsupported",
          "this sandbox only runs guests with a read-only root, no-new-privileges, and dropped capabilities",
          { at: spec.name },
        );
      }
      // A credential must never reach a run specification: `container inspect` prints the
      // init process environment verbatim. The name heuristic is a cheap first filter;
      // the guarded-secret value scan is what catches a real secret in a benign name.
      for (const [key, value] of Object.entries(spec.env)) {
        if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) {
          throw new EvalError(
            "secret-quarantine",
            `guest environment must not carry a credential-shaped variable: ${key}`,
            { at: key },
          );
        }
        if (guardedSecrets.length > 0) {
          const hits = scanForSecrets({ path: `guestSpec.env.${key}`, content: value }, guardedSecrets);
          if (hits.length > 0) {
            throw new EvalError(
              "secret-quarantine",
              `guest environment variable ${key} contains a guarded secret (${hits[0]?.label ?? "unknown"}, ${hits[0]?.encoding ?? "raw"})`,
              { at: key },
            );
          }
        }
      }
      const reference = references.get(spec.imageDigest);
      if (reference === undefined) {
        throw new EvalError(
          "evidence-invalid",
          `guest ${spec.name} requires an image digest built by this sandbox: ${spec.imageDigest}`,
          { at: spec.name },
        );
      }
      const declaredPolicy = networkPolicies.get(spec.networkName);
      if (declaredPolicy === undefined) {
        throw new EvalError(
          "evidence-invalid",
          `guest ${spec.name} must run on a network this sandbox declared a policy for: ${spec.networkName}`,
          { at: spec.name },
        );
      }
      const allowedTcpPorts = encodeAllowedTcpPorts(
        declaredPolicy.allowPublicTcpPorts,
        `network ${spec.networkName}.allowPublicTcpPorts`,
      );
      const writablePaths = writablePathsOf(spec);
      // Zero explicitly disables the supervisor lifetime for an unlimited arm.
      // An explicit deadline still bounds short-lived doctor/validation guests.
      const supervisorAllowanceMs = options.supervisorMaxMs ?? resolveGuestTimeouts(spec.limits.wallClockMs).supervisorMs;
      const supervisorDeadlineWindowMs = spec.deadlineAtMs === undefined || !Number.isFinite(spec.deadlineAtMs)
        ? Number.POSITIVE_INFINITY
        : Math.max(1, spec.deadlineAtMs - Date.now());
      const supervisorLifetimeMs = Math.min(supervisorAllowanceMs ?? Number.POSITIVE_INFINITY, supervisorDeadlineWindowMs);
      const args = [
        "run",
        "--detach",
        "--name",
        spec.name,
        "--network",
        spec.networkName,
        "--read-only",
        ...writablePaths.flatMap((path) => ["--tmpfs", path]),
        "--cpus",
        String(spec.limits.cpus),
        "--memory",
        `${String(spec.limits.memoryMiB)}M`,
        "--ulimit",
        `nproc=${String(spec.limits.pids)}`,
        ...dnsServers.flatMap((server) => ["--dns", server]),
        // NET_ADMIN exists only so the entrypoint can install the egress lock, and
        // SETUID/SETGID only so it can drop to the fixed non-root user. All three are
        // surrendered by that privilege drop: attestation reads CapEff 0 from PID 1.
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
        ...Object.entries(spec.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        "--env",
        `EVAL_WRITABLE_PATHS=${writablePaths.join(":")}`,
        "--env",
        `EVAL_SUPERVISOR_MAX_MS=${String(Number.isFinite(supervisorLifetimeMs) ? supervisorLifetimeMs : 0)}`,
        // Derived from the declared network policy: the entrypoint's iptables rule and
        // every public egress probe expectation both read this one value.
        "--env",
        `${ALLOWED_TCP_PORTS_VARIABLE}=${allowedTcpPorts}`,
        reference,
        "node",
        GUEST_SUPERVISOR,
        "supervise",
      ];
      const run = await runContainerCli(args, { cliPath, spawnProcess, timeoutMs, signal: spec.signal, deadlineAtMs: spec.deadlineAtMs });
      if (run.code !== 0 || run.aborted || run.timedOut || run.truncated) throw cliFailure("createGuest", args, run);

      // The digest the RUNTIME started, not the one we asked for. This is what makes
      // "both arms ran from one image digest" an observation.
      const inspect = await runContainerCli(["inspect", spec.name], { cliPath, spawnProcess, timeoutMs, signal: spec.signal, deadlineAtMs: spec.deadlineAtMs });
      if (inspect.code !== 0) throw cliFailure("createGuest.inspect", ["inspect", spec.name], inspect);
      const started = containerImageDigest(parseJson("container inspect", inspect.stdout));
      if (started !== null && started !== spec.imageDigest) {
        throw new EvalError(
          "evidence-invalid",
          `guest ${spec.name} started from ${started} but the pair is bound to ${spec.imageDigest}`,
          { at: spec.name },
        );
      }

      // Wait for the supervisor to be listening. Until then the control channel does not
      // exist and attestation would report the absence of a guest, not its properties.
      const deadline = Math.min(Date.now() + readyTimeoutMs, spec.deadlineAtMs ?? Number.POSITIVE_INFINITY);
      let ready = false;
      let lastDetail = "the supervisor never became ready";
      while (Date.now() < deadline) {
        const probe = await runContainerCli(
          ["exec", "--user", `${GUEST_UID}:${GUEST_GID}`, spec.name, "cat", `${GUEST_CONTROL_DIR}/ready`],
          { cliPath, spawnProcess, timeoutMs: 20_000, signal: spec.signal, deadlineAtMs: deadline },
        );
        if (probe.code === 0 && probe.stdout.trim() !== "") {
          ready = true;
          break;
        }
        lastDetail = (probe.stderr.trim() === "" ? probe.stdout : probe.stderr).trim().slice(0, 300);
        await new Promise((resolve) => setTimeout(resolve, Math.min(READY_POLL_MS, Math.max(1, deadline - Date.now()))));
      }
      if (!ready) {
        const logs = spec.signal?.aborted || Date.now() >= deadline ? null : await runContainerCli(["logs", spec.name], { cliPath, spawnProcess, timeoutMs: 20_000, signal: spec.signal, deadlineAtMs: deadline }).catch(() => null);
        throw new EvalError(
          "platform-unsupported",
          `guest ${spec.name} never became ready: ${lastDetail}${logs === null ? "" : ` | logs: ${logs.stdout.trim().slice(0, 300)}${logs.stderr.trim().slice(0, 300)}`}`,
          { at: spec.name },
        );
      }

      return new AppleContainerGuest({
        spec,
        cliPath,
        timeoutMs,
        labels,
        allowedTcpPorts,
        ...(spec.deadlineAtMs === undefined || !Number.isFinite(spec.deadlineAtMs) ? {} : { deadlineAtMs: spec.deadlineAtMs }),
        ...(spec.signal === undefined ? {} : { signal: spec.signal }),
        destroyed: false,
        attested: false,
        deliveredCredentialVariables: [],
        lastAttestation: null,
        spawnProcess: options.spawnProcess ?? spawn,
      });
    },

    async inspectResourceOwnership(kind: ResourceKind, name: string, expectedLabels: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<ResourceOwnership> {
      if (kind === "image") return { status: "unknown", labels: {}, reason: "shared image ownership is not used for recovery destruction" };
      const args = kind === "network" ? ["network", "inspect", name] : ["inspect", name];
      const result = await runContainerCli(args, { cliPath, spawnProcess, timeoutMs, signal });
      if (result.code !== 0) {
        if (looksAbsent(`${kind}.inspect`, result)) return { status: "unknown", labels: {}, reason: "resource is absent" };
        return { status: "unknown", labels: {}, reason: `exact ${kind} ownership metadata could not be inspected` };
      }
      let inspected: unknown;
      try { inspected = parseJson(`${kind} inspect`, result.stdout); }
      catch { return { status: "unknown", labels: {}, reason: "inspect output did not expose parseable ownership metadata" }; }
      const record = Array.isArray(inspected) ? inspected[0] : inspected;
      const configuration = record !== null && typeof record === "object" ? (record as Record<string, unknown>).configuration : null;
      const rawLabels = configuration !== null && typeof configuration === "object" ? (configuration as Record<string, unknown>).labels : null;
      if (rawLabels === null || typeof rawLabels !== "object" || Array.isArray(rawLabels)) {
        return { status: "unknown", labels: {}, reason: "Apple Container inspect omitted resource labels" };
      }
      const found = Object.fromEntries(Object.entries(rawLabels as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      const owned = Object.entries(expectedLabels).every(([key, value]) => found[key] === value);
      return { status: owned ? "owned" : "foreign", labels: found, reason: owned ? null : "required run ownership label does not match" };
    },

    async inspectResource(kind: ResourceKind, name: string, signal?: AbortSignal): Promise<"present" | "absent"> {
      if (kind === "image") {
        const resolved = await resolveImageReference(name, signal);
        if (resolved === null) return "absent";
        const args = ["image", "inspect", resolved.reference];
        const result = await runContainerCli(args, { cliPath, spawnProcess, timeoutMs, signal });
        if (result.code === 0) {
          if (!name.startsWith("sha256:")) return "present";
          // A reference that exists but now points at different content is NOT the exact
          // identity that was journaled.
          return firstDigest(parseJson("container image inspect", result.stdout)) === name ? "present" : "absent";
        }
        if (looksAbsent("image.inspect", result)) return "absent";
        throw cliFailure("inspectResource", args, result);
      }
      const args = kind === "network" ? ["network", "inspect", name] : ["inspect", name];
      const result = await runContainerCli(args, { cliPath, spawnProcess, timeoutMs, signal });
      if (result.code === 0) return "present";
      if (looksAbsent(`${kind}.inspect`, result)) return "absent";
      throw cliFailure("inspectResource", args, result);
    },

    async destroyResource(kind: ResourceKind, name: string, signal?: AbortSignal): Promise<DestroyOutcome> {
      if (kind === "network") return await sandbox.destroyNetwork(name, signal);
      if (kind === "guest") return await destroyGuest(cliPath, timeoutMs, name, signal);
      const resolved = await resolveImageReference(name, signal);
      if (resolved === null) return { status: "already-absent", verified: true, failure: null };
      if (resolved.reference.startsWith("eval-cached-")) {
        return { status: "already-absent", verified: true, failure: null };
      }
      const args = ["image", "delete", resolved.reference];
      const result = await runContainerCli(args, { cliPath, spawnProcess, timeoutMs, signal });
      if (result.code === 0) {
        references.delete(name);
        return { status: "destroyed", verified: true, failure: null };
      }
      if (looksAbsent("image.delete", result)) {
        references.delete(name);
        return { status: "already-absent", verified: true, failure: null };
      }
      return {
        status: "failed",
        verified: false,
        failure: {
          code: "cleanup-failed",
          failureClass: "infrastructure",
          message: `destroying image ${name} failed: ${result.stderr.trim().slice(0, 500)}`,
          at: name,
        },
      };
    },
  };
  return sandbox;
}
