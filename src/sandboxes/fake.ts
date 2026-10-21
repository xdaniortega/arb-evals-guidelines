/**
 * Deterministic in-process sandbox test double.
 *
 * It models image, network, guest, staging, bounded export, and exact-identity
 * destruction against a private temporary directory so the paired lifecycle can be
 * exercised offline with no container runtime, no credential, and no network. It never
 * executes a command and never maps host state into a guest. Every run using it is
 * self-labeled as a test double in evidence and is only permitted in `fake` mode.
 */

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { assertSafeRelativePath, canonicalJsonSha256, sha256Hex } from "../core/experiment.ts";
import { EvalError, assertNotAborted } from "../core/types.ts";
import { scanForSecrets } from "../core/secret-scan.ts";
import type { GuardedSecret } from "../core/secret-scan.ts";
import type {
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
  Sandbox,
  SandboxProbe,
  StageRequest,
} from "./sandbox.ts";

export const FAKE_SANDBOX_ID = "fake";

/**
 * Labels every observation this double produces.
 *
 * It is carried into sealed evidence so an attestation record can never be mistaken for a
 * measured one: the double sends no packet, reads no /proc, and attempts no write.
 */
export const FAKE_ATTESTATION_SOURCE = "fake-sandbox-double";
const FAKE_PROBE_DETAIL = "simulated by the fake sandbox; no packet was sent";

function guestToHost(root: string, guestPath: string, at: string): string {
  if (!guestPath.startsWith("/") || guestPath.includes("..") || guestPath.includes("\0")) {
    throw new EvalError("path-unsafe", `${at} must be a plain absolute guest path: ${guestPath}`, { at });
  }
  const absoluteRoot = resolve(root);
  const mapped = resolve(absoluteRoot, `.${guestPath}`);
  if (mapped !== absoluteRoot && !mapped.startsWith(`${absoluteRoot}${sep}`)) {
    throw new EvalError("path-unsafe", `${at} escapes the fake guest root: ${guestPath}`, { at });
  }
  return mapped;
}

/**
 * Removes a scratch tree that may contain intentionally read-only staged content.
 *
 * The frozen evaluated skill is staged as read-only files inside read-only directories,
 * which is deliberate: the snapshot must not be mutable. But a non-root user cannot
 * unlink a child of a directory that lacks write permission, so a plain recursive remove
 * fails with EACCES and a guest becomes undestroyable. Running as root masks this; as a
 * normal user it is fatal. A sandbox must always be able to destroy its own scratch, so
 * restore directory write access before removing.
 */
async function removeScratchTree(root: string): Promise<void> {
  const restore = async (dir: string): Promise<void> => {
    await chmod(dir, 0o700).catch(() => undefined);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) await restore(join(dir, entry.name));
    }
  };
  await restore(root);
  await rm(root, { recursive: true, force: true });
}

interface FakeGuestState {
  readonly spec: GuestSpec;
  readonly root: string;
  /** The declared policy of the network this guest was created on. */
  readonly networkPolicy: NetworkPolicy;
  destroyed: boolean;
  attested: boolean;
  /** Variable NAMES only. The double never retains a delivered credential value. */
  readonly deliveredCredentialVariables: string[];
}

class FakeGuest implements Guest {
  readonly name: string;
  readonly networkName: string;
  readonly imageDigest: string;
  private readonly state: FakeGuestState;

  constructor(state: FakeGuestState) {
    this.name = state.spec.name;
    this.networkName = state.spec.networkName;
    this.imageDigest = state.spec.imageDigest;
    this.state = state;
  }

  /** Variable names delivered to this guest, for test assertions. Never values. */
  get deliveredCredentialVariables(): readonly string[] {
    return [...this.state.deliveredCredentialVariables];
  }

  get hostWorkspaceDir(): string {
    return guestToHost(this.state.root, "/work", "hostWorkspaceDir");
  }

  resolveGuestPath(guestPath: string): string {
    return guestToHost(this.state.root, guestPath, "resolveGuestPath");
  }

  private assertAlive(): void {
    if (this.state.destroyed) {
      throw new EvalError("evidence-invalid", `fake guest ${this.name} was used after destruction`);
    }
  }

  async stage(request: StageRequest): Promise<void> {
    this.assertAlive();
    assertNotAborted(request.signal, "stage");
    const destination = guestToHost(this.state.root, request.destDir, "stage.destDir");
    await mkdir(destination, { recursive: true });
    for (const file of request.files) {
      assertNotAborted(request.signal, "stage");
      // Validate before joining: `a//b` or a traversing spelling must never reach a
      // host path, and the export walk would otherwise report a different path than
      // the one that was staged.
      const safePath = assertSafeRelativePath(file.path, "stage.files[].path");
      const target = guestToHost(this.state.root, `${request.destDir}/${safePath}`, "stage.files[].path");
      await mkdir(dirname(target), { recursive: true });
      // readOnly is honoured, not ignored: a test asserting "the treatment skill is
      // staged read-only" must not pass vacuously against the double.
      const mode = request.readOnly ? file.mode & 0o444 : file.mode;
      await writeFile(target, Buffer.from(file.base64, "base64"), { mode });
    }
    if (request.readOnly) {
      await chmod(destination, 0o555).catch(() => undefined);
    }
  }

  async exec(request: GuestExecRequest): Promise<GuestExecResult> {
    assertNotAborted(request.signal, "exec");
    throw new EvalError("not-implemented", "the fake sandbox never executes commands");
  }

  async execStream(request: GuestStreamRequest): Promise<GuestStreamSession> {
    assertNotAborted(request.signal, "execStream");
    throw new EvalError("not-implemented", "the fake sandbox never executes commands");
  }

  async exportFiles(request: ExportRequest): Promise<ExportedTree> {
    this.assertAlive();
    assertNotAborted(request.signal, "exportFiles");
    const root = guestToHost(this.state.root, request.root, "export.root");
    const files: Array<{ path: string; bytes: number; sha256: string; base64: string }> = [];
    const skipped: string[] = [];
    let totalBytes = 0;
    let truncated = false;

    const walk = async (relative: readonly string[]): Promise<void> => {
      const dir = relative.length === 0 ? root : join(root, ...relative);
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))) {
        assertNotAborted(request.signal, "exportFiles");
        const relativePath = [...relative, entry.name];
        if (entry.isDirectory()) {
          await walk(relativePath);
          continue;
        }
        if (!entry.isFile()) {
          skipped.push(relativePath.join("/"));
          continue;
        }
        if (files.length >= request.maxFiles) {
          truncated = true;
          skipped.push(relativePath.join("/"));
          continue;
        }
        const bytes = await readFile(join(dir, entry.name));
        if (bytes.byteLength > request.maxFileBytes || totalBytes + bytes.byteLength > request.maxTotalBytes) {
          truncated = true;
          skipped.push(relativePath.join("/"));
          continue;
        }
        totalBytes += bytes.byteLength;
        files.push({
          path: relativePath.join("/"),
          bytes: bytes.byteLength,
          sha256: sha256Hex(bytes),
          base64: bytes.toString("base64"),
        });
      }
    };

    await walk([]);
    return { files, truncated, skipped: skipped.sort() };
  }

  /**
   * A DECLARED-policy echo, explicitly labelled as such.
   *
   * The double observes nothing: it restates the guest policy it was given and reports
   * simulated probe outcomes derived from the declared network policy. That is honest
   * only because every field of the sealed record says so, so no reader can mistake it
   * for a measurement.
   */
  async attest(): Promise<GuestAttestation> {
    this.assertAlive();
    this.state.attested = true;
    const policy = this.state.spec.policy;
    const allowed = this.state.networkPolicy.allowPublicTcpPorts;
    const probe = (
      label: string,
      category: "private" | "public",
      host: string,
      port: number,
    ): ObservedEgressProbe => {
      const expectation =
        category === "public" && (allowed === "all" || allowed.includes(port)) ? "connected" : "blocked";
      return {
        label,
        category,
        host,
        port,
        expectation,
        // The double never contradicts its own declaration: outcome IS the expectation,
        // which is exactly why the record is labelled test-double-produced.
        outcome: expectation,
        detail: FAKE_PROBE_DETAIL,
        durationMs: 0,
      };
    };
    const egressProbes: readonly ObservedEgressProbe[] = [
      probe("metadata", "private", "169.254.169.254", 80),
      probe("private-10", "private", "10.0.0.1", 80),
      probe("guest-loopback", "private", "127.0.0.1", 22),
      probe("public-443", "public", "1.1.1.1", 443),
      probe("public-80", "public", "1.1.1.1", 80),
    ];
    const observed: ObservedAttestation = {
      source: FAKE_ATTESTATION_SOURCE,
      testDouble: true,
      checkedAt: new Date(0).toISOString(),
      init: {
        uid: policy.uid,
        gid: policy.gid,
        groups: [],
        capEff: policy.dropCapabilities ? "0000000000000000" : null,
        capPrm: policy.dropCapabilities ? "0000000000000000" : null,
        noNewPrivs: policy.noNewPrivileges,
      },
      self: { uid: policy.uid, gid: policy.gid, groups: [] },
      readOnlyRootProbe: {
        readOnly: policy.readOnlyRoot,
        detail: "declared by the fake sandbox; no write was attempted",
      },
      declaredWritablePaths: [...policy.writablePaths],
      mountCount: 0,
      hostBackedMounts: [],
      unexpectedWritableMounts: [],
      resolvers: [],
      anyResolverPrivate: false,
      allowedTcpPorts: allowed === "all" ? "all" : [...allowed].sort((left, right) => left - right),
      egressProbes,
      dnsProbe: { ok: false, detail: "the fake sandbox resolves no name", durationMs: 0 },
    };
    return {
      uid: policy.uid,
      gid: policy.gid,
      noNewPrivileges: policy.noNewPrivileges,
      capabilitiesDropped: policy.dropCapabilities,
      readOnlyRoot: policy.readOnlyRoot,
      hostMounts: [],
      egress: { publicDnsAllowed: false, deniedRangesEnforced: true, resolverInherited: false },
      checkedAt: new Date(0).toISOString(),
      observed,
    };
  }

  /**
   * Models the contracted credential seam: delivery is refused until attestation has
   * succeeded, the value is used and dropped without ever being persisted, and only the
   * variable NAME is retained so tests can assert delivery without handling a secret.
   */
  async deliverCredential(request: CredentialDeliveryRequest): Promise<void> {
    this.assertAlive();
    if (!this.state.attested) {
      throw new EvalError(
        "secret-quarantine",
        `fake guest ${this.name} must be attested before a credential is delivered`,
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
    this.state.deliveredCredentialVariables.push(request.variable);
  }

  async destroy(): Promise<DestroyOutcome> {
    if (this.state.destroyed) return { status: "already-absent", verified: true, failure: null };
    await removeScratchTree(this.state.root);
    this.state.destroyed = true;
    return { status: "destroyed", verified: true, failure: null };
  }
}

export interface FakeSandbox extends Sandbox {
  /** Exact identities the double has seen, for cleanup and recovery assertions. */
  readonly created: { images: string[]; networks: string[]; guests: string[] };
  readonly live: { networks: readonly string[]; guests: readonly string[] };
}

/**
 * Deterministic cleanup-failure injection.
 *
 * Cleanup failure is a contract-level branch ("after a cleanup failure, no further paid
 * call may be made in that run"), so it must be provable, not merely argued. Every field
 * names EXACT identities, spelled either `name` or `kind:name` — the double never matches
 * a prefix, pattern, or label, because a broad selector is exactly what the contract
 * forbids elsewhere.
 */
export interface FakeSandboxFaults {
  /** Destruction reports `failed` for these identities. */
  readonly destroyFails?: readonly string[];
  /** Destruction reports success but the resource is deliberately left present. */
  readonly destroyLeavesPresent?: readonly string[];
  /**
   * Destruction succeeds and the identity inspects `absent` exactly once afterwards,
   * then inspects `present` again — a resource that leaked back after being verified
   * gone. This is what makes the pre-next-condition absence check reachable.
   */
  readonly reappearsAfterDestroy?: readonly string[];
}

export interface FakeSandboxOptions {
  readonly rootPrefix?: string;
  /**
   * Secrets the double must never see in a GuestSpec. Supplied by the boundary that
   * loaded them, so the double itself never reads ambient environment.
   */
  readonly guardedSecrets?: readonly GuardedSecret[];
  /** Deterministic cleanup-failure injection. Absent by default: the double never fails. */
  readonly faults?: FakeSandboxFaults;
  /** Synthetic exact-object labels used by recovery ownership tests. */
  readonly ownershipLabels?: Readonly<Record<string, string>>;
}

function faultMatches(selectors: readonly string[] | undefined, kind: ResourceKind, name: string): boolean {
  if (selectors === undefined) return false;
  return selectors.includes(name) || selectors.includes(`${kind}:${name}`);
}

/**
 * @notice Simulates sandbox resource lifecycles without creating real containers.
 * @param options Fault injection and resource behavior for deterministic tests.
 * @returns A sandbox explicitly marked as a test double.
 */
export function createFakeSandbox(options: FakeSandboxOptions = {}): FakeSandbox {
  const networks = new Map<string, NetworkIdentity>();
  /** Declared policy per network, so an attestation echo cannot invent its own. */
  const networkPolicies = new Map<string, NetworkPolicy>();
  const guests = new Map<string, FakeGuestState>();
  const images = new Map<string, ImageIdentity>();
  const created = { images: [] as string[], networks: [] as string[], guests: [] as string[] };
  const faults = options.faults ?? {};
  const ownershipLabels = options.ownershipLabels ?? {};
  /** Identities that are pending one "absent" answer before they reappear. */
  const reappearing = new Set<string>();
  /** Identities that were destroyed but deliberately left present. */
  const leftPresent = new Set<string>();

  const injectedFailure = (kind: ResourceKind, name: string): DestroyOutcome => ({
    status: "failed",
    verified: false,
    failure: {
      code: "cleanup-failed",
      failureClass: "infrastructure",
      message: `injected fault: destroying ${kind} ${name} failed`,
      at: name,
    },
  });

  return {
    id: FAKE_SANDBOX_ID,
    testDouble: true,
    created,
    get live() {
      return {
        networks: [...networks.keys()].sort(),
        guests: [...guests.entries()].filter(([, state]) => !state.destroyed).map(([name]) => name).sort(),
      };
    },
    async probe(signal?: AbortSignal): Promise<SandboxProbe> {
      assertNotAborted(signal, "fake sandbox probe");
      return {
        ready: true,
        details: [{ name: "fake-sandbox", status: "ok", detail: "deterministic in-process test double" }],
      };
    },
    async buildImage(spec: ImageSpec): Promise<ImageIdentity> {
      assertNotAborted(spec.signal, "buildImage");
      let recipe: unknown = { sandbox: FAKE_SANDBOX_ID, profile: spec.runtimeProfileId };
      if (spec.contextDir) {
        try {
          const lockPath = join(spec.contextDir, "image-lock.json");
          const lockRaw = await readFile(lockPath, "utf8").catch(() => null);
          if (lockRaw !== null) {
            const parsed = JSON.parse(lockRaw) as { profiles?: Record<string, { buildContextFiles?: Record<string, string> }> };
            const profile = parsed.profiles?.[spec.runtimeProfileId];
            if (profile?.buildContextFiles) {
              recipe = { ...(recipe as object), files: profile.buildContextFiles };
            }
          }
        } catch {
          // ignore
        }
      }
      const digest = `sha256:${canonicalJsonSha256(recipe)}`;
      const existing = images.get(digest);
      if (existing !== undefined) {
        return { ...existing, cacheHit: true };
      }
      spec.onBuildStarted?.();
      const identity: ImageIdentity = {
        reference: `fake/${spec.runtimeProfileId}@${digest}`,
        digest,
        runtimeProfileId: spec.runtimeProfileId,
        testDouble: true,
        cacheHit: false,
      };
      images.set(digest, identity);
      created.images.push(digest);
      return identity;
    },
    async createNetwork(name: string, policy: NetworkPolicy): Promise<NetworkIdentity> {
      if (networks.has(name)) throw new EvalError("evidence-invalid", `fake network already exists: ${name}`);
      const identity: NetworkIdentity = { name, policySha256: canonicalJsonSha256(policy) };
      networks.set(name, identity);
      networkPolicies.set(name, policy);
      created.networks.push(name);
      return identity;
    },
    async destroyNetwork(name: string, signal?: AbortSignal): Promise<DestroyOutcome> {
      assertNotAborted(signal, "destroyNetwork");
      if (faultMatches(faults.destroyFails, "network", name)) return injectedFailure("network", name);
      if (!networks.has(name)) return { status: "already-absent", verified: true, failure: null };
      if (faultMatches(faults.destroyLeavesPresent, "network", name)) {
        // Reports success and leaves the resource behind. A caller that trusts the return
        // value instead of re-inspecting will wrongly record this as a clean teardown.
        leftPresent.add(`network:${name}`);
        return { status: "destroyed", verified: true, failure: null };
      }
      networks.delete(name);
      if (faultMatches(faults.reappearsAfterDestroy, "network", name)) reappearing.add(`network:${name}`);
      return { status: "destroyed", verified: true, failure: null };
    },
    async createGuest(spec: GuestSpec): Promise<Guest> {
      const networkPolicy = networkPolicies.get(spec.networkName);
      if (!networks.has(spec.networkName) || networkPolicy === undefined) {
        throw new EvalError("evidence-invalid", `fake guest ${spec.name} requires network ${spec.networkName}`);
      }
      if (!images.has(spec.imageDigest)) {
        throw new EvalError("evidence-invalid", `fake guest ${spec.name} requires a built image digest`);
      }
      if (guests.has(spec.name)) throw new EvalError("evidence-invalid", `fake guest already exists: ${spec.name}`);
      // GuestSpec.env is non-secret by contract. A credential reaches a guest only via
      // deliverCredential() after attestation, never through a run specification.
      //
      // The name heuristic alone is not enough: it both false-negatives (a variable
      // called AUTH or CONFIG_BLOB) and false-positives (any long benign value). It is
      // kept as a cheap first filter and backed by a real value scan against the
      // guarded secrets the boundary loaded, which catches an actual secret VALUE
      // placed in a benignly named variable.
      const guardedSecrets = options.guardedSecrets ?? [];
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
      const root = await mkdtemp(join(tmpdir(), `${options.rootPrefix ?? "eval-fake-guest"}-`));
      const state: FakeGuestState = {
        spec,
        root,
        networkPolicy,
        destroyed: false,
        attested: false,
        deliveredCredentialVariables: [],
      };
      guests.set(spec.name, state);
      created.guests.push(spec.name);
      return new FakeGuest(state);
    },
    async inspectResource(kind: ResourceKind, name: string, signal?: AbortSignal): Promise<"present" | "absent"> {
      assertNotAborted(signal, "inspectResource");
      const key = `${kind}:${name}`;
      if (leftPresent.has(key)) return "present";
      if (reappearing.has(key)) {
        // One honest "absent" answer, then the leak is visible again.
        reappearing.delete(key);
        leftPresent.add(key);
        return "absent";
      }
      if (kind === "image") return images.has(name) ? "present" : "absent";
      if (kind === "network") return networks.has(name) ? "present" : "absent";
      const state = guests.get(name);
      return state !== undefined && !state.destroyed ? "present" : "absent";
    },
    async inspectResourceOwnership(kind: ResourceKind, name: string, expectedLabels: Readonly<Record<string, string>>) {
      const present = kind === "network" ? networks.has(name) : kind === "guest" ? guests.has(name) && !guests.get(name)!.destroyed : images.has(name);
      if (!present) return { status: "unknown" as const, labels: {}, reason: "resource is absent" };
      const owned = Object.entries(expectedLabels).every(([key, value]) => ownershipLabels[key] === value);
      return { status: owned ? "owned" as const : "foreign" as const, labels: { ...ownershipLabels }, reason: owned ? null : "required run ownership label does not match" };
    },

    async destroyResource(kind: ResourceKind, name: string, signal?: AbortSignal): Promise<DestroyOutcome> {
      assertNotAborted(signal, "destroyResource");
      if (kind === "network") return this.destroyNetwork(name);
      if (faultMatches(faults.destroyFails, kind, name)) return injectedFailure(kind, name);
      if (kind === "image") {
        return images.delete(name)
          ? { status: "destroyed", verified: true, failure: null }
          : { status: "already-absent", verified: true, failure: null };
      }
      if (faultMatches(faults.destroyLeavesPresent, kind, name)) {
        leftPresent.add(`${kind}:${name}`);
        return { status: "destroyed", verified: true, failure: null };
      }
      const state = guests.get(name);
      if (state === undefined || state.destroyed) return { status: "already-absent", verified: true, failure: null };
      await removeScratchTree(state.root);
      state.destroyed = true;
      if (faultMatches(faults.reappearsAfterDestroy, kind, name)) reappearing.add(`${kind}:${name}`);
      return { status: "destroyed", verified: true, failure: null };
    },
  };
}
