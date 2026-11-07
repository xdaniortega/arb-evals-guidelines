/**
 * @notice Verifies the Pi harness adapter normalizes runtime outcomes, budgets, cancellation, attestation, and evidence.
 */

import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EMPTY_SKILL_TOOL_BUNDLE } from "../../core/skill-tools.ts";
import { EvalError, SAFE_DEFAULT_LIMITS } from "../../core/types.ts";
import { canonicalJsonSha256 } from "../../core/experiment.ts";
import type { Guest } from "../../sandboxes/sandbox.ts";
import type { HarnessRequest } from "../harness.ts";
import { createPiHarness } from "./adapter.ts";
import { createScriptedStreamSimple } from "./scripted-stream.ts";
import { createPiSdkSession, type PiSdkSessionInstance } from "./sdk-session.ts";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function createMockGuest(workspaceDir?: string): Guest {
  const root = workspaceDir ?? makeTempDir("mock-guest-ws");
  return {
    name: "mock-guest",
    networkName: "mock-net",
    imageDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    hostWorkspaceDir: root,
    // The in-process harness now REQUIRES both host-visible seams and rejects a guest that
    // supplies only one. A guest exposing a host workspace but no path mapping previously
    // fell through to a silent host-side fallback; that fallback is gone.
    resolveGuestPath: (guestPath: string) => guestPath,
    stage: async () => undefined,
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false }),
    exportFiles: async () => ({ files: [], truncated: false, skipped: [] }),
    attest: async () => {
      throw new Error("not implemented in mock");
    },
    deliverCredential: async () => undefined,
    destroy: async () => ({ status: "destroyed", verified: true, failure: null }),
  };
}

function createMockSkill(dir: string, name: string): string {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill for evaluation\n---\n# ${name}\nSkill instructions.\n`,
    "utf8",
  );
  return skillDir;
}

function createMockRequest(overrides: Partial<HarnessRequest> = {}): HarnessRequest {
  return {
    conditionId: "baseline",
    prompt: "Write a test file",
    workspaceRoot: "/workspace",
    skillPaths: [],
    allowedTools: ["read", "write", "edit", "bash"],
    skillToolBundle: null,
    skillToolBundleSha256: canonicalJsonSha256(EMPTY_SKILL_TOOL_BUNDLE),
    limits: {
      ...SAFE_DEFAULT_LIMITS,
      wallClockMs: 10_000,
    },
    target: { provider: "google", model: "gemini-3.8-flash", thinking: "low" },
    ...overrides,
  };
}

function remoteGuestForFrames(mutate: (type: "ready" | "result", frame: any) => any = (_type, frame) => frame, terminalExit = 0,
  afterResult?: (streams: { output: PassThrough; stderr: PassThrough; close(code: number): void }) => void,
  terminationReason: "confirmed" | "forced" = "confirmed"): Guest {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  let resolveExit!: (code: number | null) => void;
  const exitCode = new Promise<number | null>((resolve) => { resolveExit = resolve; });
  let buffer = "";
  input.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const request = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      const header = { type: "session", version: 3, id: "session-1", timestamp: new Date().toISOString(), cwd: "/workspace" };
      if (request.type === "init") {
        const ready = { type: "ready", protocolVersion: 1, sessionId: "session-1", header, attestation: { arm: "baseline", target: { provider: "google", model: "gemini-3.8-flash", thinking: "low" }, modelId: "gemini-3.8-flash", providerId: "google", thinkingLevel: "low", activeTools: ["read", "write", "edit", "bash", "mcp"], mcpClientId: "shared-mcp-client-v1", seededMcpServers: [], skillToolBundleSha256: null, loadedSkills: [], agentsFilesCount: 0, extensionsCount: 0, promptsCount: 0, themesCount: 0, retryEnabled: false, compactionEnabled: false }, process: { platform: "linux", pid: 42, uid: 10001, gid: 10001, cwd: "/workspace" } };
        output.write(`${JSON.stringify(mutate("ready", ready))}\n`);
        output.write(`${JSON.stringify({ type: "record", protocolVersion: 1, sequence: 1, record: header, redactions: { count: 0, entries: [] } })}\n`);
      } else if (request.type === "prompt") {
        const result = { type: "result", protocolVersion: 1, sessionId: "session-1", outcome: "completed", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, providerRequests: 1, toolSteps: 0, taskLimitReason: null }, timing: { startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 1 }, terminal: { stopReason: null, rawStopReason: null, classification: "completed", stopCause: "completed", semanticAbortCause: null, error: null, streamingStopped: true }, redactions: { count: 0, entries: [] } };
        output.write(`${JSON.stringify(mutate("result", result))}\n`);
        queueMicrotask(() => {
          if (afterResult) afterResult({ output, stderr, close: (code) => { output.end(); stderr.end(); resolveExit(code); } });
          else { output.end(); stderr.end(); resolveExit(terminalExit); }
        });
      }
    }
  });
  return { name: "remote", networkName: "net", imageDigest: "sha256:remote", stage: async () => undefined,
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false }),
    execStream: async () => ({ stdin: input, stdout: output, stderr, kill: () => resolveExit(1), exitCode, termination: Promise.resolve(terminationReason) }),
    exportFiles: async () => ({ files: [], truncated: false, skipped: [] }), attest: async () => { throw new Error("unused"); },
    deliverCredential: async () => undefined, destroy: async () => ({ status: "destroyed", verified: true, failure: null }) };
}

describe("Pi SDK harness adapter", () => {
  it("drives prompt to completion and normalizes evidence with SDK session", async () => {
    const ws = makeTempDir("pi-complete");
    const guest = createMockGuest(ws);
    const request = createMockRequest();

    const streamSimpleOverride = createScriptedStreamSimple([
      {
        type: "toolCall",
        toolCalls: [{ name: "write", arguments: { path: "output.txt", content: "completed" } }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      {
        type: "text",
        text: "Task completed successfully",
        usage: {
          input: 150,
          output: 42,
          cacheRead: 10,
          cacheWrite: 5,
          totalTokens: 207,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    ]);

    const harness = createPiHarness({ streamSimpleOverride });
    const result = await harness.run(guest, request);

    expect(result.outcome).toBe("completed");
    expect(result.runtime.harnessId).toBe("pi");
    expect(result.runtime.testDouble).toBe(true);
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    // Pi 1.x records the system prompt as the leading native message.
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[1]?.role).toBe("user");
    const assistantMsg = result.messages.find((m) => m.role === "assistant" && m.text.includes("Task completed"));
    expect(assistantMsg).toBeDefined();
    expect(result.toolSteps.length).toBe(1);
    expect(result.toolSteps[0]?.tool).toBe("write");
    expect(result.toolSteps[0]?.outcome).toBe("ok");
    expect(result.usage.inputTokens).toBe(150);
    expect(result.usage.outputTokens).toBe(42);
    expect(result.usage.providerRequests).toBeGreaterThanOrEqual(1);
    expect(result.usage.toolSteps).toBe(1);

    rmSync(ws, { recursive: true, force: true });
  });

  it("rejects forced stream settlement as cleanup-failed without confirmed closure", async () => {
    const guest = remoteGuestForFrames((_type, frame) => frame, 0, undefined, "forced");
    const request = createMockRequest();
    const harness = createPiHarness({ scriptedSteps: [{ type: "text", text: "remote" }] });
    await expect(harness.attest(guest, request)).resolves.toBeDefined();
    await expect(harness.run(guest, request)).rejects.toMatchObject({ code: "cleanup-failed" });
  });

  it("drives the image-resident framed session for a remote guest without host fallback", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const sent: any[] = [];
    let resolveExit!: (code: number | null) => void;
    const exitCode = new Promise<number | null>((resolve) => { resolveExit = resolve; });
    let buffer = "";
    input.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const frame = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        sent.push(frame);
        if (frame.type === "init") {
          const header = { type: "session", version: 3, id: "session-1", timestamp: new Date().toISOString(), cwd: "/work" };
          output.write(JSON.stringify({ type: "ready", protocolVersion: 1, sessionId: "session-1", header, attestation: { arm: "baseline", target: { provider: "google", model: "gemini-3.8-flash", thinking: "low" }, modelId: "gemini-3.8-flash", providerId: "google", thinkingLevel: "low", activeTools: ["read", "write", "edit", "bash", "mcp"], mcpClientId: "shared-mcp-client-v1", seededMcpServers: [], skillToolBundleSha256: null, loadedSkills: [], agentsFilesCount: 0, extensionsCount: 0, promptsCount: 0, themesCount: 0, retryEnabled: false, compactionEnabled: false }, process: { platform: "linux", pid: 42, uid: 10001, gid: 10001, cwd: "/workspace" } }) + "\n");
          output.write(JSON.stringify({ type: "record", protocolVersion: 1, sequence: 1, record: header, redactions: { count: 0, entries: [] } }) + "\n");
        } else if (frame.type === "prompt") {
          output.write(JSON.stringify({ type: "record", protocolVersion: 1, sequence: 2, record: { type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: frame.prompt } }, redactions: { count: 0, entries: [] } }) + "\n");
          output.write(JSON.stringify({ type: "result", protocolVersion: 1, sessionId: "session-1", outcome: "completed", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, providerRequests: 1, toolSteps: 0, taskLimitReason: null }, timing: { startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 3 }, terminal: { stopReason: null, rawStopReason: null, classification: "completed", stopCause: "completed", semanticAbortCause: null, error: null, streamingStopped: true }, redactions: { count: 0, entries: [] } }) + "\n");
          queueMicrotask(() => { output.end(); resolveExit(0); });
        }
      }
    });
    const guest: Guest = {
      name: "remote", networkName: "net", imageDigest: "sha256:remote",
      stage: async () => undefined,
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false }),
      execStream: async () => ({ stdin: input, stdout: output, kill: () => undefined, exitCode, termination: Promise.resolve("confirmed" as const) }),
      exportFiles: async () => ({ files: [], truncated: false, skipped: [] }),
      attest: async () => { throw new Error("unused"); }, deliverCredential: async () => undefined,
      destroy: async () => ({ status: "destroyed", verified: true, failure: null }),
    };
    const recorded: unknown[] = [];
    const request = createMockRequest({ nativeSessionRecorder: { record: (entry) => recorded.push(entry) } });
    const harness = createPiHarness({ scriptedSteps: [{ type: "text", text: "remote" }] });
    await expect(harness.attest(guest, request)).resolves.toMatchObject({ runtime: { harnessId: "pi", testDouble: true } });
    const result = await harness.run(guest, request);
    expect(result.outcome).toBe("completed");
    expect(result.nativeSessionEntries?.[0]).toMatchObject({ type: "session", id: "session-1" });
    expect(recorded).toHaveLength(2);
    expect(sent.map((frame) => frame.type)).toEqual(["init", "prompt"]);
    expect(sent[0]).toMatchObject({ mode: "scripted", arm: "baseline", skillPath: null });
  });

  it.each([
    ["missing baseline attestation", (frame: any) => ({ ...frame, attestation: undefined })],
    ["provider drift", (frame: any) => ({ ...frame, attestation: { ...frame.attestation, providerId: "anthropic" } })],
    ["ambient process drift", (frame: any) => ({ ...frame, process: { ...frame.process, uid: 0 } })],
    ["unknown ready field", (frame: any) => ({ ...frame, extra: true })],
    ["non-array loaded skills", (frame: any) => ({ ...frame, attestation: { ...frame.attestation, loadedSkills: null } })],
  ])("rejects remote readiness protocol: %s", async (_name, mutateReady) => {
    const harness = createPiHarness({ scriptedSteps: [{ type: "text", text: "remote" }] });
    await expect(harness.attest(remoteGuestForFrames((type, frame) => type === "ready" ? mutateReady(frame) : frame), createMockRequest())).rejects.toBeInstanceOf(EvalError);
  });

  it.each([
    ["stream not stopped", (frame: any) => ({ ...frame, terminal: { ...frame.terminal, streamingStopped: false } })],
    ["negative telemetry", (frame: any) => ({ ...frame, usage: { ...frame.usage, outputTokens: -1 } })],
    ["unknown result field", (frame: any) => ({ ...frame, extra: true })],
    ["missing raw stop reason field", (frame: any) => { const t = { ...frame.terminal }; delete t.rawStopReason; return { ...frame, terminal: t }; }],
    ["non-string raw stop reason", (frame: any) => ({ ...frame, terminal: { ...frame.terminal, rawStopReason: 42 } })],
  ])("rejects remote terminal protocol: %s", async (_name, mutateResult) => {
    const harness = createPiHarness({ scriptedSteps: [{ type: "text", text: "remote" }] });
    const guest = remoteGuestForFrames((type, frame) => type === "result" ? mutateResult(frame) : frame);
    const request = createMockRequest();
    await harness.attest(guest, request);
    await expect(harness.run(guest, request)).rejects.toBeInstanceOf(EvalError);
  });

  it.each([
    ["provider error despite an exhausted budget", (frame: any) => ({
      ...frame,
      outcome: "task-limit",
      usage: { ...frame.usage, taskLimitReason: "output token budget exhausted" },
      terminal: { ...frame.terminal, stopReason: "error", classification: "task-limit", error: "provider failed" },
    })],
    ["external abort despite an exhausted budget", (frame: any) => ({
      ...frame,
      outcome: "task-limit",
      usage: { ...frame.usage, taskLimitReason: "output token budget exhausted" },
      terminal: { ...frame.terminal, stopReason: "aborted", classification: "task-limit", semanticAbortCause: "external" },
    })],
  ])("rejects contradictory remote task-limit precedence: %s", async (_name, mutateResult) => {
    const harness = createPiHarness({ scriptedSteps: [{ type: "text", text: "remote" }] });
    const guest = remoteGuestForFrames((type, frame) => type === "result" ? mutateResult(frame) : frame);
    const request = createMockRequest();
    await harness.attest(guest, request);
    await expect(harness.run(guest, request)).rejects.toMatchObject({ code: "protocol-drift" });
  });

  it("preserves the RAW provider stop reason from the guest terminal frame (remote path)", async () => {
    const harness = createPiHarness({ scriptedSteps: [{ type: "text", text: "remote" }] });
    const guest = remoteGuestForFrames((type, frame) => type === "result"
      ? {
          ...frame,
          outcome: "task-limit",
          terminal: { ...frame.terminal, stopReason: "length", rawStopReason: "MAX_TOKENS", classification: "task-limit", stopCause: "provider-response-length" },
        }
      : frame);
    const request = createMockRequest();
    await harness.attest(guest, request);
    const result = await harness.run(guest, request);
    expect(result.outcome).toBe("task-limit");
    expect(result.providerStopReason).toBe("MAX_TOKENS");
    expect(result.stopCause).toBe("provider-response-length");
  });

  it("falls back to the normalized guest stop reason when the raw reason is null (remote path)", async () => {
    const harness = createPiHarness({ scriptedSteps: [{ type: "text", text: "remote" }] });
    const guest = remoteGuestForFrames((type, frame) => type === "result"
      ? {
          ...frame,
          outcome: "task-limit",
          terminal: { ...frame.terminal, stopReason: "length", rawStopReason: null, classification: "task-limit", stopCause: "provider-response-length" },
        }
      : frame);
    const request = createMockRequest();
    await harness.attest(guest, request);
    const result = await harness.run(guest, request);
    expect(result.providerStopReason).toBe("length");
  });

  it.each([
    ["trailing frame", ({ output, close }: any) => { output.write('{"type":"record"}\\n'); close(0); }, []],
    ["torn suffix", ({ output, close }: any) => { output.write('{"type":'); close(0); }, []],
    ["late secret stderr", ({ stderr, close }: any) => { stderr.write('late-secret-canary'); close(0); }, [{ label: "late", value: "late-secret-canary" }]],
  ])("rejects %s after an otherwise valid result", async (_name, afterResult, guardedSecrets) => {
    const harness = createPiHarness({ scriptedSteps: [{ type: "text", text: "remote" }] });
    const guest = remoteGuestForFrames(undefined, 0, afterResult);
    const request = createMockRequest({ guardedSecrets });
    await harness.attest(guest, request);
    await expect(harness.run(guest, request)).rejects.toBeInstanceOf(EvalError);
  });

  it("preserves a late stderr secret quarantine when killing the stream produces a nonzero exit", async () => {
    const harness = createPiHarness({ scriptedSteps: [{ type: "text", text: "remote" }] });
    const guest = remoteGuestForFrames(undefined, 1, ({ stderr, close }) => {
      stderr.write("late-secret-canary");
      close(1);
    });
    const request = createMockRequest({ guardedSecrets: [{ label: "late", value: "late-secret-canary" }] });
    await harness.attest(guest, request);
    await expect(harness.run(guest, request)).rejects.toMatchObject({ code: "secret-quarantine" });
  });

  it("rejects exit 1 even after one otherwise valid result frame", async () => {
    const harness = createPiHarness({ scriptedSteps: [{ type: "text", text: "remote" }] });
    const guest = remoteGuestForFrames(undefined, 1);
    const request = createMockRequest();
    await harness.attest(guest, request);
    await expect(harness.run(guest, request)).rejects.toMatchObject({ code: "protocol-drift" });
  });

  it("configures, attests, and executes ON THAT SAME session instance", async () => {
    const ws = makeTempDir("pi-same-session");
    const guest = createMockGuest(ws);
    const request = createMockRequest();

    const createdSessions: PiSdkSessionInstance[] = [];
    const streamSimpleOverride = createScriptedStreamSimple([
      { type: "text", text: "Verified same session" },
    ]);

    const harness = createPiHarness({
      streamSimpleOverride,
      onSessionCreated: (s) => createdSessions.push(s),
    });

    // 1. Attest
    const attestation = await harness.attest(guest, request);
    expect(attestation.runtime.harnessId).toBe("pi");
    expect(createdSessions.length).toBe(1);
    const attestedSession = createdSessions[0]!;

    // 2. Run
    const result = await harness.run(guest, request);
    expect(result.outcome).toBe("completed");
    // No second session created! Exactly ONE session configured, attested, and executed
    expect(createdSessions.length).toBe(1);
    expect(createdSessions[0]).toBe(attestedSession);

    rmSync(ws, { recursive: true, force: true });
  });

  it("attests 0 skills for baseline and exactly 1 matching skill for treatment", async () => {
    const tempSkills = makeTempDir("pi-skills");
    const skillPath = createMockSkill(tempSkills, "arbitrum-docs");

    const baselineGuest = createMockGuest();
    const treatmentGuest = createMockGuest();

    const harness = createPiHarness({
      streamSimpleOverride: createScriptedStreamSimple([{ type: "text", text: "ok" }]),
    });

    // Baseline: 0 skills requested -> passes
    const baselineReq = createMockRequest({ conditionId: "baseline", skillPaths: [] });
    const baselineAttest = await harness.attest(baselineGuest, baselineReq);
    expect(baselineAttest.runtime.skillPaths).toEqual([]);

    // Treatment: 1 skill requested -> passes
    const treatmentReq = createMockRequest({ conditionId: "treatment", skillPaths: [skillPath] });
    const treatmentAttest = await harness.attest(treatmentGuest, treatmentReq);
    expect(treatmentAttest.runtime.skillPaths).toEqual([skillPath]);

    // Baseline with unexpected skill fails
    const badBaselineReq = createMockRequest({ conditionId: "baseline", skillPaths: [skillPath] });
    await expect(harness.attest(baselineGuest, badBaselineReq)).rejects.toThrow(EvalError);

    // Treatment with 0 skills fails
    const badTreatmentReq = createMockRequest({ conditionId: "treatment", skillPaths: [] });
    await expect(harness.attest(treatmentGuest, badTreatmentReq)).rejects.toThrow(EvalError);

    rmSync(tempSkills, { recursive: true, force: true });
  });

  it("maps stopReason length to task-limit outcome and preserves the RAW provider stop reason (local path)", async () => {
    const ws = makeTempDir("pi-length");
    const guest = createMockGuest(ws);
    const request = createMockRequest();

    const streamSimpleOverride = createScriptedStreamSimple([
      {
        type: "stop",
        stopReason: "length",
        rawStopReason: "MAX_TOKENS",
        text: "truncated text...",
      },
    ]);

    const harness = createPiHarness({ streamSimpleOverride });
    const result = await harness.run(guest, request);

    expect(result.outcome).toBe("task-limit");
    // providerStopReason persists the RAW reason, not the normalized `length`.
    expect(result.providerStopReason).toBe("MAX_TOKENS");
    // Unlimited output budget: a native `length` truncation is provider-response-length,
    // and classification still uses the NORMALIZED reason despite the raw one persisting.
    expect(result.stopCause).toBe("provider-response-length");
    rmSync(ws, { recursive: true, force: true });
  });

  it("falls back to the normalized stop reason when no RAW provider reason was captured (local path)", async () => {
    const ws = makeTempDir("pi-length-fallback");
    const guest = createMockGuest(ws);
    const request = createMockRequest();

    const streamSimpleOverride = createScriptedStreamSimple([
      { type: "stop", stopReason: "length", text: "truncated text..." },
    ]);

    const harness = createPiHarness({ streamSimpleOverride });
    const result = await harness.run(guest, request);

    expect(result.outcome).toBe("task-limit");
    // No rawStopReason on the message, so the normalized reason is preserved instead.
    expect(result.providerStopReason).toBe("length");
    rmSync(ws, { recursive: true, force: true });
  });

  it("executes exactly the first N eligible native tool calls and blocks N+1", async () => {
    const ws = makeTempDir("pi-max-tools");
    const guest = createMockGuest(ws);
    const request = createMockRequest({
      limits: { ...SAFE_DEFAULT_LIMITS, maxToolSteps: 2 },
    });

    const streamSimpleOverride = createScriptedStreamSimple([
      {
        type: "toolCall",
        toolCalls: [
          { id: "write-1", name: "write", arguments: { path: "f1.txt", content: "1" } },
          { id: "write-2", name: "write", arguments: { path: "f2.txt", content: "2" } },
          { id: "write-3", name: "write", arguments: { path: "f3.txt", content: "3" } },
        ],
      },
    ]);

    const harness = createPiHarness({ streamSimpleOverride });
    const result = await harness.run(guest, request);

    expect(result.outcome).toBe("task-limit");
    expect(result.stopCause).toBe("tool-steps");
    expect(result.usage.toolSteps).toBe(2);
    expect(existsSync(join(ws, "f1.txt"))).toBe(true);
    expect(existsSync(join(ws, "f2.txt"))).toBe(true);
    expect(existsSync(join(ws, "f3.txt"))).toBe(false);
    expect(JSON.stringify(result.nativeSessionEntries)).toContain("tool steps budget of 2 exhausted");
    expect(result.failures).toEqual([]);
    rmSync(ws, { recursive: true, force: true });
  });

  it("delegates provider requests 1..N and stops before request N+1", async () => {
    const ws = makeTempDir("pi-max-reqs");
    const guest = createMockGuest(ws);
    const request = createMockRequest({
      limits: { ...SAFE_DEFAULT_LIMITS, maxProviderRequests: 2 },
    });
    let driverCalls = 0;
    const streamSimpleOverride = createScriptedStreamSimple(() => {
      driverCalls += 1;
      return {
        type: "toolCall" as const,
        toolCalls: [{ name: "write", arguments: { path: `f${driverCalls}.txt`, content: String(driverCalls) } }],
      };
    });

    const harness = createPiHarness({ streamSimpleOverride });
    const result = await harness.run(guest, request);

    expect(result.outcome).toBe("task-limit");
    expect(result.stopCause).toBe("provider-requests");
    expect(result.usage.providerRequests).toBe(2);
    expect(driverCalls).toBe(2);
    expect(existsSync(join(ws, "f1.txt"))).toBe(true);
    expect(existsSync(join(ws, "f2.txt"))).toBe(true);
    expect(existsSync(join(ws, "f3.txt"))).toBe(false);
    expect(result.failures).toEqual([]);
    rmSync(ws, { recursive: true, force: true });
  });

  it("returns a terminal aborted stream at N+1 without delegating it", async () => {
    const ws = makeTempDir("pi-request-terminal");
    let driverCalls = 0;
    let created: PiSdkSessionInstance | undefined;
    const streamSimpleOverride = createScriptedStreamSimple(() => {
      driverCalls += 1;
      return { type: "text", text: "final" };
    });
    const harness = createPiHarness({
      streamSimpleOverride,
      onSessionCreated: (instance) => { created = instance; },
    });

    const result = await harness.run(
      createMockGuest(ws),
      createMockRequest({ limits: { ...SAFE_DEFAULT_LIMITS, maxProviderRequests: 1 } }),
    );
    expect(result.outcome).toBe("completed");
    expect(driverCalls).toBe(1);

    const instance = created!;
    const terminal = instance.modelRuntime.streamSimple(
      instance.session.model!,
      { systemPrompt: "", messages: [] },
    );
    const terminalMessage = await terminal.result();
    expect(terminalMessage.stopReason).toBe("aborted");
    expect(terminalMessage.errorMessage).toContain("provider requests budget of 1 exhausted");
    expect(driverCalls).toBe(1);
    expect(instance.getBudgetSnapshot().providerRequests).toBe(1);
    rmSync(ws, { recursive: true, force: true });
  });

  it("allows a final response after exactly N tools complete without a rejection", async () => {
    const ws = makeTempDir("pi-exact-tools-final");
    const guest = createMockGuest(ws);
    const request = createMockRequest({
      limits: { ...SAFE_DEFAULT_LIMITS, maxToolSteps: 2 },
    });
    const streamSimpleOverride = createScriptedStreamSimple([
      {
        type: "toolCall",
        toolCalls: [
          { name: "write", arguments: { path: "f1.txt", content: "1" } },
          { name: "write", arguments: { path: "f2.txt", content: "2" } },
        ],
      },
      { type: "text", text: "done" },
    ]);

    const result = await createPiHarness({ streamSimpleOverride }).run(guest, request);

    expect(result.outcome).toBe("completed");
    expect(result.usage.toolSteps).toBe(2);
    expect(result.usage.providerRequests).toBe(2);
    expect(existsSync(join(ws, "f1.txt"))).toBe(true);
    expect(existsSync(join(ws, "f2.txt"))).toBe(true);
    rmSync(ws, { recursive: true, force: true });
  });

  it("forwards remaining output maxTokens and classifies observed overrun honestly", async () => {
    const ws = makeTempDir("pi-output-budget");
    const guest = createMockGuest(ws);
    const request = createMockRequest({
      limits: { ...SAFE_DEFAULT_LIMITS, maxOutputTokens: 10 },
    });
    const observedMaxTokens: Array<number | undefined> = [];
    const observedMaxRetries: Array<number | undefined> = [];
    let call = 0;
    const scripted = createScriptedStreamSimple((_model, _context, streamOptions) => {
      observedMaxTokens.push(streamOptions?.maxTokens);
      observedMaxRetries.push(streamOptions?.maxRetries);
      call += 1;
      return call === 1
        ? {
            type: "toolCall" as const,
            toolCalls: [{ name: "write", arguments: { path: "out.txt", content: "ok" } }],
            usage: {
              input: 1, output: 4, cacheRead: 2, cacheWrite: 3, totalTokens: 10,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          }
        : {
            type: "text" as const,
            text: "overrun observed",
            usage: {
              input: 1, output: 7, cacheRead: 2, cacheWrite: 3, totalTokens: 13,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
    });

    const result = await createPiHarness({ streamSimpleOverride: scripted }).run(guest, request);

    expect(observedMaxTokens).toEqual([10, 6]);
    expect(observedMaxRetries).toEqual([0, 0]);
    expect(result.usage.outputTokens).toBe(11);
    expect(result.outcome).toBe("task-limit");
    expect(result.stopCause).toBe("cumulative-output-tokens");
    rmSync(ws, { recursive: true, force: true });
  });

  it.each([false, true])("handles exact output exhaustion with continuation=%s", async (continuation) => {
    const ws = makeTempDir("pi-exact-output");
    let requests = 0;
    const usage = { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const stream = createScriptedStreamSimple(() => {
      requests++;
      return continuation
        ? { type: "toolCall", toolCalls: [{ name: "write", arguments: { path: "out.txt", content: "ok" } }], usage }
        : { type: "text", text: "final answer", usage };
    });
    try {
      const result = await createPiHarness({ streamSimpleOverride: stream }).run(createMockGuest(ws),
        createMockRequest({ limits: { ...SAFE_DEFAULT_LIMITS, maxOutputTokens: 10 } }));
      expect(requests).toBe(1);
      expect(result.usage.outputTokens).toBe(10);
      expect(result.outcome).toBe(continuation ? "task-limit" : "completed");
      if (continuation) expect(existsSync(join(ws, "out.txt"))).toBe(true);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it("counts actual admitted tools when the SDK wrapper has no budget", async () => {
    const ws = makeTempDir("pi-unbudgeted-tool");
    const instance = await createPiSdkSession({ cwd: ws, agentDir: join(ws, "agent"), arm: "baseline",
      target: createMockRequest().target, allowedTools: ["write"], inMemorySession: true,
      streamSimpleOverride: createScriptedStreamSimple([
        { type: "toolCall", toolCalls: [{ name: "write", arguments: { path: "one.txt", content: "1" } }] },
        { type: "text", text: "done" },
      ]),
    });
    try {
      await instance.runPrompt("write once");
      expect(existsSync(join(ws, "one.txt"))).toBe(true);
      expect(instance.getBudgetSnapshot().toolSteps).toBe(1);
    } finally { instance.dispose(); rmSync(ws, { recursive: true, force: true }); }
  });

  it.each(["same-text TypeError", "generic error"])("does not suppress an unrelated %s after a missing-usage completion", async (kind) => {
    const ws = makeTempDir("pi-error-provenance");
    let nativeUsageErrorObserved = false;
    const injected = kind === "same-text TypeError"
      ? new TypeError("Cannot read properties of undefined (reading 'input')")
      : new Error("unexpected lifecycle failure");
    try {
      const harness = createPiHarness({
        streamSimpleOverride: createScriptedStreamSimple([{ type: "text", text: "done" }]),
        onSessionCreated(instance) {
          const prompt = instance.session.prompt.bind(instance.session);
          vi.spyOn(instance.session, "prompt").mockImplementation(async (...args) => {
            try { await prompt(...args); }
            catch (error) {
              nativeUsageErrorObserved = error instanceof TypeError && (error.stack?.includes("isContextOverflow") ?? false);
              if (!nativeUsageErrorObserved) throw error;
              throw injected;
            }
            throw new Error("expected pinned native missing-usage error");
          });
        },
      });
      const result = await harness.run(createMockGuest(ws), createMockRequest());
      expect(nativeUsageErrorObserved).toBe(true);
      expect(result.outcome).toBe("infrastructure-failure");
      expect(result.failures[0]?.message).toBe(String(injected));
      expect(result.usage.outputTokens).toBeNull();
    } finally { vi.restoreAllMocks(); rmSync(ws, { recursive: true, force: true }); }
  });

  it.each([false, true])("keeps unknown execution errors infrastructural with exhausted budget=%s", async (exhausted) => {
    const ws = makeTempDir("pi-error-precedence");
    try {
      const harness = createPiHarness({
        streamSimpleOverride: createScriptedStreamSimple([{ type: "text", text: "done", usage: {
          input: 1, output: exhausted ? 11 : 1, cacheRead: 0, cacheWrite: 0, totalTokens: exhausted ? 12 : 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        } }]),
        onSessionCreated(instance) {
          const prompt = instance.runPrompt;
          vi.spyOn(instance, "runPrompt").mockImplementation(async (text) => {
            await prompt(text);
            expect(instance.getBudgetSnapshot().taskLimitReason !== null).toBe(exhausted);
            throw new Error("unexpected lifecycle failure");
          });
        },
      });
      const result = await harness.run(createMockGuest(ws), createMockRequest({ limits: { ...SAFE_DEFAULT_LIMITS, maxOutputTokens: 10 } }));
      expect(result.outcome).toBe("infrastructure-failure");
      expect(result.failures[0]?.message).toBe("Error: unexpected lifecycle failure");
    } finally { vi.restoreAllMocks(); rmSync(ws, { recursive: true, force: true }); }
  });

  it("maps wall-clock deadline budget exhaustion to task-limit outcome", async () => {
    const ws = makeTempDir("pi-timeout");
    const guest = createMockGuest(ws);
    const request = createMockRequest({
      limits: { ...SAFE_DEFAULT_LIMITS, wallClockMs: 50 },
    });

    // Slow response that exceeds 50ms
    const streamSimpleOverride = () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({ type: "text", text: "slow response" });
        }, 300);
      });

    const harness = createPiHarness({ streamSimpleOverride: streamSimpleOverride as any });
    const result = await harness.run(guest, request);

    expect(result.outcome).toBe("task-limit");
    expect(result.stopCause).toBe("wall-clock");
    rmSync(ws, { recursive: true, force: true });
  });

  it("classifies an UNLIMITED arm's native `length` truncation as provider-response-length", async () => {
    const ws = makeTempDir("pi-native-length");
    // Default task budgets are unlimited (maxOutputTokens === null): no cumulative clamp is
    // ever injected, so a provider `length` stop is the provider's own per-response limit.
    const harness = createPiHarness({
      streamSimpleOverride: createScriptedStreamSimple([
        {
          type: "stop",
          stopReason: "length",
          text: "Truncated by the provider's native per-response limit",
          usage: { input: 100, output: 9001, cacheRead: 0, cacheWrite: 0, totalTokens: 9101, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
      ]),
    });
    const result = await harness.run(createMockGuest(ws), createMockRequest({ limits: { ...SAFE_DEFAULT_LIMITS } }));
    expect(result.outcome).toBe("task-limit");
    expect(result.providerStopReason).toBe("length");
    expect(result.stopCause).toBe("provider-response-length");
    rmSync(ws, { recursive: true, force: true });
  });

  it("classifies a clamped near-boundary `length` stop (7996/8000) as cumulative-output-tokens, not provider-native", async () => {
    const ws = makeTempDir("pi-clamp-length");
    // Multi-turn cumulative consumption under a finite 8000-token budget: turn 1 consumes
    // 7992 output tokens via a tool call, then turn 2's request is clamped to the SHRUNKEN
    // remainder (8) and the provider stops at `length` at cumulative 7996 — four short of
    // the cap. This is the injected clamp on a shrunken remainder, so it must report
    // cumulative-output-tokens, NOT provider-native truncation merely because 7996 != 8000.
    const harness = createPiHarness({
      streamSimpleOverride: createScriptedStreamSimple([
        {
          type: "toolCall",
          toolCalls: [{ name: "write", arguments: { path: "draft.txt", content: "partial draft" } }],
          usage: { input: 100, output: 7992, cacheRead: 0, cacheWrite: 0, totalTokens: 8092, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
        {
          type: "stop",
          stopReason: "length",
          text: "Truncated at the clamped remaining allowance",
          usage: { input: 100, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 104, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
      ]),
    });
    const result = await harness.run(createMockGuest(ws), createMockRequest({ limits: { ...SAFE_DEFAULT_LIMITS, maxOutputTokens: 8000 } }));
    expect(result.outcome).toBe("task-limit");
    expect(result.providerStopReason).toBe("length");
    expect(result.stopCause).toBe("cumulative-output-tokens");
    rmSync(ws, { recursive: true, force: true });
  });

  it("arms prompt execution deadline independently from request.deadlineAtMs", async () => {
    const ws = makeTempDir("pi-indep-deadline");
    const guest = createMockGuest(ws);
    // request.deadlineAtMs is set in the past (e.g. earlier arm or invocation start)
    const staleDeadline = Date.now() - 5_000;
    const request = createMockRequest({
      limits: { ...SAFE_DEFAULT_LIMITS, wallClockMs: 100 },
      deadlineAtMs: staleDeadline,
    });

    const streamSimpleOverride = createScriptedStreamSimple([
      { type: "text", text: "fresh window completed" },
    ]);

    const deadlines: number[] = [];
    const harness = createPiHarness({
      streamSimpleOverride,
      onSessionCreated: (instance) => {
        const originalSetDeadline = instance.setDeadline;
        (instance as { setDeadline?: (atMs: number) => void }).setDeadline = (deadlineMs: number) => {
          deadlines.push(deadlineMs);
          originalSetDeadline?.call(instance, deadlineMs);
        };
      },
    });

    // Attest first to simulate the readiness barrier, then wait before runPrompt
    await harness.attest(guest, request);
    const attestDoneTime = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const promptStart = Date.now();
    const result = await harness.run(guest, request);

    expect(result.outcome).toBe("completed");
    // setDeadline is called at prompt time (anchored at promptStart + wallClockMs)
    expect(deadlines.length).toBe(1);
    const promptDeadline = deadlines[0]!;
    expect(promptDeadline).not.toBe(staleDeadline);
    expect(promptDeadline).toBeGreaterThan(attestDoneTime + 100);
    expect(promptDeadline).toBeGreaterThanOrEqual(promptStart + 100 - 10);
    expect(promptDeadline).toBeLessThanOrEqual(promptStart + 100 + 50);
    rmSync(ws, { recursive: true, force: true });
  });

  it("proves remote execStream timeout covers pre-prompt wait plus full arm budget and cleanup", async () => {
    let capturedOptions: any;
    const baseRemote = remoteGuestForFrames();
    const remoteGuest: Guest = {
      ...baseRemote,
      execStream: async (options) => {
        capturedOptions = options;
        return baseRemote.execStream!(options);
      },
    };
    const request = createMockRequest({
      limits: { ...SAFE_DEFAULT_LIMITS, wallClockMs: 110_000 },
    });
    const harness = createPiHarness();
    await harness.attest(remoteGuest, request);
    expect(capturedOptions).toBeDefined();
    // Own/sibling setup and sibling capture, both serial allowances and cleanup.
    expect(capturedOptions.timeoutMs).toBe(1_240_000);
    expect(capturedOptions.timeoutMs).toBeGreaterThan(180_000);
  });

  it("keeps the full ten-minute serial child allowance inside remote stream lifetime", async () => {
    let streamTimeout: number | undefined;
    const baseRemote = remoteGuestForFrames();
    const remoteGuest: Guest = {
      ...baseRemote,
      execStream: async (options) => { streamTimeout = options.timeoutMs; return baseRemote.execStream!(options); },
    };
    await createPiHarness().attest(remoteGuest, createMockRequest({ limits: { ...SAFE_DEFAULT_LIMITS, wallClockMs: 600_000 } }));
    expect(streamTimeout).toBe(2_150_000);
    expect(streamTimeout).toBeGreaterThan(2 * 600_000);
  });

  it("clamps remote execStream timeout by request.deadlineAtMs when specified", async () => {
    let capturedOptions: any;
    const baseRemote = remoteGuestForFrames();
    const remoteGuest: Guest = {
      ...baseRemote,
      execStream: async (options) => {
        capturedOptions = options;
        return baseRemote.execStream!(options);
      },
    };
    const deadlineAtMs = Date.now() + 250_000;
    const request = createMockRequest({
      limits: { ...SAFE_DEFAULT_LIMITS, wallClockMs: 110_000 },
      deadlineAtMs,
    });
    const harness = createPiHarness();
    await harness.attest(remoteGuest, request);
    expect(capturedOptions).toBeDefined();
    expect(capturedOptions.timeoutMs).toBeLessThanOrEqual(250_000);
    expect(capturedOptions.timeoutMs).toBeGreaterThanOrEqual(240_000);
  });

  it.each([
    {
      name: "provider error",
      step: { type: "error", errorMessage: "Thinking level MINIMAL is not supported for this model (400 Bad Request)" },
      stopCause: "infrastructure-error",
      code: "provider-error",
      message: "Thinking level MINIMAL is not supported",
      providerStopReason: null,
      inspectable: false,
    },
    {
      name: "protocol drift",
      step: { type: "error", errorMessage: "protocol-drift: unrecognized event shape" },
      stopCause: "infrastructure-error",
      code: "protocol-drift",
      message: null,
      providerStopReason: null,
      inspectable: false,
    },
    {
      name: "unsolicited abort",
      step: { type: "text", text: "partial progress before unsolicited abort", stopReason: "aborted" },
      stopCause: "unexpected-abort",
      code: "protocol-drift",
      message: null,
      providerStopReason: "aborted",
      inspectable: true,
    },
    {
      name: "aborted response with arbitrary error",
      step: { type: "error", stopReason: "aborted", errorMessage: "upstream connection dropped: unexpected EOF" },
      stopCause: "infrastructure-error",
      code: "provider-error",
      message: "upstream connection dropped",
      providerStopReason: "aborted",
      inspectable: false,
    },
  ] as const)("classifies $name as infrastructure failure", async ({ name, step, stopCause, code, message, providerStopReason, inspectable }) => {
    const ws = makeTempDir(`pi-${name.replaceAll(" ", "-")}`);
    try {
      const harness = createPiHarness({ streamSimpleOverride: createScriptedStreamSimple([step]) });
      const result = await harness.run(createMockGuest(ws), createMockRequest());
      expect(result).toMatchObject({ outcome: "infrastructure-failure", stopCause });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({ code, failureClass: "infrastructure" });
      if (message !== null) expect(result.failures[0]?.message).toContain(message);
      if (providerStopReason !== null) expect(result.providerStopReason).toBe(providerStopReason);
      if (inspectable) {
        expect(result.nativeSessionEntries).toBeDefined();
        expect(result.messages.length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("preserves genuine provider error precedence over concurrent user cancellation in local harness", async () => {
    const ws = makeTempDir("pi-error-precedence");
    const guest = createMockGuest(ws);
    const controller = new AbortController();
    const request = createMockRequest({ signal: controller.signal });

    const streamSimpleOverride = () => {
      controller.abort("concurrent user abort");
      return createScriptedStreamSimple([
        {
          type: "error",
          stopReason: "error",
          errorMessage: "quota exceeded (429 Too Many Requests)",
        },
      ])({} as any, {} as any);
    };

    const harness = createPiHarness({ streamSimpleOverride: streamSimpleOverride as any });
    // Must NOT throw EvalError('interrupted'); provider error takes precedence
    const result = await harness.run(guest, request);
    expect(result.outcome).toBe("infrastructure-failure");
    expect(result.stopCause).toBe("infrastructure-error");
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]?.code).toBe("provider-error");
    rmSync(ws, { recursive: true, force: true });
  });

  it("preserves local user cancellation by throwing EvalError('interrupted')", async () => {
    const ws = makeTempDir("pi-user-cancellation");
    const guest = createMockGuest(ws);
    const controller = new AbortController();
    const request = createMockRequest({ signal: controller.signal });
    const streamSimpleOverride = () => {
      controller.abort("user cancelled the run");
      return createScriptedStreamSimple([
        { type: "error", stopReason: "aborted", errorMessage: "operation was aborted" },
      ])({} as any, {} as any);
    };

    const harness = createPiHarness({ streamSimpleOverride: streamSimpleOverride as any });
    await expect(harness.run(guest, request)).rejects.toMatchObject({
      name: "EvalError",
      code: "interrupted",
      message: expect.stringContaining("prompt cancelled"),
    });
    rmSync(ws, { recursive: true, force: true });
  });

  it("redacts verified guarded secret echo in native session entries and remains gradeable", async () => {
    const ws = makeTempDir("pi-secret-leak");
    const guest = createMockGuest(ws);
    const secretValue = "top-secret-api-key-987654";
    const request = createMockRequest({
      guardedSecrets: [{ label: "TEST_SECRET", value: secretValue }],
    });

    const streamSimpleOverride = createScriptedStreamSimple([
      {
        type: "text",
        text: `Echoing secret: ${secretValue}`,
      },
    ]);

    const harness = createPiHarness({ streamSimpleOverride });
    const result = await harness.run(guest, request);
    expect(result.outcome).toBe("completed");
    expect(result.nativeSessionEntries).toBeDefined();
    const serialized = JSON.stringify(result.nativeSessionEntries);
    expect(serialized).toContain("[REDACTED:TEST_SECRET]");
    expect(serialized).not.toContain(secretValue);
    rmSync(ws, { recursive: true, force: true });
  });

  it("strips thinking blocks from native session entries by default, and preserves them when captureReasoning is enabled", async () => {
    const ws1 = makeTempDir("pi-thinking-default");
    const guest1 = createMockGuest(ws1);
    const harness1 = createPiHarness({
      streamSimpleOverride: createScriptedStreamSimple([
        {
          type: "thinking",
          thinking: "internal chain of thought reasoning",
          text: "Public final response",
        },
      ]),
    });
    const resultDefault = await harness1.run(guest1, createMockRequest());
    expect(resultDefault.outcome).toBe("completed");
    expect(resultDefault.nativeSessionEntries).toBeDefined();
    const serializedDefault = JSON.stringify(resultDefault.nativeSessionEntries);
    expect(serializedDefault).toContain("Public final response");
    expect(serializedDefault).not.toContain("internal chain of thought reasoning");
    rmSync(ws1, { recursive: true, force: true });

    const ws2 = makeTempDir("pi-thinking-preserve");
    const guest2 = createMockGuest(ws2);
    const harness2 = createPiHarness({
      streamSimpleOverride: createScriptedStreamSimple([
        {
          type: "thinking",
          thinking: "internal chain of thought reasoning",
          text: "Public final response",
        },
      ]),
    });
    const resultPreserve = await harness2.run(guest2, createMockRequest({ captureReasoning: true }));
    expect(resultPreserve.outcome).toBe("completed");
    expect(resultPreserve.nativeSessionEntries).toBeDefined();
    const serializedPreserve = JSON.stringify(resultPreserve.nativeSessionEntries);
    expect(serializedPreserve).toContain("Public final response");
    expect(serializedPreserve).toContain("internal chain of thought reasoning");
    rmSync(ws2, { recursive: true, force: true });
  });

  it("honors cooperative cancellation via AbortSignal", async () => {
    const ws = makeTempDir("pi-abort");
    const guest = createMockGuest(ws);
    const controller = new AbortController();
    const request = createMockRequest({ signal: controller.signal });

    controller.abort(new Error("caller aborted"));
    const harness = createPiHarness({
      streamSimpleOverride: createScriptedStreamSimple([{ type: "text", text: "ok" }]),
    });

    await expect(harness.attest(guest, request)).rejects.toThrow(EvalError);
    rmSync(ws, { recursive: true, force: true });
  });

  it("accounts for token usage without duplicate counting or missing usage errors", async () => {
    const ws = makeTempDir("pi-token-acc");
    const guest = createMockGuest(ws);
    const request = createMockRequest();

    const streamSimpleOverride = createScriptedStreamSimple([
      {
        type: "text",
        text: "Response with tokens",
        usage: {
          input: 1000,
          output: 200,
          cacheRead: 300,
          cacheWrite: 100,
          totalTokens: 1600,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    ]);

    const harness = createPiHarness({ streamSimpleOverride });
    const result = await harness.run(guest, request);

    expect(result.outcome).toBe("completed");
    expect(result.usage.inputTokens).toBe(1000);
    expect(result.usage.outputTokens).toBe(200);
    expect(result.usage.cacheReadTokens).toBe(300);
    expect(result.usage.cacheWriteTokens).toBe(100);
    rmSync(ws, { recursive: true, force: true });
  });

  it("reports genuinely omitted usage as unavailable rather than zero", async () => {
    const ws = makeTempDir("pi-missing-usage");
    const result = await createPiHarness({
      streamSimpleOverride: createScriptedStreamSimple([{ type: "text", text: "no telemetry" }]),
    }).run(createMockGuest(ws), createMockRequest());

    expect(result.outcome).toBe("completed");
    expect(result.usage).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      providerRequests: 1,
    });
    const assistantEntry = (result.nativeSessionEntries as any[]).find(
      (entry) => entry.type === "message" && entry.message?.role === "assistant",
    );
    expect(assistantEntry.message).not.toHaveProperty("usage");
    rmSync(ws, { recursive: true, force: true });
  });

  it("keeps provider failure precedence over an observed output-budget overrun", async () => {
    const ws = makeTempDir("pi-provider-budget-precedence");
    const usage = {
      input: 1, output: 11, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const result = await createPiHarness({
      streamSimpleOverride: createScriptedStreamSimple([
        { type: "text", text: "failed", stopReason: "error", usage },
      ]),
    }).run(
      createMockGuest(ws),
      createMockRequest({ limits: { ...SAFE_DEFAULT_LIMITS, maxOutputTokens: 10 } }),
    );

    expect(result.usage.outputTokens).toBe(11);
    expect(result.outcome).toBe("infrastructure-failure");
    expect(result.failures[0]?.code).toBe("provider-error");
    rmSync(ws, { recursive: true, force: true });
  });

  it("rejects adapter faults outside scripted test composition", () => {
    expect(() => {
      createPiHarness({
        faults: { simulateNativeSanitizerFailure: true },
      });
    }).toThrow(EvalError);

    try {
      createPiHarness({
        faults: { simulateNativeSanitizerFailure: true },
      });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("parity-violation");
      expect(err.message).toContain("adapter faults are rejected outside scripted test composition");
    }
  });

  it("forces test-double flag when faults are configured with scripted stream", () => {
    const harness = createPiHarness({
      streamSimpleOverride: createScriptedStreamSimple([{ type: "text", text: "ok" }]),
      faults: { simulateNativeSanitizerFailure: true },
    });
    expect(harness.testDouble).toBe(true);
  });

  it("rejects adapter session callbacks outside scripted test composition", () => {
    expect(() => {
      createPiHarness({
        onSessionCreated: () => {},
      });
    }).toThrow(EvalError);

    try {
      createPiHarness({
        onSessionCreated: () => {},
      });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("parity-violation");
      expect(err.message).toContain("adapter session callbacks are rejected outside scripted test composition");
    }
  });

  it("accepts adapter session callbacks with scripted stream and sets testDouble", () => {
    const harness = createPiHarness({
      streamSimpleOverride: createScriptedStreamSimple([{ type: "text", text: "ok" }]),
      onSessionCreated: () => {},
    });
    expect(harness.testDouble).toBe(true);
  });

  describe("shared client attestation", () => {
    it.each([
      ["missing client", (a: any) => { a.activeTools.pop(); }],
      ["different client", (a: any) => { a.mcpClientId = "unknown-client"; }],
      ["extra tool", (a: any) => { a.activeTools.push("ask_docs"); }],
      ["reordered native tools", (a: any) => { a.activeTools.reverse(); }],
      ["baseline seed", (a: any) => { a.seededMcpServers = ["docs"]; }],
      ["baseline bundle", (a: any) => { a.skillToolBundleSha256 = "00".repeat(32); }],
    ] as const)("refuses %s", async (_label, mutate) => {
      const harness = createPiHarness();
      const guest = remoteGuestForFrames((type, frame) => {
        if (type === "ready") mutate(frame.attestation);
        return frame;
      });
      await expect(harness.attest(guest, createMockRequest())).rejects.toMatchObject({ code: "parity-violation" });
    });

    it.each([
      ["missing required seed", (a: any) => { a.seededMcpServers = []; }],
      ["unexpected seed", (a: any) => { a.seededMcpServers = ["different"]; }],
      ["wrong seed digest", (a: any) => { a.skillToolBundleSha256 = "11".repeat(32); }],
    ] as const)("refuses treatment with %s", async (_label, mutate) => {
      const harness = createPiHarness();
      const guest = remoteGuestForFrames((type, frame) => {
        if (type === "ready") {
          frame.attestation.arm = "treatment";
          frame.attestation.loadedSkills = [{ name: "test-skill", path: "/workspace/SKILL.md" }];
          frame.attestation.seededMcpServers = ["docs"];
          frame.attestation.skillToolBundleSha256 = "00".repeat(32);
          mutate(frame.attestation);
        }
        return frame;
      });
      await expect(harness.attest(guest, createMockRequest({
        conditionId: "treatment", skillPaths: ["/workspace"], skillToolBundleSha256: "00".repeat(32),
        skillToolBundle: { ...EMPTY_SKILL_TOOL_BUNDLE, servers: [{ name: "docs", transport: "streamable_http", url: "https://example.com", description: null }] },
      }))).rejects.toMatchObject({ code: "parity-violation" });
    });
  });
});
