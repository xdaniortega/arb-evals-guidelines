/** Opt-in real-guest proof of public access and denial of a listening laptop service. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRunJournal } from "../artifacts/store.ts";
import { resourceNameFor } from "../core/experiment.ts";
import { SAFE_DEFAULT_LIMITS, type ConditionId } from "../core/types.ts";
import { EVAL_GUEST_POLICY, EVAL_NETWORK_POLICY } from "../runner/run.ts";
import { createAppleContainerSandbox } from "./apple-container.ts";

function containerAvailable(): boolean {
  if (process.env.EVAL_CONTAINER_TESTS !== "1" || process.platform !== "darwin" || process.arch !== "arm64") return false;
  try {
    execFileSync("container", ["--version"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function privateHostAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const [a, b] = entry.address.split(".").map(Number);
      if (a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)) return entry.address;
    }
  }
  throw new Error("Laptop isolation validation requires a private IPv4 host interface for its controlled listener.");
}

const GUEST_PROBE = `
const {connect} = require('node:net');
const {host, port} = JSON.parse(process.argv[1]);
const socket = connect({host, port});
let settled = false;
function finish(outcome, detail) {
  if (settled) return;
  settled = true;
  socket.destroy();
  console.log(JSON.stringify({outcome, detail}));
}
socket.setTimeout(3000);
socket.once('connect', () => finish('connected', 'tcp handshake completed'));
socket.once('timeout', () => finish('blocked', 'timeout'));
socket.once('error', error => finish('blocked', error.code));
`;

describe.skipIf(!containerAvailable())("real laptop isolation", () => {
  it("gives each fresh arm public access while denying a live service on the laptop", async () => {
    const host = privateHostAddress();
    const listener = createServer((socket) => socket.destroy());
    const runId = `20260101t000000z-${randomBytes(4).toString("hex")}`;
    const nonce = randomBytes(4).toString("hex");
    const stateDir = await mkdtemp(join(tmpdir(), "eval-laptop-isolation-"));
    const journal = await createRunJournal({ stateDir, runId, nonce });
    const sandbox = createAppleContainerSandbox({ runId, labels: { "eval-test": runId } });
    const owned: Array<{ kind: "guest" | "network"; name: string; conditionId: ConditionId }> = [];
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen({ host, port: 0 }, () => resolve());
      });
      const address = listener.address();
      if (address === null || typeof address === "string") throw new Error("The laptop probe listener has no TCP address.");
      const port = address.port;
      // A reachable host-side listener avoids treating a closed service port as proof of filtering.
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host, port });
        socket.setTimeout(3_000);
        socket.once("connect", () => { socket.destroy(); resolve(); });
        socket.once("error", reject);
        socket.once("timeout", () => { socket.destroy(); reject(new Error("The host-side listener probe timed out.")); });
      });
      const image = await sandbox.buildImage({
        runtimeProfileId: "default",
        contextDir: fileURLToPath(new URL("../../container/", import.meta.url)),
      });
      for (const conditionId of ["baseline", "treatment"] as const) {
        const networkName = resourceNameFor("net", { runId, resourceNonce: nonce }, 1, conditionId);
        const guestName = resourceNameFor("guest", { runId, resourceNonce: nonce }, 1, conditionId);
        const network = { kind: "network" as const, name: networkName, conditionId };
        await journal.record({ ...network, event: "intent", action: "create", status: null });
        owned.push(network);
        await sandbox.createNetwork(networkName, EVAL_NETWORK_POLICY);
        await journal.record({ ...network, event: "observed", action: "create", status: "created" });
        const guestIdentity = { kind: "guest" as const, name: guestName, conditionId };
        await journal.record({ ...guestIdentity, event: "intent", action: "create", status: null });
        owned.push(guestIdentity);
        const guest = await sandbox.createGuest({
          name: guestName,
          networkName,
          imageDigest: image.digest,
          limits: SAFE_DEFAULT_LIMITS,
          policy: EVAL_GUEST_POLICY,
          env: { HOME: "/home/agent", TMPDIR: "/tmp" },
        });
        await journal.record({ ...guestIdentity, event: "observed", action: "create", status: "created" });
        const attestation = await guest.attest();
        expect(attestation.egress.publicDnsAllowed).toBe(true);
        const publicProbes = attestation.observed.egressProbes.filter((probe) => probe.category === "public");
        expect(publicProbes).toHaveLength(2);
        expect(publicProbes.every((probe) => probe.outcome === "connected")).toBe(true);
        const udpProbes = attestation.observed.egressProbes.filter((probe) => probe.protocol === "udp");
        expect(udpProbes.map((probe) => probe.category).sort()).toEqual(["broadcast", "ipv6", "multicast"]);
        expect(udpProbes.every((probe) => probe.outcome === "blocked")).toBe(true);
        const probe = await guest.exec({
          command: ["node", "-e", GUEST_PROBE, JSON.stringify({ host, port })],
          cwd: "/work",
          timeoutMs: 10_000,
          maxOutputBytes: 4_096,
        });
        expect(probe.exitCode, probe.stderr).toBe(0);
        expect(probe.timedOut).toBe(false);
        expect(probe.truncated).toBe(false);
        expect(JSON.parse(probe.stdout).outcome, `${conditionId} reached the laptop listener`).toBe("blocked");
      }
      expect(new Set(owned.filter((item) => item.kind === "network").map((item) => item.name)).size).toBe(2);
    } finally {
      if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
      const failures: unknown[] = [];
      for (const resource of [...owned].reverse()) {
        try { await journal.record({ ...resource, event: "intent", action: "destroy", status: null }); }
        catch (error) { failures.push(error); }
        try {
          const outcome = await sandbox.destroyResource(resource.kind, resource.name);
          await journal.record({ ...resource, event: "observed", action: "destroy", status: outcome.status });
          if (!outcome.verified) failures.push(new Error(`Unverified cleanup: ${resource.name}`));
          if (await sandbox.inspectResource(resource.kind, resource.name) !== "absent") failures.push(new Error(`Resource survived cleanup: ${resource.name}`));
        } catch (error) { failures.push(error); }
      }
      if (failures.length > 0) throw new AggregateError(failures, `Laptop isolation cleanup failed; journal retained at ${journal.path}`);
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 240_000);
});
