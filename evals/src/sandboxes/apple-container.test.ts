/**
 * Real Apple Container conformance and isolation proof.
 *
 * These tests build an image, start guests, and talk to the `container` CLI, so they are
 * slow and host-dependent. They are therefore OPT-IN: they run only when
 * `EVAL_CONTAINER_TESTS=1` and the CLI is present, and otherwise report a VISIBLE skip
 * rather than silently disappearing — an absent test and a passing test must never look
 * the same.
 *
 * Run them with `pnpm test:container`.
 *
 * Every identity they create is exact, namespaced with a per-run nonce, and destroyed.
 */

import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { randomBytes } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createRunJournal, type RunJournal } from "../artifacts/store.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resourceNameFor, sha256Hex } from "../core/experiment.ts";
import { SAFE_DEFAULT_LIMITS } from "../core/types.ts";
import { redactSecrets } from "../core/secret-scan.ts";
import { EVAL_NETWORK_POLICY } from "../runner/run.ts";
import { recoverRun } from "../runner/recover.ts";
import type { GuestPolicy, GuestStreamSession, Sandbox } from "./sandbox.ts";
import { APPLE_CONTAINER_SANDBOX_ID, AppleContainerGuest, createAppleContainerSandbox, runContainerCli } from "./apple-container.ts";
import { defineSandboxConformance } from "./conformance.ts";

const OPT_IN_VARIABLE = "EVAL_CONTAINER_TESTS";
const evalsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const contextDir = join(evalsRoot, "container");

function cliAvailable(): boolean {
  try {
    execFileSync("container", ["--version"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const optIn = process.env[OPT_IN_VARIABLE] === "1";
const available = optIn && cliAvailable();

const policy: GuestPolicy = {
  readOnlyRoot: true,
  writablePaths: ["/work", "/home/agent", "/tmp", "/run/eval"],
  uid: 10_001,
  gid: 10_001,
  noNewPrivileges: true,
  dropCapabilities: true,
};

function runIdFor(): string {
  return `20260101t000000z-${randomBytes(4).toString("hex")}`;
}

async function cleanupSdkTestResources(
  sandbox: Pick<Sandbox, "destroyResource" | "inspectResource">,
  journal: Pick<RunJournal, "record">,
  resources: ReadonlyArray<readonly ["guest" | "network", string]>,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const [kind, name] of resources) {
    try { await journal.record({ event: "intent", action: "destroy", kind, name, conditionId: "baseline", status: null }); }
    catch (error) { errors.push(error); }
    // Creation ownership is already established. Journal failure cannot veto cleanup.
    try {
      const outcome = await sandbox.destroyResource(kind, name);
      try { await journal.record({ event: "observed", action: "destroy", kind, name, conditionId: "baseline", status: outcome.status }); }
      catch (error) { errors.push(error); }
      if (!outcome.verified) errors.push(new Error(`destruction was not verified for ${kind}:${name}`));
    } catch (error) { errors.push(error); }
    try {
      if (await sandbox.inspectResource(kind, name) !== "absent") errors.push(new Error(`${kind}:${name} survived cleanup`));
    } catch (error) { errors.push(error); }
  }
  return errors;
}


/**
 * Host-independent behaviour: these never touch the runtime, so they run everywhere and
 * keep the fast path meaningful even when the opt-in tests are skipped.
 */
describe("apple-container boundaries", () => {
  afterEach(() => vi.useRealTimers());

  function fakeChild() {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const signals: string[] = [];
    const child = {
      pid: undefined,
      stdin,
      stdout,
      stderr,
      kill(signal: NodeJS.Signals) { signals.push(signal); return true; },
      once: (event: string, listener: (...args: any[]) => void) => {
        if (event === "close") (child as any).onClose = listener;
        if (event === "error") (child as any).onError = listener;
        return child;
      },
      on: () => child,
      signals,
    } as any;
    return child;
  }

  function guestWithSpawn(spawnProcess: typeof import("node:child_process").spawn) {
    return new AppleContainerGuest({
      spec: { name: "offline-guest", networkName: "offline-net", imageDigest: "sha256:offline", limits: SAFE_DEFAULT_LIMITS, policy, env: {} },
      cliPath: "container",
      timeoutMs: 5_000,
      labels: [],
      allowedTcpPorts: "all",
      spawnProcess,
      destroyed: false,
      attested: false,
      deliveredCredentialVariables: [],
      lastAttestation: null,
    });
  }

  it("distinguishes cooperative execStream close from forced timeout and abort settlement offline", async () => {
    vi.useFakeTimers();
    const cooperative = fakeChild();
    const cooperativeGuest = guestWithSpawn((() => cooperative) as any);
    const stream = await cooperativeGuest.execStream({ command: ["true"], cwd: "/work" });
    cooperative.onClose?.(17);
    await expect(stream.exitCode).resolves.toBe(17);
    await expect(stream.termination).resolves.toBe("confirmed");

    const forced = fakeChild();
    const forcedGuest = guestWithSpawn((() => forced) as any);
    const timed = await forcedGuest.execStream({ command: ["true"], cwd: "/work", timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(forced.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(forced.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(forced.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(timed.exitCode).resolves.toBeNull();
    await expect(timed.termination).resolves.toBe("forced");

    const aborted = fakeChild();
    const abortController = new AbortController();
    const abortedGuest = guestWithSpawn((() => aborted) as any);
    const abortedStream = await abortedGuest.execStream({ command: ["true"], cwd: "/work", signal: abortController.signal });
    abortController.abort();
    expect(aborted.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(aborted.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(abortedStream.exitCode).resolves.toBeNull();
    await expect(abortedStream.termination).resolves.toBe("forced");
  });

  it("keeps runContainerCli SIGTERM, SIGKILL@2s, and forced finish@3s deterministic offline", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const result = runContainerCli(["offline"], { timeoutMs: 100, spawnProcess: (() => child) as any });
    await vi.advanceTimersByTimeAsync(100);
    expect(child.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(child.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ code: null, timedOut: true, aborted: false });
  });

  it("keeps unlimited streams alive until cancellation and settles after cancellation", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const controller = new AbortController();
    const guest = guestWithSpawn((() => child) as any);
    const stream = await guest.execStream({ command: ["true"], cwd: "/work", signal: controller.signal });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(child.signals).toEqual([]);
    controller.abort();
    expect(child.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(stream.exitCode).resolves.toBeNull();
    await expect(stream.termination).resolves.toBe("forced");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("loads the production lock closure through buildImage before an offline cache lookup", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "eval-locked-profile-"));
    const fakeCli = join(tempRoot, "container-cli");
    try {
      await writeFile(fakeCli, `#!/bin/sh\nprintf '[{"configuration":{"descriptor":{"digest":"sha256:%s"}}}]\\n' '${"a".repeat(64)}'\n`, { mode: 0o755 });
      const sandbox = createAppleContainerSandbox({ runId: runIdFor(), cliPath: fakeCli });
      await expect(sandbox.buildImage({ runtimeProfileId: "default", contextDir })).resolves.toMatchObject({
        digest: `sha256:${"a".repeat(64)}`, cacheHit: true, testDouble: false,
      });
    } finally { await rm(tempRoot, { recursive: true, force: true }); }
  });

  it("does not spawn the production CLI boundary after its absolute deadline", async () => {
    await expect(runContainerCli(["--version"], { cliPath: "must-not-spawn", deadlineAtMs: Date.now() - 1 })).rejects.toMatchObject({ code: "interrupted" });
  });

  it("attempts all exact cleanup operations even when journal writes fail", async () => {
    const calls: string[] = [];
    const errors = await cleanupSdkTestResources({
      destroyResource: async (kind, name) => { calls.push(`destroy:${kind}:${name}`); return { status: "destroyed", verified: true, failure: null }; },
      inspectResource: async (kind, name) => { calls.push(`inspect:${kind}:${name}`); return "absent"; },
    }, { record: async () => { throw new Error("synthetic journal I/O failure"); } }, [["guest", "owned-guest"], ["network", "owned-network"]]);
    expect(calls).toEqual(["destroy:guest:owned-guest", "inspect:guest:owned-guest", "destroy:network:owned-network", "inspect:network:owned-network"]);
    expect(errors).toHaveLength(4);
  });

  it("reports readiness rather than throwing when the CLI is absent", async () => {
    const sandbox = createAppleContainerSandbox({ runId: runIdFor(), cliPath: "container-does-not-exist" });
    const probe = await sandbox.probe();
    expect(probe.ready).toBe(false);
    expect(probe.details.some((detail) => detail.status !== "ok")).toBe(true);
  });

  it("refuses a guest policy that does not match the locked non-root identity", async () => {
    const sandbox = createAppleContainerSandbox({ runId: runIdFor(), cliPath: "container-does-not-exist" });
    await expect(
      sandbox.createGuest({
        name: "eval-never-created",
        networkName: "eval-never-created-net",
        imageDigest: "sha256:" + "0".repeat(64),
        limits: SAFE_DEFAULT_LIMITS,
        policy: { ...policy, uid: 1_000, gid: 1_000 },
        env: {},
      }),
    ).rejects.toMatchObject({ code: "platform-unsupported" });
  });

  it("derives EVAL_SUPERVISOR_MAX_MS to cover realistic serial second-arm pre-prompt wait plus execution allowance, and preserves deadlineAtMs clamp", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "eval-supervisor-ms-"));
    const fakeCli = join(tempRoot, "container-cli");
    const cliArgsLog = join(tempRoot, "cli-args.json");
    try {
      await writeFile(fakeCli, `#!/bin/sh
if [ "$1 $2" = "image inspect" ]; then
  printf '[{"configuration":{"descriptor":{"digest":"sha256:%s"}}}]\\n' '${"a".repeat(64)}'
  exit 0
fi
if [ "$1" = "network" ]; then
  exit 0
fi
printf '%s\\n' "$*" > '${cliArgsLog}'
exit 1
`, { mode: 0o755 });

      const sandbox = createAppleContainerSandbox({ runId: runIdFor(), cliPath: fakeCli });
      const image = await sandbox.buildImage({ runtimeProfileId: "default", contextDir });
      await sandbox.createNetwork("eval-treatment-net", EVAL_NETWORK_POLICY);

      // 1. Generous deadline: EVAL_SUPERVISOR_MAX_MS must cover realistic serial pre-prompt wait plus wallClockMs
      const generousDeadline = Date.now() + 3_000_000;
      await expect(sandbox.createGuest({
        name: "eval-treatment-child",
        networkName: "eval-treatment-net",
        imageDigest: image.digest,
        limits: { ...SAFE_DEFAULT_LIMITS, wallClockMs: 110_000 },
        policy,
        env: {},
        deadlineAtMs: generousDeadline,
      })).rejects.toThrow();

      const rawArgs = (await readFile(cliArgsLog, "utf8")).split(" ");
      const supervisorEnvArg = rawArgs.find((arg) => arg.startsWith("EVAL_SUPERVISOR_MAX_MS="));
      expect(supervisorEnvArg).toBeDefined();
      const supervisorMs = Number(supervisorEnvArg!.split("=")[1]);

      // Its own setup plus sibling setup/capture and serial prompt cannot consume its prompt.
      expect(supervisorMs).toBe(1_220_000);

      await expect(sandbox.createGuest({
        name: "eval-ten-minute-child",
        networkName: "eval-treatment-net",
        imageDigest: image.digest,
        limits: { ...SAFE_DEFAULT_LIMITS, wallClockMs: 600_000 },
        policy, env: {}, deadlineAtMs: generousDeadline,
      })).rejects.toThrow();
      const maximumArgs = (await readFile(cliArgsLog, "utf8")).split(" ");
      const maximumLifetime = maximumArgs.find((arg) => arg.startsWith("EVAL_SUPERVISOR_MAX_MS="));
      expect(Number(maximumLifetime!.split("=")[1])).toBe(2_130_000);

      // 2. Tight deadline: must clamp to remaining run active deadline (guest can never outlive active deadline)
      const tightDeadline = Date.now() + 50_000;
      await expect(sandbox.createGuest({
        name: "eval-tight-child",
        networkName: "eval-treatment-net",
        imageDigest: image.digest,
        limits: SAFE_DEFAULT_LIMITS,
        policy,
        env: {},
        deadlineAtMs: tightDeadline,
      })).rejects.toThrow();

      // 3. Unlimited arm with no deadline explicitly disables the lifetime timer.
      await expect(sandbox.createGuest({
        name: "eval-unlimited-child",
        networkName: "eval-treatment-net",
        imageDigest: image.digest,
        limits: { ...SAFE_DEFAULT_LIMITS, wallClockMs: null },
        policy,
        env: {},
        deadlineAtMs: Number.POSITIVE_INFINITY,
      })).rejects.toThrow();
      const unlimitedArgs = (await readFile(cliArgsLog, "utf8")).split(" ");
      const unlimitedSupervisorArg = unlimitedArgs.find((arg) => arg.startsWith("EVAL_SUPERVISOR_MAX_MS="));
      expect(Number(unlimitedSupervisorArg!.split("=")[1])).toBe(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects extra runtime files and symlinks before any cache lookup or build CLI call", async () => {
    for (const unexpectedType of ["file", "symlink"] as const) {
      const tempRoot = await mkdtemp(join(tmpdir(), `eval-extra-runtime-${unexpectedType}-`));
      const copiedContext = join(tempRoot, "container");
      const cliLog = join(tempRoot, "cli.log");
      const fakeCli = join(tempRoot, "container-cli");
      try {
        await cp(contextDir, copiedContext, { recursive: true });
        await writeFile(fakeCli, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(cliLog)}\nexit 99\n`);
        await chmod(fakeCli, 0o755);
        const unexpected = join(copiedContext, "guest-runtime", unexpectedType === "file" ? "answer.txt" : "answer-link");
        if (unexpectedType === "file") await writeFile(unexpected, "must never enter image");
        else await symlink("artifact-lock.json", unexpected);
        const sandbox = createAppleContainerSandbox({ runId: runIdFor(), cliPath: fakeCli });
        await expect(sandbox.buildImage({ runtimeProfileId: "default", contextDir: copiedContext })).rejects.toMatchObject({ code: "evidence-invalid" });
        await expect(readFile(cliLog, "utf8")).rejects.toThrow();
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    }
  });

  it("refuses to build from a context whose files do not match the image lock", async () => {
    const sandbox = createAppleContainerSandbox({ runId: runIdFor(), cliPath: "container-does-not-exist" });
    const tamperedContext = await mkdtemp(join(tmpdir(), "eval-tampered-context-"));
    try {
      const lock = JSON.parse(await readFile(join(contextDir, "image-lock.json"), "utf8")) as Record<string, unknown>;
      await writeFile(join(tamperedContext, "image-lock.json"), JSON.stringify(lock));
      for (const name of ["Containerfile", ".dockerignore", "configure-egress.sh", "run-measured.mjs"]) {
        const bytes = await readFile(join(contextDir, name), "utf8");
        await writeFile(join(tamperedContext, name), name === "Containerfile" ? `${bytes}\n# tampered\n` : bytes);
      }
      await expect(
        sandbox.buildImage({ runtimeProfileId: "default", contextDir: tamperedContext }),
      ).rejects.toMatchObject({ code: "evidence-invalid" });
    } finally {
      await rm(tamperedContext, { recursive: true, force: true });
    }
  });
});

if (!available) {
  describe("sandbox conformance: apple-container", () => {
    it.skip(
      `requires ${OPT_IN_VARIABLE}=1 and a working \`container\` CLI (run: pnpm test:container)`,
      () => undefined,
    );
  });
  describe("apple-container isolation", () => {
    it.skip(
      `requires ${OPT_IN_VARIABLE}=1 and a working \`container\` CLI (run: pnpm test:container)`,
      () => undefined,
    );
  });
} else {
  // The SAME assertions the fake satisfies, against the real runtime.
  defineSandboxConformance({
    name: APPLE_CONTAINER_SANDBOX_ID,
    testDouble: false,
    timeoutMs: 60_000,
    create: async () => {
      const runId = runIdFor();
      return {
        sandbox: createAppleContainerSandbox({ runId, labels: { "eval-test": runId } }),
        contextDir,
        policy,
        limits: { ...SAFE_DEFAULT_LIMITS, cpus: 2, memoryMiB: 1_024, pids: 128 },
        namePrefix: `eval-conf-ac-${randomBytes(3).toString("hex")}`,
      };
    },
  });

  describe("apple-container isolation", () => {
    it("runs the framed Pi SDK inside a real guest with tool effects and sanitized native records", async () => {
      const nonce = randomBytes(4).toString("hex");
      const runId = `sdk-${nonce}`;
      const guestName = `eval-sdk-${nonce}-guest`;
      const networkName = `eval-sdk-${nonce}-net`;
      const stateDir = await mkdtemp(join(tmpdir(), "eval-sdk-l2-journal-"));
      const journal = await createRunJournal({ stateDir, runId, nonce });
      const sandbox = createAppleContainerSandbox({ runId, commandTimeoutMs: 5_000, readyTimeoutMs: 10_000, supervisorMaxMs: 40_000 });
      let stream: GuestStreamSession | undefined;
      let exited = false;
      const owned: Array<readonly ["guest" | "network", string]> = [];
      console.log(JSON.stringify({ phase: "sdk-l2-identities", runId, guestName, networkName, journal: journal.path }));
      try {
        // Provision cold images separately; this test checks the already locked warm image.
        const image = await sandbox.buildImage({ runtimeProfileId: "default", contextDir });
        await journal.record({ event: "intent", action: "create", kind: "network", name: networkName, conditionId: "baseline", status: null });
        owned.push(["network", networkName]);
        await sandbox.createNetwork(networkName, EVAL_NETWORK_POLICY);
        await journal.record({ event: "observed", action: "create", kind: "network", name: networkName, conditionId: "baseline", status: "created" });
        await journal.record({ event: "intent", action: "create", kind: "guest", name: guestName, conditionId: "baseline", status: null });
        owned.unshift(["guest", guestName]);
        const guest = await sandbox.createGuest({ name: guestName, networkName, imageDigest: image.digest,
          limits: SAFE_DEFAULT_LIMITS, policy, env: { HOME: "/home/agent", TMPDIR: "/tmp" } });
        await journal.record({ event: "observed", action: "create", kind: "guest", name: guestName, conditionId: "baseline", status: "created" });
        const boundary = await guest.attest();
        expect(boundary.hostMounts).toEqual([]);
        expect(boundary.uid).toBe(10001);
        const secret = `synthetic-l2-key-${nonce}`;
        await guest.deliverCredential({ variable: "GEMINI_API_KEY", value: secret });
        await guest.stage({ destDir: "/work", files: [], readOnly: false });
        expect(guest.execStream).toBeTypeOf("function");
        stream = await guest.execStream!({ command: ["node", "/opt/eval/run-measured.mjs", "agent"], cwd: "/work", timeoutMs: 15_000 });
        let stderr = "";
        let stdoutBytes = 0;
        let oversized = false;
        stream.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > 16 * 1024 * 1024) { oversized = true; stream!.kill("SIGKILL"); }
        });
        stream.stderr?.on("data", (chunk: Buffer) => {
          if (Buffer.byteLength(stderr) + chunk.byteLength > 65536) { oversized = true; stream!.kill("SIGKILL"); }
          else stderr += chunk.toString("utf8");
        });
        const frames: Array<Record<string, any>> = [];
        const init = { type: "init", protocolVersion: 1, mode: "scripted", arm: "baseline",
          target: { provider: "google", model: "gemini-3.8-flash", thinking: "low" },
          skillPath: null, allowedTools: ["read", "write", "bash"], ambientTools: [],
          skillToolBundle: null,
          skillToolBundleSha256: "f9cc8e2b85ebe6aa64c21b5be039960cdc74a5743ca280d0f84c440f745c993b",
          processLifetimeMs: 180_000, armWallClockMs: 10_000,
          limits: { maxProviderRequests: 4, maxToolSteps: 4, maxOutputTokens: 4096 }, credentialVariable: "GEMINI_API_KEY",
          scriptedSteps: [
            { type: "toolCall", toolCalls: [{ id: "write-guest", name: "write", arguments: { path: "nested/result.txt", content: "42" } }] },
            { type: "toolCall", toolCalls: [{ id: "read-env", name: "bash", arguments: { command: 'printf "%s\\n" "$GEMINI_API_KEY"; printf "%s" "$GEMINI_API_KEY" | base64' } }] },
            { type: "text", text: "done" },
          ],
        };
        stream.stdin.write(`${JSON.stringify(init)}\n`);
        const transport = stream;
        const collect = (async () => {
          for await (const line of createInterface({ input: transport.stdout })) {
            if (Buffer.byteLength(line) > 1024 * 1024 || frames.length > 10002) throw new Error("SDK protocol bound exceeded");
            const frame = JSON.parse(line) as Record<string, any>;
            frames.push(frame);
            if (frame.type === "error" || frame.ok === false) {
              throw new Error(redactSecrets(String(frame.error), [{ label: "test-key", value: secret }], "test-diagnostic").text);
            }
            if (frame.type === "ready") {
              expect(frame.process).toMatchObject({ platform: "linux", uid: 10001, gid: 10001, cwd: "/work" });
              expect(frame.attestation.loadedSkills).toEqual([]);
              transport.stdin.end(`${JSON.stringify({ type: "prompt", prompt: "write the output and inspect the supplied synthetic environment" })}\n`);
            }
          }
        })();
        const [, code] = await Promise.all([collect, stream.exitCode]);
        exited = true;
        expect(code, redactSecrets(stderr, [{ label: "test-key", value: secret }], "test-diagnostic").text).toBe(0);
        expect(oversized).toBe(false);
        const ready = frames.find((frame) => frame.type === "ready");
        const result = frames.find((frame) => frame.type === "result");
        expect(ready).toBeDefined();
        expect(result).toMatchObject({ outcome: "completed", sessionId: ready!.sessionId, terminal: { streamingStopped: true } });
        const records = frames.filter((frame) => frame.type === "record");
        expect(records[0]?.record).toMatchObject({ type: "session", id: ready!.sessionId });
        expect(records.some((frame) => frame.record.message?.toolCallId === "write-guest")).toBe(true);
        const output = JSON.stringify(frames);
        expect(output).toContain("[REDACTED:GEMINI_API_KEY]");
        expect(output).not.toContain(secret);
        expect(output).not.toContain(Buffer.from(secret).toString("base64"));
        expect(stderr).not.toContain(secret);
        const exported = await guest.exportFiles({ root: "/work", maxFiles: 8, maxFileBytes: 4096, maxTotalBytes: 8192 });
        const file = exported.files.find((entry) => entry.path === "nested/result.txt");
        expect(Buffer.from(file!.base64, "base64").toString("utf8")).toBe("42");
        console.log(JSON.stringify({ phase: "sdk-l2-verified", imageDigest: image.digest, sessionId: ready!.sessionId,
          platform: ready!.process.platform, uid: ready!.process.uid, nativeRecords: records.length, agentMs: result!.timing.durationMs }));
      } finally {
        if (stream && !exited) { stream.kill("SIGKILL"); await stream.exitCode; }
        const cleanupErrors = await cleanupSdkTestResources(sandbox, journal, owned);
        if (cleanupErrors.length === 0) await rm(stateDir, { recursive: true, force: true });
        else throw new AggregateError(cleanupErrors, `SDK L2 cleanup failed; journal retained at ${journal.path}`);
      }
    }, 70_000);

    it(
      "attests real observed privilege, mount, and egress facts",
      async () => {
        const runId = runIdFor();
        const sandbox = createAppleContainerSandbox({ runId, labels: { "eval-test": runId } });
        const nonce = randomBytes(3).toString("hex");
        const networkName = `eval-iso-${nonce}-net`;
        const guestName = `eval-iso-${nonce}-guest`;
        const image = await sandbox.buildImage({ runtimeProfileId: "default", contextDir });
        try {
          await sandbox.createNetwork(networkName, EVAL_NETWORK_POLICY);
          const guest = await sandbox.createGuest({
            name: guestName,
            networkName,
            imageDigest: image.digest,
            limits: { ...SAFE_DEFAULT_LIMITS, cpus: 2, memoryMiB: 1_024, pids: 128 },
            policy,
            env: { HOME: "/home/agent" },
          });
          const attestation = await guest.attest();
          expect(attestation.uid).toBe(10_001);
          expect(attestation.gid).toBe(10_001);
          expect(attestation.noNewPrivileges).toBe(true);
          expect(attestation.capabilitiesDropped).toBe(true);
          expect(attestation.readOnlyRoot).toBe(true);
          expect(attestation.hostMounts).toEqual([]);
          expect(attestation.egress.deniedRangesEnforced).toBe(true);
          expect(attestation.egress.publicDnsAllowed).toBe(true);
          expect(attestation.egress.resolverInherited).toBe(false);

          // The observed record carries REAL values, not a boolean summary of them.
          const observed = attestation.observed;
          expect(observed.source).toBe("apple-container-guest");
          expect(observed.testDouble).toBe(false);
          expect(observed.init.capEff).toBe("0000000000000000");
          expect(observed.init.groups).toEqual([]);
          expect(observed.self.uid).toBe(10_001);
          expect(observed.readOnlyRootProbe.readOnly).toBe(true);
          expect(observed.mountCount).toBeGreaterThan(0);
          expect(observed.hostBackedMounts).toEqual([]);
          expect(observed.unexpectedWritableMounts).toEqual([]);
          expect(observed.resolvers.map((resolver) => resolver.address)).toEqual(["1.1.1.1", "8.8.8.8"]);
          expect(observed.anyResolverPrivate).toBe(false);
          expect(observed.allowedTcpPorts).toBe("all");
          expect(observed.dnsProbe.ok).toBe(true);

          // Port 80 and 443 are PERMITTED, and that is proven by actual connected probes.
          const httpProbe = observed.egressProbes.find((probe) => probe.label === "public-80");
          expect(httpProbe?.expectation).toBe("connected");
          expect(httpProbe?.outcome).toBe("connected");
          const httpsProbe = observed.egressProbes.find((probe) => probe.label === "public-443");
          expect(httpsProbe?.expectation).toBe("connected");
          expect(httpsProbe?.outcome).toBe("connected");

          // Representative private connection attempts fail. The dedicated laptop
          // listener test additionally distinguishes filtering from a closed service.
          const privateProbes = observed.egressProbes.filter((probe) => probe.category === "private");
          expect(privateProbes.length).toBeGreaterThan(0);
          for (const probe of privateProbes) {
            expect(probe.expectation).toBe("blocked");
            expect(probe.outcome).toBe("blocked");
          }

          const udpProbes = observed.egressProbes.filter((probe) => ["multicast", "broadcast", "ipv6"].includes(probe.category));
          expect(udpProbes).toHaveLength(3);
          for (const probe of udpProbes) {
            expect(probe.protocol).toBe("udp");
            expect(probe.port).toBeGreaterThan(0);
            expect(probe.expectation).toBe("blocked");
            expect(probe.outcome, `${probe.label}: ${probe.detail}`).toBe("blocked");
            // Only the synchronous netfilter OUTPUT verdict (EPERM) is accepted as UDP block
            // evidence; EACCES would be a socket-option failure, not the firewall.
            if (probe.category !== "ipv6") expect(probe.detail).toMatch(/^EPERM$/);
          }

          // Independently confirmed from inside the guest: 443 and 80 both work.
          const transport = await guest.exec({
            command: [
              "node",
              "-e",
              "const n=require('node:net');const t=(p)=>new Promise(r=>{const s=n.connect({host:'1.1.1.1',port:p});s.setTimeout(2500);" +
                "s.once('connect',()=>{s.destroy();r(p+'=connected')});s.once('timeout',()=>{s.destroy();r(p+'=blocked')});" +
                "s.once('error',()=>{s.destroy();r(p+'=blocked')})});" +
                "Promise.all([t(443),t(80)]).then(v=>console.log(v.join(' ')))",
            ],
            cwd: "/work",
            timeoutMs: 30_000,
            maxOutputBytes: 4_096,
          });
          expect(transport.stdout).toContain("443=connected");
          expect(transport.stdout).toContain("80=connected");

          // The facts are OBSERVED, so an independent command inside the guest must agree.
          const ids = await guest.exec({
            command: ["sh", "-c", "id -u; id -g; id -G; grep -E '^(CapEff|NoNewPrivs)' /proc/1/status"],
            cwd: "/work",
            timeoutMs: 30_000,
            maxOutputBytes: 4_096,
          });
          expect(ids.exitCode).toBe(0);
          expect(ids.stdout).toContain("10001");
          expect(ids.stdout).toContain("CapEff:\t0000000000000000");
          expect(ids.stdout).toContain("NoNewPrivs:\t1");

          // A read-only root is proven by a failed write, not by a flag.
          const write = await guest.exec({
            command: ["sh", "-c", "echo x > /should-not-be-writable"],
            cwd: "/work",
            timeoutMs: 30_000,
            maxOutputBytes: 4_096,
          });
          expect(write.exitCode).not.toBe(0);
          expect(write.stderr).toMatch(/[Rr]ead-only file system/);

          expect(await guest.destroy()).toMatchObject({ status: "destroyed" });
          expect(await sandbox.inspectResource("guest", guestName)).toBe("absent");
        } finally {
          await sandbox.destroyResource("guest", guestName).catch(() => undefined);
          await sandbox.destroyResource("network", networkName).catch(() => undefined);
          await sandbox.destroyResource("image", image.digest).catch(() => undefined);
        }
      },
      180_000,
    );

    it(
      "delivers a fake key into memory and never leaks it to inspect, logs, argv, or env",
      async () => {
        const nonce = randomBytes(4).toString("hex");
        const runId = `t-${nonce}`;
        const sandbox = createAppleContainerSandbox({ runId });
        const contextDir = resolve(evalsRoot, "container");
        const image = await sandbox.buildImage({ runtimeProfileId: "default", contextDir });
        const networkName = `net-${nonce}`;
        await sandbox.createNetwork(networkName, {
          allowPublicDns: true,
          allowPublicTcpPorts: [443],
          denyRanges: ["10.0.0.0/8"],
        });
        const guestName = `gst-${nonce}`;

        try {
          const guest = await sandbox.createGuest({
            name: guestName,
            networkName,
            imageDigest: image.digest,
            limits: SAFE_DEFAULT_LIMITS,
            policy: {
              readOnlyRoot: true,
              writablePaths: ["/tmp", "/work", "/run/eval"],
              uid: 10001,
              gid: 10001,
              noNewPrivileges: true,
              dropCapabilities: true,
            },
            env: { HOME: "/work", TMPDIR: "/tmp" },
          });

          await guest.attest();

          const fakeSecretValue = `secret-fake-key-${nonce}-strictly-confidential`;
          await guest.deliverCredential({ variable: "GEMINI_API_KEY", value: fakeSecretValue });

          // 1. Assert secret is NOT in `container inspect` in any encoding
          const inspect = await runContainerCli(["inspect", guestName]);
          expect(inspect.stdout).not.toContain(fakeSecretValue);
          expect(inspect.stdout).not.toContain(Buffer.from(fakeSecretValue).toString("base64"));
          expect(inspect.stdout).not.toContain(encodeURIComponent(fakeSecretValue));

          // 2. Assert secret is NOT in `container logs`
          const logs = await runContainerCli(["logs", guestName]);
          expect(logs.stdout).not.toContain(fakeSecretValue);
          expect(logs.stderr).not.toContain(fakeSecretValue);

          // 3. Assert secret is NOT in /proc/1/cmdline or /proc/1/environ
          const proc1 = await guest.exec({
            command: ["sh", "-c", "cat /proc/1/cmdline; cat /proc/1/environ"],
            cwd: "/work",
            timeoutMs: 10_000,
            maxOutputBytes: 10_000,
          });
          expect(proc1.stdout).not.toContain(fakeSecretValue);

          // 4. Destroy and verify clean absence
          expect(await guest.destroy()).toMatchObject({ status: "destroyed" });
          expect(await sandbox.inspectResource("guest", guestName)).toBe("absent");
        } finally {
          await sandbox.destroyResource("guest", guestName).catch(() => undefined);
          await sandbox.destroyResource("network", networkName).catch(() => undefined);
          await sandbox.destroyResource("image", image.digest).catch(() => undefined);
        }
      },
      180_000,
    );

    it("recovers bounded test-owned exact Apple resources append-only and idempotently", async () => {
      const nonce = randomBytes(4).toString("hex");
      const runId = runIdFor();
      const networkName = resourceNameFor("net", { runId, resourceNonce: nonce }, 1, "baseline");
      const guestName = resourceNameFor("guest", { runId, resourceNonce: nonce }, 1, "baseline");
      const root = await mkdtemp(join(tmpdir(), "eval-real-recover-l2-"));
      const stateDir = join(root, ".state");
      const runDir = join(root, "run");
      await mkdir(runDir, { recursive: true });
      const markerPath = join(runDir, "original-evidence.txt");
      await writeFile(markerPath, "original recovery proof bytes\n");
      const markerHash = sha256Hex(await readFile(markerPath));
      const journal = await createRunJournal({ stateDir, runId, nonce });
      const sandbox = createAppleContainerSandbox({ runId, commandTimeoutMs: 20_000, readyTimeoutMs: 30_000, supervisorMaxMs: 60_000 });
      let imageDigest: string | null = null;
      const destroyOrder: string[] = [];
      const recoveringSandbox: Sandbox = {
        ...sandbox,
        async destroyResource(kind, name, signal) {
          destroyOrder.push(`${kind}:${name}`);
          return await sandbox.destroyResource(kind, name, signal);
        },
      };
      try {
        const image = await sandbox.buildImage({ runtimeProfileId: "default", contextDir, deadlineAtMs: Date.now() + 60_000 });
        imageDigest = image.digest;
        await journal.record({ event: "intent", action: "create", kind: "network", name: networkName, conditionId: "baseline", status: null });
        await sandbox.createNetwork(networkName, EVAL_NETWORK_POLICY, undefined, Date.now() + 30_000);
        await journal.record({ event: "observed", action: "create", kind: "network", name: networkName, conditionId: "baseline", status: "created" });
        await journal.record({ event: "intent", action: "create", kind: "guest", name: guestName, conditionId: "baseline", status: null });
        await sandbox.createGuest({ name: guestName, networkName, imageDigest: image.digest, limits: SAFE_DEFAULT_LIMITS, policy, env: { HOME: "/home/agent", TMPDIR: "/tmp" }, deadlineAtMs: Date.now() + 60_000 });
        await journal.record({ event: "observed", action: "create", kind: "guest", name: guestName, conditionId: "baseline", status: "created" });

        const first = await recoverRun({ evalsRoot, runId, runDir, stateDir, sandbox: recoveringSandbox, recoveryId: "20260101T000100Z-11112222", attemptedAt: new Date(0).toISOString(), deadlineAtMs: Date.now() + 60_000 });
        expect(first.ok).toBe(true);
        expect(destroyOrder).toEqual([`guest:${guestName}`, `network:${networkName}`]);
        expect(await sandbox.inspectResource("guest", guestName)).toBe("absent");
        expect(await sandbox.inspectResource("network", networkName)).toBe("absent");
        expect(await sandbox.inspectResource("image", image.digest)).toBe("present");
        expect(sha256Hex(await readFile(markerPath))).toBe(markerHash);
        const firstReceiptHash = sha256Hex(await readFile(first.receiptPath));

        destroyOrder.length = 0;
        const second = await recoverRun({ evalsRoot, runId, runDir, stateDir, sandbox: recoveringSandbox, recoveryId: "20260101T000200Z-22223333", attemptedAt: new Date(1_000).toISOString(), deadlineAtMs: Date.now() + 60_000 });
        expect(second.ok).toBe(true);
        expect(second.resources.filter((resource) => resource.kind !== "image").every((resource) => resource.action === "already-absent")).toBe(true);
        expect(destroyOrder).toEqual([]);
        expect(sha256Hex(await readFile(first.receiptPath))).toBe(firstReceiptHash);
        expect(sha256Hex(await readFile(markerPath))).toBe(markerHash);
        console.log(JSON.stringify({ phase: "real-exact-id-recovery", runId, guestName, networkName, imageDigest: image.digest, firstRecovery: first.recoveryId, secondRecovery: second.recoveryId }));
      } finally {
        await sandbox.destroyResource("guest", guestName).catch(() => undefined);
        await sandbox.destroyResource("network", networkName).catch(() => undefined);
        if (imageDigest !== null) expect(await sandbox.inspectResource("image", imageDigest)).toBe("present");
        await rm(root, { recursive: true, force: true });
      }
    }, 180_000);
  });
}
