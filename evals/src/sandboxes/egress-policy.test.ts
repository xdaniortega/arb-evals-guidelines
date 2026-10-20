/**
 * Declared egress policy vs. enforced egress rule.
 *
 * The declared `NetworkPolicy` is what gets hashed into the parity binding, so if the
 * guest entrypoint enforced a DIFFERENT port list, sealed evidence would assert something
 * the guest never did. The TCP port list is derived from the declared one: `configure-egress.sh` reads
 * `EVAL_ALLOWED_TCP_PORTS` and fails closed without it, and the sandbox supplies that
 * value from the policy the network was created with.
 *
 * Recording command doubles also compare the entrypoint's actual IPv4 and IPv6 rules
 * with the declared denied ranges. No host firewall or container runtime is touched.
 */

import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalError } from "../core/types.ts";
import { EVAL_NETWORK_POLICY } from "../runner/run.ts";
import { ALLOWED_TCP_PORTS_VARIABLE, egressProbeViolations, encodeAllowedTcpPorts } from "./apple-container.ts";

const evalsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = join(evalsRoot, "container", "configure-egress.sh");

/** Executes the real entrypoint using recording doubles; never changes host firewall rules. */
async function enforcedRules(options: { ports?: string; profile?: string; omitIpv6?: boolean; failTool?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "eval-egress-rules-"));
  const callsPath = join(root, "calls.txt");
  try {
    const recordingTool = `#!/bin/sh
printf '%s' "\${0##*/}" >> "$EVAL_TEST_CALLS"
printf ' %s' "$@" >> "$EVAL_TEST_CALLS"
printf '\\n' >> "$EVAL_TEST_CALLS"
if [ "\${EVAL_TEST_FAIL_TOOL:-}" = "\${0##*/}" ]; then exit 1; fi
`;
    for (const name of ["iptables", "setpriv", ...(options.omitIpv6 ? [] : ["ip6tables"])]) {
      await writeFile(join(root, name), recordingTool, { mode: 0o700 });
    }
    const result = spawnSync("/bin/sh", [scriptPath, "true"], {
      env: {
        PATH: root,
        EVAL_TEST_CALLS: callsPath,
        EVAL_TEST_FAIL_TOOL: options.failTool ?? "",
        EVAL_EGRESS_PROFILE: options.profile ?? "public",
        EVAL_ALLOWED_TCP_PORTS: options.ports ?? encodeAllowedTcpPorts(EVAL_NETWORK_POLICY.allowPublicTcpPorts, "test"),
      },
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    if (result.error) throw result.error;
    const calls = (await readFile(callsPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
    return { status: result.status, stderr: result.stderr, calls };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("declared network policy and enforced egress cannot diverge", () => {
  it("enforces exactly the recorded denied ranges while allowing public IPv4 access", async () => {
    expect(EVAL_NETWORK_POLICY.allowPublicTcpPorts).toBe("all");
    expect(EVAL_NETWORK_POLICY.allowPublicDns).toBe(true);
    const result = await enforcedRules();
    expect(result.status, result.stderr).toBe(0);
    const ipv4Denials = result.calls
      .filter((line) => line.startsWith("iptables -A OUTPUT -d "))
      .map((line) => line.split(" ")[4]);
    expect(ipv4Denials).toEqual([
      "0.0.0.0/8",
      "10.0.0.0/8",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "224.0.0.0/4",
      "255.255.255.255/32",
    ]);
    expect(result.calls).toContain("iptables -P OUTPUT ACCEPT");
    expect(result.calls).toContain("ip6tables -P OUTPUT DROP");
    expect([...ipv4Denials, "::/0"]).toEqual(EVAL_NETWORK_POLICY.denyRanges);
    expect(result.calls.some((line) => line.includes("--dports"))).toBe(false);
    expect(result.calls.at(-1)).toBe("setpriv --no-new-privs --reuid 10001 --regid 10001 --clear-groups true");
  });

  it("enforces a restricted port list when that policy is selected", async () => {
    const result = await enforcedRules({ ports: encodeAllowedTcpPorts([443, 80], "test") });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("iptables -A OUTPUT -p tcp -m multiport ! --dports 80,443 -j REJECT");
  });

  it.each(["", "443;true"])("refuses startup for missing or malformed ports: %j", async (ports) => {
    const result = await enforcedRules({ ports });
    expect(result.status).toBe(90);
    expect(result.calls.some((line) => line.startsWith("setpriv "))).toBe(false);
  });

  it.each([{ omitIpv6: true }, { failTool: "ip6tables" }, { failTool: "iptables" }])("fails closed when firewall enforcement is unavailable: %j", async (options) => {
    const result = await enforcedRules(options);
    expect(result.status).toBe(90);
    expect(result.calls.some((line) => line.startsWith("setpriv "))).toBe(false);
  });

  it("encodes the declared policy into exactly the string the script enforces", () => {
    expect(encodeAllowedTcpPorts(EVAL_NETWORK_POLICY.allowPublicTcpPorts, "test")).toBe("all");
    expect(encodeAllowedTcpPorts([443, 80], "test")).toBe("80,443");
  });

  it("refuses an allowlist that could not be enforced", () => {
    for (const ports of [[], [0], [70_000], [1.5]]) {
      let caught: unknown;
      try {
        encodeAllowedTcpPorts(ports, "test");
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EvalError);
      expect((caught as EvalError).code).toBe("input-invalid");
    }
  });

  it("derives every public egress probe expectation from the same declared allowlist", async () => {
    const supervisor = await readFile(join(evalsRoot, "container", "run-measured.mjs"), "utf8");
    expect(supervisor).toContain(`process.env.${ALLOWED_TCP_PORTS_VARIABLE}`);
    // The expectation is computed from the declared list, allowing both "all" and specific port lists.
    expect(supervisor).toContain(
      'expectation: ports === "all" || (Array.isArray(ports) && ports.includes(port)) ? "connected" : "blocked"',
    );
    expect(supervisor).toContain("const PUBLIC_PROBE_PORTS = [443, 80];");
  });

  it("keeps the isolated validator profile at total denial", async () => {
    const result = await enforcedRules({ profile: "none", ports: "" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.slice(0, -1)).toEqual(["iptables -P OUTPUT DROP", "ip6tables -P OUTPUT DROP"]);
  });
});


/** Socket doubles keep these protocol tests independent of host routing/firewall rules. */
class DatagramDouble extends EventEmitter {
  broadcast = false;
  closed = false;
  boundHost = "";
  sendError: string | null = null;
  bindError: string | null = null;
  onSend: ((payload: Buffer) => void) | undefined;
  bind(_port: number, host: string, callback: () => void) {
    this.boundHost = host;
    if (this.bindError) throw Object.assign(new Error(this.bindError), { code: this.bindError });
    callback();
  }
  address() { return { port: 43123 }; }
  setBroadcast(enabled: boolean) { this.broadcast = enabled; }
  send(payload: Buffer, _port: number, host: string, callback: (error: Error | null) => void) {
    if (host === "255.255.255.255" && !this.broadcast) {
      callback(Object.assign(new Error("broadcast not enabled"), { code: "EACCES" }));
      return;
    }
    this.onSend?.(payload);
    callback(this.sendError ? Object.assign(new Error(this.sendError), { code: this.sendError }) : null);
  }
  close() { this.closed = true; }
}

async function guestProbes() {
  return import(pathToFileURL(join(evalsRoot, "container", "run-measured.mjs")).href);
}

describe("UDP firewall probe semantics", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["239.255.42.99", "255.255.255.255"])("detects permitted UDP traffic to %s without requiring a remote service", async (host) => {
    const { probeUdpSend } = await guestProbes();
    const socket = new DatagramDouble();
    const result = await probeUdpSend(host, 9, { createSocket: (type: string) => { expect(type).toBe("udp4"); return socket; } });
    expect(result.outcome).toBe("connected");
    expect(socket.broadcast).toBe(true);
    expect(socket.closed).toBe(true);
  });

  it.each([
    // Only the synchronous netfilter verdict (EPERM) is firewall enforcement. EACCES is a
    // socket-option/permission failure (e.g. SO_BROADCAST) and the *UNREACH/EADDRNOTAVAIL codes
    // are routing failures before netfilter, so none of those may be reported as "blocked".
    ["EPERM", "blocked"], ["EACCES", "inconclusive"],
    ["ENETUNREACH", "inconclusive"], ["EHOSTUNREACH", "inconclusive"], ["EADDRNOTAVAIL", "inconclusive"],
  ])("classifies UDP send failure %s as %s", async (code, expected) => {
    const { probeUdpSend } = await guestProbes();
    const socket = new DatagramDouble();
    socket.sendError = code!;
    const result = await probeUdpSend("255.255.255.255", 9, { createSocket: () => socket });
    expect(result.outcome).toBe(expected);
    expect(result.detail).toBe(code);
    expect(socket.closed).toBe(true);
  });

  it("does not report socket setup refusal as firewall enforcement", async () => {
    const { probeUdpSend } = await guestProbes();
    const socket = new DatagramDouble();
    socket.bindError = "EACCES";
    const result = await probeUdpSend("239.255.42.99", 9, { createSocket: () => socket });
    expect(result.outcome).toBe("inconclusive");
  });

  it.each([false, true])("detects whether UDP6 reaches the listening loopback endpoint: %s", async (delivered) => {
    const { probeIpv6Loopback } = await guestProbes();
    vi.useFakeTimers();
    const receiver = new DatagramDouble();
    const sender = new DatagramDouble();
    if (delivered) sender.onSend = (payload) => receiver.emit("message", payload);
    const sockets = [receiver, sender];
    const resultPromise = probeIpv6Loopback({ createSocket: (type: string) => { expect(type).toBe("udp6"); return sockets.shift(); }, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    const result = await resultPromise;
    expect(result.outcome).toBe(delivered ? "connected" : "blocked");
    expect(result.port).toBe(43123);
    expect(receiver.boundHost).toBe("::1");
    expect(sender.boundHost).toBe("::1");
    expect(receiver.closed && sender.closed).toBe(true);
  });

  it("reports unavailable IPv6 explicitly instead of claiming the firewall was observed", async () => {
    const { probeIpv6Loopback } = await guestProbes();
    const receiver = new DatagramDouble();
    receiver.bindError = "EAFNOSUPPORT";
    const sender = new DatagramDouble();
    const sockets = [receiver, sender];
    const result = await probeIpv6Loopback({ createSocket: () => sockets.shift() });
    expect(result.outcome).toBe("inconclusive");
    expect(result.detail).toContain("IPv6 loopback unavailable: EAFNOSUPPORT");
    expect(receiver.closed && sender.closed).toBe(true);
  });

  it.each([["EPERM", "blocked"], ["EACCES", "inconclusive"], ["ENETUNREACH", "inconclusive"]])("distinguishes IPv6 send rejection %s from missing routing", async (code, expected) => {
    const { probeIpv6Loopback } = await guestProbes();
    const receiver = new DatagramDouble();
    const sender = new DatagramDouble();
    sender.sendError = code!;
    const sockets = [receiver, sender];
    const result = await probeIpv6Loopback({ createSocket: () => sockets.shift() });
    expect(result.outcome).toBe(expected);
    expect(result.port).toBe(43123);
    expect(receiver.closed && sender.closed).toBe(true);
  });
});

function completeProbeFrame() {
  return [
    ["metadata", "private", "tcp", "169.254.169.254", 80],
    ["private-10", "private", "tcp", "10.0.0.1", 80],
    ["private-192", "private", "tcp", "192.168.64.1", 53],
    ["guest-loopback", "private", "tcp", "127.0.0.1", 22],
    ["public-80", "public", "tcp", "1.1.1.1", 80],
    ["public-443", "public", "tcp", "1.1.1.1", 443],
    ["ipv4-multicast", "multicast", "udp", "239.255.42.99", 9],
    ["ipv4-broadcast", "broadcast", "udp", "255.255.255.255", 9],
    ["ipv6-loopback", "ipv6", "udp", "::1", 43123],
  ].map(([label, category, protocol, host, port]) => ({
    label: String(label), category: String(category), protocol: String(protocol), host: String(host), port: Number(port),
    expectation: category === "public" ? "connected" : "blocked",
    outcome: category === "public" ? "connected" : "blocked", detail: "test observation", durationMs: 1,
  }));
}

describe("required egress observations", () => {
  it("accepts the complete observed protocol and destination set", () => {
    expect(egressProbeViolations(completeProbeFrame(), "all")).toEqual([]);
  });

  it.each(["missing", "tcp", "inconclusive", "rewritten expectation"])("rejects a multicast probe that is %s", (variant) => {
    const probes = completeProbeFrame();
    const multicast = probes.find((probe) => probe.category === "multicast")!;
    if (variant === "missing") probes.splice(probes.indexOf(multicast), 1);
    else if (variant === "tcp") multicast.protocol = "tcp";
    else if (variant === "inconclusive") multicast.outcome = "inconclusive";
    else { multicast.expectation = "connected"; multicast.outcome = "connected"; }
    expect(egressProbeViolations(probes, "all").join(" ")).toContain("ipv4-multicast");
  });

  it("uses the host's selected public TCP allowlist", () => {
    const probes = completeProbeFrame();
    expect(egressProbeViolations(probes, [443]).join(" ")).toContain("public-80");
    const http = probes.find((probe) => probe.label === "public-80")!;
    http.expectation = "blocked";
    http.outcome = "blocked";
    expect(egressProbeViolations(probes, [443])).toEqual([]);
  });
});
