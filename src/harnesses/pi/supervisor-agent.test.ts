/**
 * @notice Verifies the generated guest agent protocol, runtime lock, abort handling, redaction, and lifecycle boundaries.
 */

import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { buildAllowlistedEnv, startSocketServer } from "../../test-guards.ts";
import { parseInit } from "./guest-agent.ts";

const supervisor = join(process.cwd(), "evals/container/run-measured.mjs");
const children = new Set<ChildProcessWithoutNullStreams>();
const cleanups: Array<() => Promise<void>> = [];
const target = { provider: "google", model: "gemini-3.8-flash", thinking: "low" };
const limits = { maxProviderRequests: 8, maxToolSteps: 8, maxOutputTokens: 4096 };

function sha256(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fixture(
  secret: string | null = "synthetic-canary-not-a-provider-key",
  credentialDelayMs = 0,
  options: { entry?: string; hostGuardPreload?: boolean } = {},
) {
  const dir = join(tmpdir(), `pi-guest-agent-${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  const socketPath = join(dir, "control.sock");
  const server = createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => { input += chunk.toString("utf8"); });
    socket.on("end", () => socket.end());
    socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString("utf8").trim());
      const response = request.type === "get-credential"
        ? (secret === null ? { ok: false } : { ok: true, variable: "GEMINI_API_KEY", value: secret })
        : request.type === "register-task-process"
          ? { ok: true }
          : request.type === "quiesce-task-processes"
            ? (() => {
                const pidPath = join(dir, "task.pid");
                if (existsSync(pidPath)) {
                  const pid = Number(readFileSync(pidPath, "utf8"));
                  if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(pid, "SIGKILL"); } catch {} }
                }
                return { ok: true, streamingStopped: true, descendantsStopped: true, remaining: 0 };
              })()
            : { ok: false };
      setTimeout(() => socket.end(`${JSON.stringify(response)}\n`), request.type === "get-credential" ? credentialDelayMs : 0);
    });
  });
  await startSocketServer(server, socketPath);
  const env = buildAllowlistedEnv(dir, { EVAL_CONTROL_SOCKET: socketPath });
  if (options.hostGuardPreload === false) delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, options.entry ? [options.entry] : [supervisor, "agent"], {
    cwd: dir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  const frames: Record<string, any>[] = [];
  let stdout = "";
  let stderr = "";
  let buffer = "";
  const waiters: Array<{ type: string; resolve: (frame: Record<string, any>) => void; reject: (error: Error) => void }> = [];
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line) as Record<string, any>;
      frames.push(frame);
      for (const waiter of [...waiters]) {
        if (waiter.type === frame.type) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const exit = new Promise<number | null>((resolve) => child.once("close", (code) => {
    children.delete(child);
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`agent exited ${code} before ${waiter.type}: ${stdout} ${stderr}`));
    resolve(code);
  }));
  const waitFor = (type: string): Promise<Record<string, any>> => {
    const prior = frames.find((frame) => frame.type === type);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => waiters.push({ type, resolve, reject }));
  };
  const send = (frame: unknown) => child.stdin.write(`${JSON.stringify(frame)}\n`);
  cleanups.push(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { child, dir, frames, send, waitFor, exit, secret, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

function initFrame(steps: readonly unknown[], options: { captureReasoning?: boolean } = {}) {
  return {
    type: "init",
    protocolVersion: 1,
    mode: "scripted",
    arm: "baseline",
    target,
    skillPath: null,
    allowedTools: ["read", "write", "edit", "bash"],
    skillToolBundle: null,
    skillToolBundleSha256: "f9cc8e2b85ebe6aa64c21b5be039960cdc74a5743ca280d0f84c440f745c993b",
    processLifetimeMs: 180_000,
    armWallClockMs: 10_000,
    limits,
    credentialVariable: "GEMINI_API_KEY",
    ...(options.captureReasoning !== undefined ? { captureReasoning: options.captureReasoning } : {}),
    scriptedSteps: steps,
  };
}

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe("locked guest SDK artifact", () => {
  it("is reproducibly compiled from the explicit TypeScript 5.9.3 source closure and image-locked", () => {
    const artifactLockPath = join(process.cwd(), "evals/container/guest-runtime/artifact-lock.json");
    const beforeLock = readFileSync(artifactLockPath);
    const beforeManifest = JSON.parse(beforeLock.toString("utf8"));
    const beforeArtifacts = Object.fromEntries(Object.keys(beforeManifest.artifacts).map((path) => [path, readFileSync(join(process.cwd(), "evals/container", path))]));
    const generatedRoot = mkdtempSync(join(tmpdir(), "pi-guest-build-"));
    try {
      execFileSync(process.execPath, [join(process.cwd(), "evals/scripts/build-guest-runtime.mjs"), "--output-dir", generatedRoot], { stdio: "pipe" });
      expect(readFileSync(join(generatedRoot, "artifact-lock.json"))).toEqual(beforeLock);
      for (const [path, bytes] of Object.entries(beforeArtifacts)) {
        expect(readFileSync(join(generatedRoot, path.replace(/^guest-runtime\//, "")))).toEqual(bytes);
      }
      expect(readFileSync(artifactLockPath)).toEqual(beforeLock);
      for (const [path, bytes] of Object.entries(beforeArtifacts)) expect(readFileSync(join(process.cwd(), "evals/container", path))).toEqual(bytes);
    } finally {
      rmSync(generatedRoot, { recursive: true, force: true });
    }
    const artifactLock = JSON.parse(readFileSync(artifactLockPath, "utf8"));
    const imageLock = JSON.parse(readFileSync(join(process.cwd(), "evals/container/image-lock.json"), "utf8"));
    expect(ts.version).toBe("5.9.3");
    expect(artifactLock.compiler).toEqual({ package: "typescript", version: "5.9.3" });
    for (const [path, digest] of Object.entries(artifactLock.sources)) {
      expect(sha256(readFileSync(join(process.cwd(), path)))).toBe(digest);
    }
    for (const [path, digest] of Object.entries(artifactLock.artifacts)) {
      expect(sha256(readFileSync(join(process.cwd(), "evals/container", path)))).toBe(digest);
      expect(imageLock.profiles.default.buildContextFiles[path]).toBe(digest);
    }
    expect(imageLock.profiles.default.buildContextFiles["guest-runtime/artifact-lock.json"]).toBe(sha256(readFileSync(artifactLockPath)));
  });

  it("ships every locked guest artifact in the build context and pins the static context files", () => {
    const artifactLock = JSON.parse(readFileSync(join(process.cwd(), "evals/container/guest-runtime/artifact-lock.json"), "utf8"));
    const imageLock = JSON.parse(readFileSync(join(process.cwd(), "evals/container/image-lock.json"), "utf8"));
    const dockerignore = readFileSync(join(process.cwd(), "evals/container/.dockerignore"), "utf8").split("\n").map((line) => line.trim());
    const containerfile = readFileSync(join(process.cwd(), "evals/container/Containerfile"), "utf8");

    // A deny-by-default .dockerignore silently drops any locked artifact that is not
    // re-included, producing an image that is missing modules the guest agent imports.
    // Explicit per-file COPY instructions replace a blanket directory copy, so the image can
    // no longer inherit an artifact implicitly: each locked path must be named by a COPY source.
    const copiedSources = new Set(
      containerfile
        .split("\n")
        .filter((line) => line.startsWith("COPY "))
        .flatMap((line) => line.slice("COPY ".length).trim().split(/\s+/).slice(0, -1)),
    );
    for (const path of [...Object.keys(artifactLock.artifacts), "guest-runtime/artifact-lock.json"]) {
      expect(dockerignore, `${path} must be re-included in the build context`).toContain(`!${path}`);
      expect(copiedSources, `${path} must be copied into the image`).toContain(path);
    }

    // The build must fail before the image is cached if a copied artifact drifts from the lock
    // or the guest agent entry point is missing.
    expect(containerfile).toMatch(/^RUN node --input-type=module -e .*artifact-lock\.json/m);
    expect(containerfile).toContain("Guest artifact mismatch: ");
    expect(containerfile).toContain("Missing guest agent entry point");

    // The static context files are digest-pinned by hand, so bind them to their real bytes.
    for (const name of ["Containerfile", ".dockerignore", "configure-egress.sh", "run-measured.mjs"]) {
      expect(imageLock.profiles.default.buildContextFiles[name], `${name} digest must be pinned`)
        .toBe(sha256(readFileSync(join(process.cwd(), "evals/container", name))));
    }
  });

  it("refuses caller-owned output contents without deleting the destination or sentinel", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "pi-guest-owned-output-"));
    const sentinel = join(outputRoot, "caller-sentinel.txt");
    writeFileSync(sentinel, "preserve me");
    try {
      expect(() => execFileSync(process.execPath, [join(process.cwd(), "evals/scripts/build-guest-runtime.mjs"), "--output-dir", outputRoot], { stdio: "pipe" })).toThrow();
      expect(existsSync(outputRoot)).toBe(true);
      expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("imports the compiled ESM SDK entry with real pinned packages", async () => {
    const guestAgentModule = "../../../container/guest-runtime/src/harnesses/pi/guest-agent.mjs";
    const module = await import(guestAgentModule);
    expect(module.runGuestAgent).toBeTypeOf("function");
  });
});

describe("production supervisor process sweep", () => {
  it("uses PID+start-time identities, ignores zombies, catches forks, and fails on permission/persistent processes", async () => {
    const supervisorModule = "../../../container/run-measured.mjs";
    const { createTaskProcessQuiescer } = await import(supervisorModule);
    let tick = 0;
    const killed: Array<[number, string]> = [];
    const scans = [
      [{ pid: 10, startTime: "old", state: "S" }, { pid: 20, startTime: "agent", state: "S" }],
      [{ pid: 10, startTime: "reused", state: "S" }, { pid: 20, startTime: "agent", state: "S" }, { pid: 30, startTime: "z", state: "Z" }],
      [{ pid: 20, startTime: "agent", state: "S" }, { pid: 40, startTime: "fork", state: "T" }],
      [{ pid: 20, startTime: "agent", state: "S" }],
      [{ pid: 20, startTime: "agent", state: "S" }],
    ];
    const quiescer = createTaskProcessQuiescer({ supervisorPid: 1, scan: () => scans[Math.min(tick++, scans.length - 1)], kill: (pid: number, signal: string) => killed.push([pid, signal]), sleep: async () => undefined, now: () => tick });
    quiescer.register(20);
    await expect(quiescer.quiesce(20, 100)).resolves.toMatchObject({ ok: true, remaining: 0 });
    expect(killed).toEqual([[10, "SIGTERM"], [40, "SIGTERM"]]);

    let deniedScan = 0;
    const denied = createTaskProcessQuiescer({ supervisorPid: 1, scan: () => deniedScan++ === 0 ? [{ pid: 20, startTime: "agent", state: "S" }] : [{ pid: 20, startTime: "agent", state: "S" }, { pid: 50, startTime: "live", state: "D" }], kill: () => { const error: NodeJS.ErrnoException = new Error("denied"); error.code = "EPERM"; throw error; } });
    denied.register(20);
    await expect(denied.quiesce(20)).rejects.toMatchObject({ code: "EPERM" });

    let now = 0;
    let persistentScan = 0;
    const persistent = createTaskProcessQuiescer({ supervisorPid: 1, scan: () => persistentScan++ === 0 ? [{ pid: 20, startTime: "agent", state: "S" }] : [{ pid: 20, startTime: "agent", state: "S" }, { pid: 60, startTime: "live", state: "S" }], kill: () => undefined, sleep: async () => { now += 10; }, now: () => now });
    persistent.register(20);
    await expect(persistent.quiesce(20, 25)).resolves.toMatchObject({ ok: false, descendantsStopped: false, remaining: 1 });
  });
});

describe("framed guest SDK process", () => {
  it("attests and prompts the same actual SDK session once, streaming native records and a real tool write", async () => {
    const fx = await fixture();
    fx.send(initFrame([
      { type: "toolCall", toolCalls: [{ id: "write-one", name: "write", arguments: { path: "nested/result.txt", content: "written by actual SDK tool" } }] },
      { type: "text", text: "done" },
    ]));
    const ready = await fx.waitFor("ready");
    expect(ready.attestation.loadedSkills).toEqual([]);
    expect(ready.attestation.activeTools).toEqual(["read", "write", "edit", "bash", "mcp"]);
    expect(ready.attestation.mcpClientId).toBe("shared-mcp-client-v1");
    expect(ready.attestation.seededMcpServers).toEqual([]);
    expect(ready.process.platform).toBe(process.platform);
    expect(ready.process.uid).toBe(process.getuid?.() ?? null);
    fx.send({ type: "prompt", prompt: "create the requested output" });
    fx.child.stdin.end();
    const result = await fx.waitFor("result");
    expect(await fx.exit).toBe(0);
    expect(result.outcome).toBe("completed");
    expect(result.sessionId).toBe(ready.sessionId);
    const records = fx.frames.filter((frame) => frame.type === "record");
    expect(records[0]!.record).toEqual(ready.header);
    expect(records.filter((frame) => frame.record.type === "message" && frame.record.message?.role === "user")).toHaveLength(1);
    expect(JSON.stringify(records)).toContain("write-one");
    expect(await readFile(join(fx.dir, "nested/result.txt"), "utf8")).toBe("written by actual SDK tool");
  });

  it("loads exactly one explicit treatment skill before ready", async () => {
    const fx = await fixture();
    const skillDir = join(fx.dir, "skill");
    await mkdir(skillDir);
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: framed-test-skill\ndescription: explicit treatment skill\n---\nUse the requested output.\n");
    fx.send({
      ...initFrame([{ type: "text", text: "done" }]),
      arm: "treatment",
      skillPath: skillDir,
      // A treatment arm always carries a bundle object; a skill declaring no MCP
      // resolves to the empty bundle: the shared client exists but connects to no server.
      skillToolBundle: { schemaVersion: 1, source: null, sourceSha256: null, servers: [] },
    });
    const ready = await fx.waitFor("ready");
    expect(ready.attestation.loadedSkills).toHaveLength(1);
    expect(ready.attestation.activeTools).toEqual(["read", "write", "edit", "bash", "mcp"]);
    expect(ready.attestation.mcpClientId).toBe("shared-mcp-client-v1");
    expect(ready.attestation.seededMcpServers).toEqual([]);
    expect(ready.attestation.loadedSkills[0].path).toContain("SKILL.md");
    fx.send({ type: "prompt", prompt: "finish" });
    fx.child.stdin.end();
    expect((await fx.waitFor("result")).sessionId).toBe(ready.sessionId);
    expect(await fx.exit).toBe(0);
  });

  it("supplies the selected key to guest tools but redacts their credential echo", async () => {
    const fx = await fixture();
    fx.send(initFrame([
      { type: "toolCall", toolCalls: [{ id: "env-read", name: "bash", arguments: { command: 'printf "%s" "$GEMINI_API_KEY"' } }] },
      { type: "text", text: "done" },
    ]));
    await fx.waitFor("ready");
    fx.send({ type: "prompt", prompt: "inspect the supplied test environment" });
    fx.child.stdin.end();
    await fx.waitFor("result");
    expect(await fx.exit).toBe(0);
    const results = fx.frames.filter((frame) => frame.type === "record" && frame.record?.message?.role === "toolResult");
    expect(JSON.stringify(results)).toContain("[REDACTED:GEMINI_API_KEY]");
    expect(fx.stdout).not.toContain(fx.secret);
    expect(fx.stderr).not.toContain(fx.secret);
  });

  it("redacts a synthetic credential canary while preserving raw thinking/signatures in every output frame when captureReasoning is enabled", async () => {
    const fx = await fixture();
    fx.send(initFrame([{ type: "thinking", thinking: `private ${fx.secret}`, signature: `sig-${fx.secret}`, text: `public ${fx.secret}` }], { captureReasoning: true }));
    await fx.waitFor("ready");
    fx.send({ type: "prompt", prompt: "respond" });
    fx.child.stdin.end();
    const result = await fx.waitFor("result");
    expect(await fx.exit).toBe(0);
    // The secret is redacted everywhere it appears, including inside reasoning.
    expect(fx.stdout).not.toContain(fx.secret);
    expect(fx.stdout).toContain("[REDACTED:GEMINI_API_KEY]");
    // When captureReasoning is true, reasoning and its signature survive redaction verbatim,
    // with only the secret portion replaced.
    expect(fx.stdout).toContain("private [REDACTED:GEMINI_API_KEY]");
    expect(fx.stdout).toContain("sig-[REDACTED:GEMINI_API_KEY]");
    expect(result.redactions.count).toBeGreaterThan(0);
    expect(fx.stderr).toBe("");
  });

  it("strips thinking blocks and signatures by default from guest output frames", async () => {
    const fx = await fixture();
    fx.send(initFrame([{ type: "thinking", thinking: "internal reasoning", signature: "sig-xyz", text: "public answer" }]));
    await fx.waitFor("ready");
    fx.send({ type: "prompt", prompt: "respond" });
    fx.child.stdin.end();
    const result = await fx.waitFor("result");
    expect(await fx.exit).toBe(0);
    expect(fx.stdout).toContain("public answer");
    expect(fx.stdout).not.toContain("internal reasoning");
    expect(fx.stdout).not.toContain("sig-xyz");
    expect(result.outcome).toBe("completed");
  });

  it("aborts an actual SDK bash tool and reports success only after streaming stopped", async () => {
    const fx = await fixture();
    fx.send(initFrame([
      { type: "toolCall", toolCalls: [{ id: "slow-bash", name: "bash", arguments: { command: "sleep 30; echo unsafe > late.txt" } }] },
      { type: "text", text: "should not continue" },
    ]));
    await fx.waitFor("ready");
    fx.send({ type: "prompt", prompt: "run the slow command" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    fx.send({ type: "abort", reason: "test cancellation", cause: "external" });
    fx.child.stdin.end();
    const result = await fx.waitFor("result");
    expect(await fx.exit, `${fx.stdout}\n${fx.stderr}`).toBe(0);
    expect(result.outcome).toBe("infrastructure-failure");
    expect(result.terminal.classification).toBe("interrupted");
    expect(result.terminal.semanticAbortCause).toBe("external");
    expect(result.terminal.streamingStopped).toBe(true);
    await expect(readFile(join(fx.dir, "late.txt"), "utf8")).rejects.toThrow();
  });

  it("stops an actual detached SDK bash descendant before reporting quiescent capture", async () => {
    const fx = await fixture();
    const childScript = "setTimeout(() => require('fs').writeFileSync('late-detached.txt', 'unsafe'), 5000)";
    const launcher = `const fs=require('fs'),{spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{detached:true,stdio:'ignore'});fs.writeFileSync('task.pid',String(c.pid));c.unref()`;
    fx.send(initFrame([
      { type: "toolCall", toolCalls: [{ id: "detach", name: "bash", arguments: { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(launcher)}` } }] },
      { type: "text", text: "done" },
    ]));
    await fx.waitFor("ready");
    fx.send({ type: "prompt", prompt: "launch the synthetic detached writer" });
    fx.child.stdin.end();
    const result = await fx.waitFor("result");
    expect(await fx.exit).toBe(0);
    expect(result.terminal.streamingStopped).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const detachedPid = Number(readFileSync(join(fx.dir, "task.pid"), "utf8"));
    expect(() => process.kill(detachedPid, 0)).toThrow();
    expect(existsSync(join(fx.dir, "late-detached.txt"))).toBe(false);
  });

  it("classifies native length as task-limit and never hides execution failure behind aborted state", async () => {
    const lengthFx = await fixture();
    lengthFx.send(initFrame([{ type: "stop", stopReason: "length", text: "partial" }]));
    await lengthFx.waitFor("ready");
    lengthFx.send({ type: "prompt", prompt: "run to native length" });
    lengthFx.child.stdin.end();
    const lengthResult = await lengthFx.waitFor("result");
    expect(await lengthFx.exit).toBe(0);
    expect(lengthResult.outcome).toBe("task-limit");
    expect(lengthResult.terminal.classification).toBe("task-limit");
    // A FIRST-turn `length` stop under a finite (4096) output budget: the clamp still
    // equals the full budget and has not shrunk across turns, so the provider truncated on
    // its own per-response limit within the allowance. That is provider-native truncation,
    // NOT cumulative-output exhaustion. Only a SHRUNKEN remainder after prior turns
    // reclassifies a `length` stop as a harness cumulative cap (see the multi-turn
    // near-boundary cases in adapter.test.ts / sdk-session.test.ts).
    expect(lengthResult.terminal.stopCause).toBe("provider-response-length");
    expect(lengthResult.terminal.stopReason).toBe("length");

    const errorFx = await fixture();
    errorFx.send(initFrame([{ type: "error", errorMessage: "arbitrary execution failure", stopReason: "aborted" }]));
    await errorFx.waitFor("ready");
    errorFx.send({ type: "prompt", prompt: "fail" });
    errorFx.child.stdin.end();
    const errorResult = await errorFx.waitFor("result");
    expect(await errorFx.exit).toBe(0);
    expect(errorResult.outcome).toBe("infrastructure-failure");
    expect(errorResult.terminal.classification).toBe("execution-failure");
    expect(errorResult.terminal.stopCause).toBe("infrastructure-error");
  });

  it("reports provider-native length as provider-response-length under an UNLIMITED output budget, not cumulative exhaustion", async () => {
    const fx = await fixture();
    // Unlimited across all cumulative budgets: a native `length` stop can only be the
    // provider's own per-response truncation, never a harness cumulative-output cap.
    fx.send({
      ...initFrame([{ type: "stop", stopReason: "length", text: "partial" }]),
      limits: { maxProviderRequests: null, maxToolSteps: null, maxOutputTokens: null },
    });
    await fx.waitFor("ready");
    fx.send({ type: "prompt", prompt: "run to native length while unlimited" });
    fx.child.stdin.end();
    const result = await fx.waitFor("result");
    expect(await fx.exit, fx.stderr).toBe(0);
    expect(result.outcome).toBe("task-limit");
    expect(result.terminal.stopCause).toBe("provider-response-length");
    expect(result.usage.taskLimitReason).toBeNull();
  });

  it.each([
    ["This operation was aborted", "task-limit", "aborted"],
    ["quota exceeded", "infrastructure-failure", "error"],
    ["This operation was aborted: upstream failure", "infrastructure-failure", "error"],
  ])("classifies provider error after a harness deadline: %s", async (errorMessage, outcome, stopReason) => {
    const wrapperDir = mkdtempSync(join(tmpdir(), "pi-provider-abort-"));
    const wrapper = join(wrapperDir, "abort.mjs");
    const guestModule = pathToFileURL(join(process.cwd(), "evals/container/guest-runtime/src/harnesses/pi/guest-agent.mjs")).href;
    writeFileSync(wrapper, `
import { AgentSession } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href)};
import { runGuestAgent } from ${JSON.stringify(guestModule)};
const descriptor = Object.getOwnPropertyDescriptor(AgentSession.prototype, "messages");
if (typeof descriptor?.get !== "function") throw new Error("SDK messages accessor changed");
Object.defineProperty(AgentSession.prototype, "messages", { ...descriptor, get() {
  const messages = descriptor.get.call(this);
  const last = messages.filter(message => message.role === "assistant").at(-1);
  if (last?.stopReason === "aborted") {
    last.stopReason = "error";
    last.errorMessage = ${JSON.stringify(errorMessage)};
  }
  return messages;
} });
runGuestAgent({ controlSocket: process.env.EVAL_CONTROL_SOCKET }).catch(error => {
  process.stderr.write(String(error)); process.exitCode = 1;
});
`);
    try {
      const fx = await fixture("synthetic-abort-key", 0, { entry: wrapper });
      fx.send({ ...initFrame([
        { type: "toolCall", toolCalls: [{ id: "slow", name: "bash", arguments: { command: "sleep 10" } }] },
        { type: "text", text: "never reached" },
      ]), armWallClockMs: 1_000 });
      await fx.waitFor("ready");
      fx.send({ type: "prompt", prompt: "exhaust task budget" });
      fx.child.stdin.end();
      const result = await fx.waitFor("result");
      expect(await fx.exit, fx.stderr).toBe(0);
      expect(result.terminal.semanticAbortCause).toBe("arm-budget");
      // A missing assistant message must not let the deadline-only path pass vacuously.
      expect(result.terminal.stopReason).toBe(stopReason);
      expect(result.outcome).toBe(outcome);
      // A harness wall-clock abort resolves to the wall-clock stop cause when it is a
      // task-limit; a decorated provider failure remains an infrastructure error.
      expect(result.terminal.stopCause).toBe(outcome === "task-limit" ? "wall-clock" : "infrastructure-error");
    } finally { rmSync(wrapperDir, { recursive: true, force: true }); }
  });

  it("does not normalize an unsolicited provider abort error", async () => {
    const fx = await fixture();
    fx.send(initFrame([{ type: "error", errorMessage: "This operation was aborted", stopReason: "error" }]));
    await fx.waitFor("ready");
    fx.send({ type: "prompt", prompt: "fail without a deadline" });
    fx.child.stdin.end();
    const result = await fx.waitFor("result");
    expect(await fx.exit).toBe(0);
    expect(result.terminal.semanticAbortCause).toBeNull();
    expect(result.terminal.stopReason).toBe("error");
    expect(result.outcome).toBe("infrastructure-failure");
  });

  it("bounds queued frames while credentials are delayed and skips frames after a fatal parse error", async () => {
    const floodFx = await fixture("synthetic-delayed-canary", 250);
    floodFx.send(initFrame([{ type: "text", text: "must not dispatch" }]));
    for (let index = 0; index < 40; index += 1) floodFx.send({ type: "prompt", prompt: `queued-${index}` });
    floodFx.child.stdin.end();
    const floodError = await floodFx.waitFor("error");
    expect(floodError.error).toContain("pending request frames exceeded");
    expect(await floodFx.exit).toBe(1);
    expect(floodFx.frames.some((frame) => frame.type === "ready" || frame.type === "result")).toBe(false);
    expect(floodFx.frames.length).toBeLessThan(5);

    const orderedFx = await fixture("synthetic-delayed-canary", 50);
    orderedFx.child.stdin.write(`${JSON.stringify(initFrame([{ type: "text", text: "must not run" }]))}\n`);
    orderedFx.child.stdin.write("{malformed\n");
    orderedFx.send({ type: "prompt", prompt: "must be skipped after fatal" });
    orderedFx.child.stdin.end();
    expect((await orderedFx.waitFor("error")).error).toContain("malformed JSON");
    expect(await orderedFx.exit).toBe(1);
    const orderedFatalIndex = orderedFx.frames.findIndex((frame) => frame.type === "error");
    expect(orderedFx.frames.some((frame, index) => index > orderedFatalIndex && frame.type === "ready")).toBe(false);
    expect(orderedFx.frames.some((frame) => frame.type === "result")).toBe(false);
    expect(orderedFx.frames.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(orderedFx.frames)).not.toContain("must be skipped after fatal");
  });

  describe("parseInit validation", () => {
    it("accepts a finite prompt allowance above the former fixed maximum (no arm cap)", () => {
      expect(parseInit({ ...initFrame([{ type: "text", text: "done" }]), armWallClockMs: 600_001 }).armWallClockMs).toBe(600_001);
    });

    it("accepts null as an unlimited prompt allowance", () => {
      expect(parseInit({ ...initFrame([{ type: "text", text: "done" }]), armWallClockMs: null }).armWallClockMs).toBeNull();
    });

    it.each([0, -1, 1.5, Number.NaN])("rejects an invalid finite prompt allowance %s", (armWallClockMs) => {
      expect(() => parseInit({ ...initFrame([{ type: "text", text: "done" }]), armWallClockMs })).toThrow("init.armWallClockMs");
    });

    it.each(["maxProviderRequests", "maxToolSteps", "maxOutputTokens"] as const)(
      "accepts a null (unlimited) cumulative task budget %s at the transport boundary",
      (key) => {
        const parsed = parseInit({
          ...initFrame([{ type: "text", text: "done" }]),
          limits: { ...limits, [key]: null },
        });
        expect(parsed.limits[key]).toBeNull();
      },
    );

    it.each([0, -1, 1.5])("rejects an invalid finite cumulative task budget %s", (bad) => {
      expect(() =>
        parseInit({ ...initFrame([{ type: "text", text: "done" }]), limits: { ...limits, maxOutputTokens: bad } }),
      ).toThrow("init.limits.maxOutputTokens");
    });
    it("refuses invalid allowedTools tool name syntax", () => {
      expect(() =>
        parseInit({
          type: "init",
          protocolVersion: 1,
          mode: "scripted",
          arm: "baseline",
          target,
          skillPath: null,
          allowedTools: ["read", "INVALID"],
          skillToolBundle: null,
          skillToolBundleSha256: "00".repeat(32),
          processLifetimeMs: 180_000,
          armWallClockMs: 10_000,
          limits,
          credentialVariable: "GEMINI_API_KEY",
          scriptedSteps: [{ type: "text", text: "ok" }],
        }),
      ).toThrow(/init\.allowedTools must be an array of valid tool names/);
    });

    it("refuses a baseline frame carrying a non-null skillToolBundle", () => {
      expect(() =>
        parseInit({
          type: "init",
          protocolVersion: 1,
          mode: "scripted",
          arm: "baseline",
          target,
          skillPath: null,
          allowedTools: ["read"],
          skillToolBundle: { schemaVersion: 1, source: null, sourceSha256: null, servers: [] },
          skillToolBundleSha256: "00".repeat(32),
          processLifetimeMs: 180_000,
          armWallClockMs: 10_000,
          limits,
          credentialVariable: "GEMINI_API_KEY",
          scriptedSteps: [{ type: "text", text: "ok" }],
        }),
      ).toThrow(/baseline init must carry skillToolBundle: null/);
    });

    it("refuses a treatment frame with malformed skillToolBundle", () => {
      expect(() =>
        parseInit({
          type: "init",
          protocolVersion: 1,
          mode: "scripted",
          arm: "treatment",
          target,
          skillPath: "/path/to/skill",
          allowedTools: ["read"],
          skillToolBundle: { schemaVersion: 1, source: null, sourceSha256: null },
          skillToolBundleSha256: "00".repeat(32),
          processLifetimeMs: 180_000,
          armWallClockMs: 10_000,
          limits,
          credentialVariable: "GEMINI_API_KEY",
          scriptedSteps: [{ type: "text", text: "ok" }],
        }),
      ).toThrow(/init\.skillToolBundle/);
    });

    it("refuses a frame with an invalid skillToolBundleSha256 digest", () => {
      expect(() =>
        parseInit({
          type: "init",
          protocolVersion: 1,
          mode: "scripted",
          arm: "baseline",
          target,
          skillPath: null,
          allowedTools: ["read"],
          skillToolBundle: null,
          skillToolBundleSha256: "not-a-64-char-hex-digest",
          processLifetimeMs: 180_000,
          armWallClockMs: 10_000,
          limits,
          credentialVariable: "GEMINI_API_KEY",
          scriptedSteps: [{ type: "text", text: "ok" }],
        }),
      ).toThrow(/init\.skillToolBundleSha256 must be a 64-char lowercase hex digest/);
    });

    it("refuses a treatment frame with unsorted servers", () => {
      expect(() =>
        parseInit({
          type: "init",
          protocolVersion: 1,
          mode: "scripted",
          arm: "treatment",
          target,
          skillPath: "/path/to/skill",
          allowedTools: ["read"],
          skillToolBundle: {
            schemaVersion: 1,
            source: "agents/openai.yaml",
            sourceSha256: "00".repeat(32),
            servers: [
              { name: "serverB", transport: "streamable_http", url: "https://b.example.com", description: null },
              { name: "serverA", transport: "streamable_http", url: "https://a.example.com", description: null },
            ],
          },
          skillToolBundleSha256: "00".repeat(32),
          processLifetimeMs: 180_000,
          armWallClockMs: 10_000,
          limits,
          credentialVariable: "GEMINI_API_KEY",
          scriptedSteps: [{ type: "text", text: "ok" }],
        }),
      ).toThrow(/init\.skillToolBundle\.servers must be sorted and unique by name/);
    });
  });

  it("fails closed on duplicate init, prompt-before-ready, unknown fields, and measured scripted transport", async () => {
    const badCases = [
      { frames: [{ type: "prompt", prompt: "early" }], stopped: true },
      { frames: [{ ...initFrame([]), unexpected: true }], stopped: true },
      { frames: [{ ...initFrame([]), mode: "measured", scriptedSteps: [] }], stopped: true },
      { frames: [initFrame([]), initFrame([])], stopped: true },
      { frames: [initFrame([{ type: "text", text: "one" }]), { type: "prompt", prompt: "one" }, { type: "prompt", prompt: "two" }], stopped: false },
    ];
    for (const bad of badCases) {
      const fx = await fixture();
      for (const frame of bad.frames) fx.send(frame);
      fx.child.stdin.end();
      const error = await fx.waitFor("error");
      expect(error.streamingStopped).toBe(bad.stopped);
      expect(await fx.exit).toBe(1);
      if (!bad.stopped) expect(error).not.toMatchObject({ streamingStopped: true });
    }
  });

  it("self-installs the scripted completion guard in the compiled guest without host preload", async () => {
    const wrapperDir = mkdtempSync(join(tmpdir(), "pi-guest-self-guard-"));
    const wrapper = join(wrapperDir, "self-guard-proof.mjs");
    const guestModule = pathToFileURL(join(process.cwd(), "evals/container/guest-runtime/src/harnesses/pi/guest-agent.mjs")).href;
    writeFileSync(wrapper, `
import net from "node:net";
import https from "node:https";
import { runGuestAgent } from ${JSON.stringify(guestModule)};
const rawWrite = process.stdout.write.bind(process.stdout);
const rawConnect = net.Socket.prototype.connect;
let checked = false;
net.Socket.prototype.connect = function (...args) {
  const destination = typeof args[0] === "string" ? args[0] : args[0]?.path;
  if ((typeof destination === "string" && destination.endsWith("control.sock")) || JSON.stringify(args).includes("control.sock")) return rawConnect.apply(this, args);
  const error = new Error("independent test network deny");
  process.nextTick(() => this.destroy(error));
  return this;
};
process.stdout.write = function (chunk, ...args) {
  const result = rawWrite(chunk, ...args);
  if (!checked && String(chunk).includes('"type":"ready"')) {
    checked = true;
    queueMicrotask(() => {
      try {
        const request = https.get("https://generativelanguage.googleapis.com/self-install-proof");
        request.once("error", () => rawWrite(JSON.stringify({ type: "guard-proof", installed: false, independentDeny: true }) + "\\n"));
      } catch (error) {
        rawWrite(JSON.stringify({ type: "guard-proof", installed: error?.name === "RealCompletionTransportBlockedError", independentDeny: true, message: String(error?.message) }) + "\\n");
      }
    });
  }
  return result;
};
runGuestAgent({ controlSocket: process.env.EVAL_CONTROL_SOCKET }).catch((error) => { rawWrite(JSON.stringify({ type: "wrapper-error", error: String(error) }) + "\\n"); process.exitCode = 1; });
`);
    try {
      const fx = await fixture("synthetic-self-guard-key", 0, { entry: wrapper, hostGuardPreload: false });
      fx.send(initFrame([{ type: "text", text: "offline scripted completion" }]));
      await fx.waitFor("ready");
      const proof = await fx.waitFor("guard-proof");
      expect(proof).toMatchObject({ installed: true, independentDeny: true });
      expect(proof.message).toContain("blocked before networking");
      fx.send({ type: "prompt", prompt: "finish offline" });
      fx.child.stdin.end();
      expect((await fx.waitFor("result")).outcome).toBe("completed");
      expect(await fx.exit).toBe(0);
    } finally {
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  });

  it("blocks an actual framed native SDK dispatch before provider networking", async () => {
    const fx = await fixture("synthetic-controlled-native-probe-key");
    const measured = { ...initFrame([]), mode: "measured" } as Record<string, unknown>;
    delete measured.scriptedSteps;
    fx.send(measured);
    await fx.waitFor("ready");
    fx.send({ type: "prompt", prompt: "controlled native transport denial probe" });
    fx.child.stdin.end();
    const result = await fx.waitFor("result");
    expect(await fx.exit).toBe(0);
    expect(result.outcome).toBe("infrastructure-failure");
    expect(JSON.stringify(fx.frames)).toContain("blocked before networking");
    expect(JSON.stringify(fx.frames)).toContain("generativelanguage.googleapis.com");
  });

  it("never substitutes a synthetic key while initializing measured transport", async () => {
    const fx = await fixture(null);
    const measured = { ...initFrame([]), mode: "measured" } as Record<string, unknown>;
    delete measured.scriptedSteps;
    fx.send(measured);
    fx.child.stdin.end();
    const error = await fx.waitFor("error");
    expect(error.error).toContain("credential was unavailable");
    expect(await fx.exit).toBe(1);
  });

  it("bounds malformed/oversized request errors without echoing private payload", async () => {
    const fx = await fixture();
    fx.child.stdin.write(`${"x".repeat(1024 * 1024 + 1)}\n`);
    fx.child.stdin.end();
    const error = await fx.waitFor("error");
    expect(await fx.exit).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(error))).toBeLessThan(1024 * 1024);
    expect(fx.stdout).not.toContain("x".repeat(100));
  });

  it("proves a child waiting at readiness barrier receives its full execution allowance", async () => {
    const wrapperDir = mkdtempSync(join(tmpdir(), "pi-guest-barrier-proof-"));
    const wrapper = join(wrapperDir, "barrier-proof.mjs");
    const guestModule = pathToFileURL(join(process.cwd(), "evals/src/harnesses/pi/guest-agent.ts")).href;
    writeFileSync(wrapper, `
import { runGuestAgent } from ${JSON.stringify(guestModule)};

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, milliseconds, ...args) => realSetTimeout(callback,
  milliseconds >= 300000 ? milliseconds / 100 : milliseconds, ...args);
runGuestAgent({ controlSocket: process.env.EVAL_CONTROL_SOCKET }).catch((error) => {
  process.stderr.write(String(error) + "\\n");
  process.exitCode = 1;
});
`);
    try {
      const fx = await fixture("synthetic-barrier-proof-key", 0, { entry: wrapper });
      // Waiting 3500ms crosses the scaled old 300000ms readiness cap (3000ms), and
      // also leaves no usable prompt time if processLifetimeMs were counted from boot.
      // The new serial wait allowance survives; prompt then has its full real 3000ms.
      fx.send({
        ...initFrame([
          { type: "toolCall", toolCalls: [{ id: "slow", name: "bash", arguments: { command: "sleep 1.8; echo ok > out.txt" } }] },
          { type: "text", text: "step completed" },
        ]),
        processLifetimeMs: 3600,
        armWallClockMs: 3000,
      });
      await fx.waitFor("ready");
      // Simulate waiting at the readiness barrier while sibling arm runs
      await new Promise((resolve) => setTimeout(resolve, 3500));

      fx.send({ type: "prompt", prompt: "run step after barrier" });
      fx.child.stdin.end();
      const result = await fx.waitFor("result");
      expect(await fx.exit, `${fx.stdout}\n${fx.stderr}`).toBe(0);
      expect(result.outcome).toBe("completed");
      expect(result.terminal.classification).toBe("completed");
      expect(result.terminal.semanticAbortCause).toBeNull();
    } finally {
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  });

  it("bounds a never-prompted guest with pre-prompt lifetime", async () => {
    const wrapperDir = mkdtempSync(join(tmpdir(), "pi-guest-preprompt-proof-"));
    const wrapper = join(wrapperDir, "preprompt-proof.mjs");
    const guestModule = pathToFileURL(join(process.cwd(), "evals/src/harnesses/pi/guest-agent.ts")).href;
    writeFileSync(wrapper, `
import { runGuestAgent } from ${JSON.stringify(guestModule)};
runGuestAgent({ controlSocket: process.env.EVAL_CONTROL_SOCKET }).catch((error) => {
  process.stderr.write(String(error) + "\\n");
  process.exitCode = 1;
});
`);
    try {
      const fx = await fixture("synthetic-preprompt-key", 0, { entry: wrapper });
      fx.send(initFrame([{ type: "text", text: "never prompted" }]));
      await fx.waitFor("ready");
      fx.child.stdin.end();
      expect(await fx.exit).toBe(1);
    } finally {
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  });

  it("classifies timer tie between arm budget and process lifetime as task-limit (P1-B)", async () => {
    const wrapperDir = mkdtempSync(join(tmpdir(), "pi-guest-timer-tie-"));
    const wrapper = join(wrapperDir, "timer-tie-proof.mjs");
    const guestModule = pathToFileURL(join(process.cwd(), "evals/src/harnesses/pi/guest-agent.ts")).href;
    writeFileSync(wrapper, `
import { runGuestAgent } from ${JSON.stringify(guestModule)};
runGuestAgent({ controlSocket: process.env.EVAL_CONTROL_SOCKET }).catch((error) => {
  process.stderr.write(String(error) + "\\n");
  process.exitCode = 1;
});
`);
    try {
      const fx = await fixture("synthetic-timer-tie-key", 0, { entry: wrapper });
      // When armWallClockMs == processLifetimeMs (e.g. at the maximum 180000 allowance),
      // armTimer must fire before lifetimeTimer so exhaustion classifies as task-limit
      // (semanticAbortCause: "arm-budget") rather than failing closed with infrastructure-failure.
      fx.send({
        ...initFrame([
          { type: "toolCall", toolCalls: [{ id: "slow", name: "bash", arguments: { command: "sleep 2; echo ok" } }] },
          { type: "text", text: "never reached" },
        ]),
        processLifetimeMs: 1200,
        armWallClockMs: 1200,
      });
      await fx.waitFor("ready");
      fx.send({ type: "prompt", prompt: "run step that exhausts allowance" });
      fx.child.stdin.end();

      const result = await fx.waitFor("result");
      expect(await fx.exit, `${fx.stdout}\n${fx.stderr}`).toBe(0);
      expect(result.outcome).toBe("task-limit");
      expect(result.terminal.classification).toBe("task-limit");
      expect(result.terminal.semanticAbortCause).toBe("arm-budget");
    } finally {
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  });
});
