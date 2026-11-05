#!/usr/bin/env node
/**
 * The guest supervisor and the guest side of every host interaction.
 *
 * WHY it exists: the host must never execute guest-authored code and must never trust a
 * fact it did not observe inside the guest. Both requirements are met by putting one
 * small, allowlisted, image-resident program in the guest and having the host talk to it
 * only through argv-free stdin/stdout JSON frames.
 *
 * Modes:
 * - `supervise`        PID 1 after the privilege drop. Holds the guest open and owns the
 *                      in-memory credential control socket. A configured finite arm
 *                      has a lifetime guard; unlimited arms use cancellation/teardown.
 * - `attest`           Reports OBSERVED privilege, mount, and egress facts, including
 *                      the facts of PID 1 itself read from /proc/1/status. Nothing here
 *                      is asserted from configuration.
 * - `stage`            Writes host-supplied files under a bounded destination.
 * - `export`           Reads a bounded file tree back out.
 * - `deliver-credential` Forwards one credential value from stdin to the supervisor over
 *                      the control socket. The value never touches argv, env, or disk.
 * - `validate`         One-shot offline validation of a candidate against an oracle.
 * - `agent`            Runs the locked, image-resident framed Pi SDK process. Runtime
 *                      configuration, prompt, and abort are separate stdin frames.
 *
 * Control operations are bounded and fail closed on unknown fields. The agent mode
 * uses a framed stream; other command modes print one JSON object on stdout.
 */

import { scheduleTimeout } from "./guest-runtime/src/core/timing.mjs";
import { connect as netConnect, createServer } from "node:net";
import { createSocket } from "node:dgram";
import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setDefaultResultOrder } from "node:dns";
import { setDefaultAutoSelectFamily } from "node:net";

// IPv4-only outbound connections, set once for every mode (the agent exec loads this same
// file). The egress lock drops ALL IPv6, so Happy Eyeballs (Node's default
// autoSelectFamily, 250 ms per attempt) can only lose: a host with one A and one AAAA
// record (for example mcp.inkeep.com) whose IPv4 handshake takes longer than 250 ms falls
// through to the dropped IPv6 address and the whole fetch fails with ETIMEDOUT.
setDefaultResultOrder("ipv4first");
setDefaultAutoSelectFamily(false);

const SCHEMA_VERSION = 1;
const EVAL_UID = 10001;
const EVAL_GID = 10001;
const CONTROL_DIR = process.env.EVAL_CONTROL_DIR ?? "/run/eval";
const CONTROL_SOCKET = process.env.EVAL_CONTROL_SOCKET ?? `${CONTROL_DIR}/control.sock`;
const MAX_RELATIVE_PATH_LENGTH = 200;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Probed by `attest`. Public by construction; a private answer would be a policy break.
 *
 * The public host is probed on BOTH 443 and 80 so the enforced TCP port allowlist is
 * confirmed empirically in each direction: whichever of the two the declared policy
 * permits must connect, and whichever it does not must be refused. Without the negative
 * probe, "only 443 is permitted" would be an unverified claim about a shell script.
 */
const PUBLIC_PROBE_HOST = "1.1.1.1";
const PUBLIC_PROBE_PORTS = [443, 80];
const PRIVATE_PROBES = [
  { label: "metadata", host: "169.254.169.254", port: 80 },
  { label: "private-10", host: "10.0.0.1", port: 80 },
  { label: "private-192", host: "192.168.64.1", port: 53 },
  { label: "guest-loopback", host: "127.0.0.1", port: 22 },
];
const PROBE_TIMEOUT_MS = 1_500;

function fail(message) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(message) })}\n`);
  process.exit(1);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify({ ok: true, ...payload })}\n`);
}

function assertSafeRelativePath(candidate) {
  if (typeof candidate !== "string" || candidate === "" || candidate.length > MAX_RELATIVE_PATH_LENGTH) {
    throw new Error(`unsafe relative path: ${String(candidate)}`);
  }
  if (candidate.includes("\0") || candidate.includes("\\") || candidate.startsWith("/") || candidate.endsWith("/")) {
    throw new Error(`unsafe relative path: ${candidate}`);
  }
  const segments = candidate.split("/");
  for (const segment of segments) {
    if (!PATH_SEGMENT_PATTERN.test(segment)) throw new Error(`unsafe relative path segment: ${candidate}`);
  }
  return segments.join("/");
}

function assertAbsoluteGuestDir(candidate) {
  if (typeof candidate !== "string" || !candidate.startsWith("/") || candidate.includes("..") || candidate.includes("\0")) {
    throw new Error(`unsafe absolute guest path: ${String(candidate)}`);
  }
  return candidate.replace(/\/+$/, "") === "" ? "/" : candidate.replace(/\/+$/, "");
}

async function readStdin(maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`stdin exceeded ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (typeof flag !== "string" || !flag.startsWith("--")) throw new Error(`unexpected argument: ${String(flag)}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    index += 1;
    flags[flag.slice(2)] = value;
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Observed privilege facts
// ---------------------------------------------------------------------------

function readProcStatus(pid) {
  const text = readFileSync(`/proc/${pid}/status`, "utf8");
  const field = (name) => {
    const line = text.split("\n").find((entry) => entry.startsWith(`${name}:`));
    return line === undefined ? null : line.slice(name.length + 1).trim();
  };
  const ids = (name) => {
    const raw = field(name);
    return raw === null ? [] : raw.split(/\s+/).filter((entry) => entry !== "").map((entry) => Number(entry));
  };
  const groupsRaw = field("Groups");
  return {
    uid: ids("Uid")[0] ?? null,
    gid: ids("Gid")[0] ?? null,
    groups: groupsRaw === null || groupsRaw === "" ? [] : groupsRaw.split(/\s+/).map((entry) => Number(entry)),
    capEff: field("CapEff"),
    capPrm: field("CapPrm"),
    noNewPrivs: field("NoNewPrivs") === "1",
  };
}

function probeReadOnlyRoot() {
  const target = `/eval-write-probe-${process.pid}`;
  try {
    writeFileSync(target, "x");
    // The write succeeded, which means the root filesystem is NOT read-only. Remove the
    // evidence of the probe but report the failure truthfully.
    try {
      unlinkSync(target);
    } catch {
      /* nothing further to do; the fact is already recorded as a failure */
    }
    return { readOnly: false, detail: `wrote ${target} successfully` };
  } catch (error) {
    return { readOnly: true, detail: String(error && error.code ? error.code : error) };
  }
}

/** Filesystem types that can only come from outside the guest. */
const HOST_BACKED_FSTYPES = new Set(["virtiofs", "9p", "nfs", "nfs4", "cifs", "smb3", "fuse.sshfs", "vboxsf"]);
const KERNEL_FSTYPES = new Set([
  "proc",
  "sysfs",
  "devtmpfs",
  "devpts",
  "mqueue",
  "cgroup",
  "cgroup2",
  "securityfs",
  "debugfs",
  "tracefs",
  "bpf",
  "pstore",
  "configfs",
  "fusectl",
  "hugetlbfs",
  "binfmt_misc",
  "autofs",
]);

function readMounts(declaredWritable) {
  const declared = new Set(declaredWritable);
  const lines = readFileSync("/proc/self/mounts", "utf8").split("\n").filter((line) => line.trim() !== "");
  const mounts = lines.map((line) => {
    const [source, target, fstype, options] = line.split(/\s+/);
    return {
      source: source ?? "",
      target: target ?? "",
      fstype: fstype ?? "",
      readOnly: (options ?? "").split(",").includes("ro"),
    };
  });
  const hostBacked = mounts.filter((mount) => HOST_BACKED_FSTYPES.has(mount.fstype));
  const unexpectedWritable = mounts.filter(
    (mount) =>
      !mount.readOnly &&
      !KERNEL_FSTYPES.has(mount.fstype) &&
      mount.target !== "/dev" &&
      mount.target !== "/dev/shm" &&
      !declared.has(mount.target),
  );
  return { mounts, hostBacked, unexpectedWritable };
}

function readResolvers() {
  try {
    return readFileSync("/etc/resolv.conf", "utf8")
      .split("\n")
      .filter((line) => line.trim().startsWith("nameserver"))
      .map((line) => line.trim().split(/\s+/)[1] ?? "")
      .filter((entry) => entry !== "");
  } catch {
    return [];
  }
}

function isPrivateAddress(address) {
  const parts = address.split(".").map((entry) => Number(entry));
  if (parts.length !== 4 || parts.some((entry) => !Number.isInteger(entry))) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function probeTcp(host, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = netConnect({ host, port });
    const done = (outcome, detail) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ host, port, outcome, detail, ms: Date.now() - started });
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => done("connected", "tcp handshake completed"));
    socket.once("timeout", () => done("blocked", "timed out"));
    socket.once("error", (error) => done("blocked", String(error && error.code ? error.code : error)));
  });
}

/**
 * @notice Probes UDP egress without treating routing or socket errors as firewall enforcement.
 * @param host Destination IPv4 address.
 * @param port Destination UDP port.
 * @param dependencies Socket factory overrides for deterministic tests.
 * @returns A blocked, connected, or inconclusive observation.
 * @dev Only send-time EPERM proves rejection; EACCES and route failures are inconclusive.
 */
export function probeUdpSend(host, port, dependencies = {}) {
  const socket = (dependencies.createSocket ?? createSocket)("udp4");
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let sending = false;
    const timer = setTimeout(() => done("inconclusive", "UDP probe did not complete"), PROBE_TIMEOUT_MS);
    const done = (outcome, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* Binding may have failed. */ }
      resolve({ host, port, outcome, detail, ms: Date.now() - started });
    };
    const failed = (error) => {
      const code = String(error?.code ?? error);
      // Only the synchronous netfilter OUTPUT verdict (EPERM) is evidence of the firewall.
      // EACCES (socket-option/permission, e.g. SO_BROADCAST) and route failures are not.
      done(sending && code === "EPERM" ? "blocked" : "inconclusive", code);
    };
    socket.once("error", failed);
    try {
      socket.bind(0, "0.0.0.0", () => {
        try {
          // Otherwise broadcast itself fails with EACCES even without a firewall.
          socket.setBroadcast(true);
          sending = true;
          socket.send(Buffer.from("eval-egress-probe"), port, host, (error) => {
            if (error) failed(error);
            else done("connected", "UDP datagram accepted for transmission");
          });
        } catch (error) { failed(error); }
      });
    } catch (error) { failed(error); }
  });
}

/**
 * @notice Tests IPv6 loopback filtering against a live listener rather than a closed port.
 * @param dependencies Socket factories and probe timeout overrides for tests.
 * @returns Whether a loopback datagram was blocked or delivered.
 */
export function probeIpv6Loopback(dependencies = {}) {
  const makeSocket = dependencies.createSocket ?? createSocket;
  const receiver = makeSocket("udp6");
  const sender = makeSocket("udp6");
  const started = Date.now();
  const payload = Buffer.from("eval-ipv6-egress-probe");
  return new Promise((resolve) => {
    let settled = false;
    let port = 0;
    let timer = setTimeout(() => done("inconclusive", "IPv6 loopback probe setup did not complete"), PROBE_TIMEOUT_MS);
    const done = (outcome, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const socket of [sender, receiver]) {
        try { socket.close(); } catch { /* Binding may have failed. */ }
      }
      resolve({ host: "::1", port, outcome, detail, ms: Date.now() - started });
    };
    const failed = (error) => done("inconclusive", `IPv6 loopback unavailable: ${String(error?.code ?? error)}`);
    receiver.once("error", failed);
    sender.once("error", failed);
    receiver.on("message", (message) => {
      if (message.equals(payload)) done("connected", "UDP6 datagram reached the listening ::1 endpoint");
    });
    try {
      receiver.bind(0, "::1", () => {
        try {
          port = receiver.address().port;
          sender.bind(0, "::1", () => {
            try {
              sender.send(payload, port, "::1", (error) => {
                if (error) {
                  // Only the synchronous netfilter verdict (EPERM) proves enforcement; EACCES
                  // and route errors are socket/routing failures, not the ip6tables OUTPUT rule.
                  if (error.code === "EPERM") done("blocked", `IPv6 output refused UDP6 datagram: ${error.code}`);
                  else failed(error);
                  return;
                }
                if (settled) return;
                clearTimeout(timer);
                timer = setTimeout(() => done("blocked", "UDP6 datagram was not delivered to the listening ::1 endpoint"), dependencies.timeoutMs ?? PROBE_TIMEOUT_MS);
              });
            } catch (error) { failed(error); }
          });
        } catch (error) { failed(error); }
      });
    } catch (error) { failed(error); }
  });
}

async function probeDns() {
  const started = Date.now();
  try {
    const addresses = await dns.resolve4("example.com");
    return {
      ok: addresses.length > 0,
      detail: `resolved example.com to ${addresses.length} address(es)`,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      detail: String(error && error.code ? error.code : error),
      durationMs: Date.now() - started,
    };
  }
}

/**
 * The TCP ports the DECLARED network policy permits, as the host passed them in.
 *
 * The same value drives the iptables rule in the entrypoint, so a probe expectation
 * derived from it cannot silently disagree with what was enforced. Fails closed: an
 * absent or malformed list yields an empty allowlist, which makes every public probe
 * expect refusal and therefore makes the mismatch loud.
 */
function allowedTcpPorts() {
  const raw = String(process.env.EVAL_ALLOWED_TCP_PORTS ?? "").trim();
  if (raw === "all") return "all";
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^[0-9]{1,5}$/.test(entry))
    .map((entry) => Number(entry))
    .filter((port) => port > 0 && port <= 65535)
    .sort((left, right) => left - right);
}

/**
 * @notice Observes guest isolation rather than trusting the requested container settings.
 * @param declaredWritable Paths expected to remain writable by policy.
 * @returns Runtime, filesystem, credential, and network observations for host verification.
 */
async function attest(declaredWritable) {
  const init = readProcStatus(1);
  const self = {
    uid: process.getuid?.() ?? null,
    gid: process.getgid?.() ?? null,
    groups: typeof process.getgroups === "function" ? process.getgroups() : [],
  };
  const rootFs = probeReadOnlyRoot();
  const mounts = readMounts(declaredWritable);
  const resolvers = readResolvers();
  // Run independent probes concurrently so a silent IPv6 drop costs one timeout.
  const ports = allowedTcpPorts();
  const plan = [
    ...PRIVATE_PROBES.map((probe) => ({
      label: probe.label,
      category: "private",
      protocol: "tcp",
      host: probe.host,
      port: probe.port,
      expectation: "blocked",
    })),
    ...PUBLIC_PROBE_PORTS.map((port) => ({
      label: `public-${String(port)}`,
      category: "public",
      protocol: "tcp",
      host: PUBLIC_PROBE_HOST,
      port,
      // Derived from the declared policy, never from a literal in this file.
      expectation: ports === "all" || (Array.isArray(ports) && ports.includes(port)) ? "connected" : "blocked",
    })),
    { label: "ipv4-multicast", category: "multicast", protocol: "udp", host: "239.255.42.99", port: 9, expectation: "blocked" },
    { label: "ipv4-broadcast", category: "broadcast", protocol: "udp", host: "255.255.255.255", port: 9, expectation: "blocked" },
    { label: "ipv6-loopback", category: "ipv6", protocol: "udp", host: "::1", port: 0, expectation: "blocked" },
  ];
  const [probes, dnsProbe] = await Promise.all([
    Promise.all(
      plan.map(async (entry) => {
        const result = entry.category === "ipv6" ? await probeIpv6Loopback()
          : entry.protocol === "udp" ? await probeUdpSend(entry.host, entry.port)
          : await probeTcp(entry.host, entry.port);
        return {
          label: entry.label,
          category: entry.category,
          protocol: entry.protocol,
          host: entry.host,
          port: result.port,
          expectation: entry.expectation,
          outcome: result.outcome,
          detail: result.detail,
          durationMs: result.ms,
        };
      }),
    ),
    probeDns(),
  ]);
  return {
    schemaVersion: SCHEMA_VERSION,
    checkedAt: new Date().toISOString(),
    expected: { uid: EVAL_UID, gid: EVAL_GID },
    init,
    self,
    readOnlyRoot: rootFs,
    declaredWritablePaths: declaredWritable,
    hostBackedMounts: mounts.hostBacked,
    unexpectedWritableMounts: mounts.unexpectedWritable,
    mountCount: mounts.mounts.length,
    resolvers: resolvers.map((address) => ({ address, private: isPrivateAddress(address) })),
    egress: { allowedTcpPorts: ports, probes, dns: dnsProbe },
  };
}

// ---------------------------------------------------------------------------
// Process quiescence (production algorithm with injectable observations)
// ---------------------------------------------------------------------------

/** @typedef {{pid:number,startTime:string,state:string}} ProcessIdentity */

export function scanProcProcessIdentities(procRoot = "/proc") {
  const identities = [];
  for (const name of readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry))) {
    const path = join(procRoot, name, "stat");
    let text;
    try { text = readFileSync(path, "utf8"); }
    catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    const close = text.lastIndexOf(")");
    const fields = close < 0 ? [] : text.slice(close + 2).trim().split(/\s+/);
    const pid = Number(name);
    const state = fields[0];
    const startTime = fields[19];
    if (!Number.isSafeInteger(pid) || !state || !startTime) throw new Error(`unreadable process identity at ${path}`);
    identities.push({ pid, state, startTime });
  }
  return identities;
}

export function createTaskProcessQuiescer(deps = {}) {
  const scan = deps.scan ?? (() => scanProcProcessIdentities());
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const supervisorPid = deps.supervisorPid ?? process.pid;
  const registrations = new Map();
  let serialized = Promise.resolve();
  const key = (item) => `${item.pid}:${item.startTime}`;
  const live = (item) => item.state !== "Z" && item.state !== "X";
  const observeCandidates = (callerPid, baseline) => scan().filter((item) => live(item) && item.pid !== supervisorPid && item.pid !== callerPid && !baseline.has(key(item)));
  const signalOne = (item, signal) => {
    try { kill(item.pid, signal); }
    catch (error) { if (error?.code !== "ESRCH") throw error; }
  };
  return {
    register(callerPid) {
      if (!Number.isSafeInteger(callerPid) || callerPid <= 1 || callerPid === supervisorPid) throw new Error("invalid task caller PID");
      if (registrations.has(callerPid)) throw new Error("task process was already registered");
      registrations.set(callerPid, new Set(scan().filter((item) => item.pid !== callerPid).map(key)));
    },
    quiesce(callerPid, deadlineAtMs = now() + 2_000) {
      const work = async () => {
        const baseline = registrations.get(callerPid);
        if (!baseline) throw new Error("task process was not registered");
        const termed = new Set();
        let emptyPasses = 0;
        try {
          while (now() < deadlineAtMs) {
            const candidates = observeCandidates(callerPid, baseline);
            if (candidates.length === 0) {
              emptyPasses += 1;
              if (emptyPasses >= 2) return { ok: true, streamingStopped: true, descendantsStopped: true, remaining: 0 };
              await sleep(25);
              continue;
            }
            emptyPasses = 0;
            for (const item of candidates) {
              const identity = key(item);
              signalOne(item, termed.has(identity) ? "SIGKILL" : "SIGTERM");
              termed.add(identity);
            }
            await sleep(50);
          }
          const remaining = observeCandidates(callerPid, baseline);
          return { ok: false, streamingStopped: true, descendantsStopped: false, remaining: remaining.length };
        } finally { registrations.delete(callerPid); }
      };
      const result = serialized.then(work, work);
      serialized = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function declaredWritablePaths() {
  const raw = process.env.EVAL_WRITABLE_PATHS ?? "";
  return raw.split(":").filter((entry) => entry.startsWith("/"));
}

/**
 * @notice Supervises the agent's authenticated control channel and process lifecycle.
 * @dev An explicit zero supervisor lifetime leaves task duration to cancellation.
 */
async function modeSupervise() {
  mkdirSync(CONTROL_DIR, { recursive: true });
  const maxLifetimeMs = Number(process.env.EVAL_SUPERVISOR_MAX_MS ?? "3600000");
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 0) throw new Error("invalid supervisor lifetime");
  /** Credential values live here and nowhere else: never argv, never env, never disk. */
  const credentials = new Map();
  const taskProcesses = createTaskProcessQuiescer();
  const validCaller = (value) => Number.isSafeInteger(value) && value > 1 && value !== process.pid;
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 64 * 1024) {
        socket.end(`${JSON.stringify({ ok: false, error: "control frame too large" })}\n`);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      let response;
      try {
        const frame = JSON.parse(line);
        if (frame.type === "credential") {
          if (typeof frame.variable !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(frame.variable)) {
            throw new Error("credential variable is not an allowlisted environment entry");
          }
          if (typeof frame.value !== "string" || frame.value === "") throw new Error("credential value is empty");
          credentials.set(frame.variable, frame.value);
          response = { ok: true, variable: frame.variable, held: credentials.size };
        } else if (frame.type === "get-credential") {
          const val = credentials.get(frame.variable);
          response = val !== undefined ? { ok: true, variable: frame.variable, value: val } : { ok: false, error: `credential ${frame.variable} not delivered` };
        } else if (frame.type === "register-task-process") {
          if (!validCaller(frame.callerPid)) throw new Error("invalid task caller PID");
          taskProcesses.register(frame.callerPid);
          response = { ok: true };
        } else if (frame.type === "quiesce-task-processes") {
          if (!validCaller(frame.callerPid)) throw new Error("invalid task caller PID");
          response = await taskProcesses.quiesce(frame.callerPid);
        } else if (frame.type === "ping") {
          response = { ok: true, pid: process.pid, variables: [...credentials.keys()].sort() };
        } else {
          throw new Error(`unknown control frame type: ${String(frame.type)}`);
        }
      } catch (error) {
        response = { ok: false, error: String(error && error.message ? error.message : error) };
      }
      socket.end(`${JSON.stringify(response)}\n`);
    });
    socket.on("error", () => undefined);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(CONTROL_SOCKET, resolve);
  });
  chmodSync(CONTROL_SOCKET, 0o600);
  // A boot marker so the host can tell "the supervisor is up" from "the container exists".
  writeFileSync(join(CONTROL_DIR, "ready"), `${process.pid}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, mode: "supervise", pid: process.pid })}\n`);
  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // Unlimited arms rely on cancellation and journaled teardown. Finite arms also
  // have a lifetime guard covering setup, execution and evidence capture.
  if (maxLifetimeMs > 0) scheduleTimeout(shutdown, maxLifetimeMs);
}

async function modeAttest() {
  emit({ attestation: await attest(declaredWritablePaths()) });
}

async function modeStage() {
  const request = JSON.parse(await readStdin(64 * 1024 * 1024));
  const destDir = assertAbsoluteGuestDir(request.destDir);
  const readOnly = request.readOnly === true;
  if (!Array.isArray(request.files)) throw new Error("stage.files must be an array");
  mkdirSync(destDir, { recursive: true });
  const written = [];
  for (const file of request.files) {
    const relative = assertSafeRelativePath(file.path);
    const target = join(destDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    const bytes = Buffer.from(String(file.base64 ?? ""), "base64");
    const mode = readOnly ? (Number(file.mode ?? 0o444) & 0o444) : Number(file.mode ?? 0o644);
    writeFileSync(target, bytes, { mode });
    chmodSync(target, mode);
    written.push({ path: relative, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  if (readOnly) {
    try {
      chmodSync(destDir, 0o555);
    } catch {
      /* a directory that cannot be sealed is reported by its files' modes instead */
    }
  }
  emit({ staged: written });
}

function walkTree(root, relative, out) {
  let entries;
  try {
    entries = readdirSync(join(root, ...relative), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const next = [...relative, entry.name];
    if (entry.isDirectory()) walkTree(root, next, out);
    else out.push({ relative: next, isFile: entry.isFile() });
  }
}

async function modeExport(flags) {
  const root = assertAbsoluteGuestDir(flags.root);
  const maxFiles = Number(flags["max-files"]);
  const maxFileBytes = Number(flags["max-file-bytes"]);
  const maxTotalBytes = Number(flags["max-total-bytes"]);
  for (const [key, value] of [["max-files", maxFiles], ["max-file-bytes", maxFileBytes], ["max-total-bytes", maxTotalBytes]]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${key} must be a positive integer`);
  }
  const found = [];
  walkTree(root, [], found);
  const files = [];
  const skipped = [];
  let truncated = false;
  let totalBytes = 0;
  for (const entry of found) {
    const path = entry.relative.join("/");
    if (!entry.isFile) {
      skipped.push(path);
      continue;
    }
    if (files.length >= maxFiles) {
      truncated = true;
      skipped.push(path);
      continue;
    }
    let stat;
    try {
      stat = statSync(join(root, ...entry.relative));
    } catch {
      skipped.push(path);
      continue;
    }
    if (stat.size > maxFileBytes || totalBytes + stat.size > maxTotalBytes) {
      truncated = true;
      skipped.push(path);
      continue;
    }
    const bytes = readFileSync(join(root, ...entry.relative));
    totalBytes += bytes.byteLength;
    files.push({
      path,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      base64: bytes.toString("base64"),
    });
  }
  emit({ tree: { files, truncated, skipped: skipped.sort() } });
}

async function modeDeliverCredential(flags) {
  const variable = String(flags.variable ?? "");
  if (!/^[A-Z][A-Z0-9_]*$/.test(variable)) throw new Error("--variable is not an allowlisted environment entry");
  // The value arrives on stdin, never in argv (which is world-readable in /proc) and
  // never in the environment (which `container inspect` prints verbatim).
  const payload = JSON.parse(await readStdin(64 * 1024));
  if (typeof payload.value !== "string" || payload.value === "") throw new Error("credential value is empty");
  const response = await new Promise((resolve, reject) => {
    const socket = netConnect(CONTROL_SOCKET);
    let buffer = "";
    socket.setTimeout(10_000);
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "credential", variable, value: payload.value })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("the supervisor control socket timed out"));
    });
    socket.once("error", reject);
    socket.once("close", () => {
      try {
        resolve(JSON.parse(buffer.trim()));
      } catch {
        reject(new Error("the supervisor returned an unreadable control frame"));
      }
    });
  });
  if (response.ok !== true) throw new Error(String(response.error ?? "the supervisor refused the credential"));
  // Only the NAME is ever echoed back.
  emit({ variable });
}

async function modeValidate() {
  const request = JSON.parse(await readStdin(64 * 1024 * 1024));
  mkdirSync(CONTROL_DIR, { recursive: true });

  if (Array.isArray(request.validatorBundle)) {
    if (typeof request.validatorEntry !== "string" || request.validatorEntry === "") {
      throw new Error("validatorEntry is required when validatorBundle is provided");
    }
    const safeEntry = assertSafeRelativePath(request.validatorEntry);
    const MAX_BUNDLE_FILES = 32;
    const MAX_BUNDLE_FILE_BYTES = 256 * 1024;
    const MAX_BUNDLE_TOTAL_BYTES = 1024 * 1024;
    if (request.validatorBundle.length === 0) {
      throw new Error("validatorBundle must not be empty");
    }
    if (request.validatorBundle.length > MAX_BUNDLE_FILES) {
      throw new Error("validatorBundle exceeds maximum file count");
    }
    const validatorDir = join(CONTROL_DIR, "validator");
    const validatedFiles = [];
    const seenPaths = new Set();
    let totalBytes = 0;
    let entryFound = false;

    for (const file of request.validatorBundle) {
      if (typeof file !== "object" || file === null || typeof file.path !== "string" || typeof file.base64 !== "string") {
        throw new Error("malformed file in validatorBundle");
      }
      const safePath = assertSafeRelativePath(file.path);
      if (seenPaths.has(safePath)) {
        throw new Error(`duplicate path in validatorBundle: ${safePath}`);
      }
      seenPaths.add(safePath);
      if (safePath === safeEntry) {
        entryFound = true;
      }
      if (file.base64.length > 4 * Math.ceil(MAX_BUNDLE_FILE_BYTES / 3)) {
        throw new Error("validatorBundle exceeds per-file bytes limit");
      }
      const buf = Buffer.from(file.base64, "base64");
      if (buf.byteLength > MAX_BUNDLE_FILE_BYTES) {
        throw new Error("validatorBundle exceeds per-file bytes limit");
      }
      if (buf.toString("base64") !== file.base64) {
        throw new Error(`non-canonical base64 in validatorBundle: ${safePath}`);
      }
      totalBytes += buf.byteLength;
      if (totalBytes > MAX_BUNDLE_TOTAL_BYTES) {
        throw new Error("validatorBundle exceeds total bytes limit");
      }
      validatedFiles.push({ path: safePath, bytes: buf });
    }

    if (!entryFound) {
      throw new Error(`validatorEntry ${safeEntry} not found in validatorBundle`);
    }
    for (const { path } of validatedFiles) {
      const segments = path.split("/");
      for (let i = 1; i < segments.length; i++) {
        if (seenPaths.has(segments.slice(0, i).join("/"))) {
          throw new Error("validatorBundle contains conflicting file and directory paths");
        }
      }
    }
    // Validate the entire bundle before materializing or importing any member.
    mkdirSync(validatorDir, { recursive: true });
    for (const file of validatedFiles) {
      const targetPath = join(validatorDir, file.path);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, file.bytes, { mode: 0o400, flag: "wx" });
    }

    const entryFullPath = join(validatorDir, safeEntry);
    const loaded = await import(pathToFileURL(entryFullPath).href);
    if (typeof loaded.validateSnapshot !== "function") {
      throw new Error("validator does not export validateSnapshot()");
    }
    const outcome = loaded.validateSnapshot(request.input);
    emit({ outcome });
    return;
  }

  if (typeof request.validatorSource === "string" && request.validatorSource !== "") {
    const validatorPath = join(CONTROL_DIR, "validator.ts");
    writeFileSync(validatorPath, request.validatorSource, { mode: 0o400 });
    const loaded = await import(pathToFileURL(validatorPath).href);
    if (typeof loaded.validateSnapshot !== "function") throw new Error("validator does not export validateSnapshot()");
    const outcome = loaded.validateSnapshot(request.input);
    emit({ outcome });
    return;
  }

  throw new Error("validatorBundle or validatorSource is required");
}

async function modeAgent(flags) {
  if (Object.keys(flags).length !== 0) {
    throw new Error("agent mode accepts configuration only through framed stdin");
  }
  const { runGuestAgent } = await import("./guest-runtime/src/harnesses/pi/guest-agent.mjs");
  await runGuestAgent({ controlSocket: CONTROL_SOCKET });
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  switch (mode) {
    case "supervise":
      return modeSupervise();
    case "attest":
      return modeAttest();
    case "stage":
      return modeStage();
    case "export":
      return modeExport(parseFlags(rest));
    case "deliver-credential":
      return modeDeliverCredential(parseFlags(rest));
    case "validate":
      return modeValidate();
    case "agent":
      return modeAgent(parseFlags(rest));
    default:
      throw new Error(`unknown mode: ${String(mode)}`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => fail(error && error.message ? error.message : error));
}
