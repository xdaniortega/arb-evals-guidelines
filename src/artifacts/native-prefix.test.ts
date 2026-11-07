import {
  appendFileSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { fork, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSdkSession } from "../harnesses/pi/sdk-session.ts";
import {
  createNativeSessionCapture,
  NATIVE_PREFIX_MAX_RECORD_BYTES,
  NATIVE_PREFIX_MAX_RECORDS,
  NATIVE_PREFIX_MAX_TOTAL_BYTES,
  readNativeSessionPrefix,
} from "./native-prefix.ts";

const roots: string[] = [];
function tempRoot(name: string): string {
  const root = join(tmpdir(), `${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  roots.push(root);
  return root;
}
function header(id = "session-actual") {
  return { type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00.000Z", cwd: "/work" };
}
function envelope(sequence: number, record: unknown): string {
  return JSON.stringify({ schemaVersion: 2, kind: "record", sequence, record, redactions: { count: 0, entries: [] } });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bounded durable native prefixes", () => {
  it("captures exact entries from every pinned public ID-returning SessionManager append API", async () => {
    const root = tempRoot("native-public-apis");
    const capture = createNativeSessionCapture({ path: join(root, "prefix.jsonl") });
    const instance = await createPiSdkSession({
      cwd: root,
      arm: "baseline",
      target: { provider: "google", model: "gemini-3.8-flash", thinking: "low" },
      streamSimpleOverride: () => { throw new Error("completion must not be dispatched"); },
      nativeSessionRecorder: capture,
    });
    const manager = instance.session.sessionManager;
    const ids = [
      manager.appendMessage({ role: "user", content: "public APIs", timestamp: 1 } as any),
      manager.appendThinkingLevelChange("low"),
      manager.appendModelChange("google", "gemini-3.8-flash"),
      manager.appendCompaction("summary", manager.getEntries()[0]!.id, 10),
      manager.appendCustomEntry("test", { safe: true }),
      manager.appendSessionInfo("session name"),
      manager.appendCustomMessageEntry("test", "custom message", false),
    ];
    // appendUsage is the one pinned append that returns the entry instead of its ID.
    ids.push(manager.appendUsage("cache_warm", "google", "gemini-3.8-flash", {
      input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } as any).id);
    ids.push(manager.appendContextEdit(ids[0]!, null));
    ids.push(manager.appendLabelChange(ids[0]!, "root"));
    ids.push(manager.branchWithSummary(ids[0]!, "branch summary"));
    const actualHeader = structuredClone(manager.getHeader());
    const actualEntries = structuredClone(manager.getEntries());
    instance.dispose();
    const snapshot = capture.finish(true, null);

    expect(snapshot.entries[0]).toEqual(actualHeader);
    expect(snapshot.entries.slice(1)).toEqual(actualEntries);
    expect(snapshot.entries.slice(1).map((entry) => entry.id).slice(-ids.length)).toEqual(ids);
  });

  it("persists guest redaction occurrence metadata in the same durable record prefix", () => {
    const path = join(tempRoot("native-guest-redactions"), "prefix.jsonl");
    const capture = createNativeSessionCapture({ path });
    capture.record(header(), {
      count: 3,
      entries: [
        { path: "guest:one", label: "TOKEN", encoding: "raw", count: 2 },
        { path: "guest:two", label: "TOKEN", encoding: "base64", count: 1 },
      ],
    });
    const snapshot = capture.finish(false, "interrupted after durable prefix");
    expect(snapshot.redactions.count).toBe(3);
    expect(snapshot.redactions.entries.map((entry) => entry.count)).toEqual([2, 1]);
    expect(snapshot.completed).toBe(false);
  });

  it("redacts copies, strips reasoning by default, keeps exact IDs/header/order, and returns immutable read snapshots", () => {
    const path = join(tempRoot("native-prefix"), "prefix.jsonl");
    const secret = "prefix-secret-value";
    const capture = createNativeSessionCapture({ path, guardedSecrets: [{ label: "TOKEN", value: secret }] });
    const actualHeader = header();
    const actualMessage = {
      type: "message", id: "msg-actual", parentId: null, timestamp: "2025-01-01T00:00:01.000Z",
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "private chain", thinkingSignature: "signature" },
        { type: "text", text: secret },
      ] },
    };
    capture.record(actualHeader);
    capture.record(actualMessage);
    const snapshot = capture.finish(true, null);

    expect(snapshot.finished).toBe(true);
    expect(snapshot.completed).toBe(true);
    expect(snapshot.entries.map((entry) => entry.id)).toEqual(["session-actual", "msg-actual"]);
    expect(JSON.stringify(snapshot.entries)).not.toContain(secret);
    // By default, reasoning and thinking blocks are stripped from captured native session entries
    expect(JSON.stringify(snapshot.entries)).not.toContain("private chain");
    expect(JSON.stringify(snapshot.entries)).not.toContain("signature");
    expect(JSON.stringify(actualMessage)).toContain(secret);
    (snapshot.entries[1] as any).id = "mutated-view";
    expect(readNativeSessionPrefix(path).entries[1]!.id).toBe("msg-actual");
  });

  it("strips reasoning and secrets from context_edit replacement content", () => {
    const path = join(tempRoot("native-context-edit"), "prefix.jsonl");
    const secret = "context-edit-secret-value";
    const capture = createNativeSessionCapture({ path, guardedSecrets: [{ label: "TOKEN", value: secret }] });
    capture.record(header());
    capture.record({ type: "message", id: "msg-1", parentId: null, timestamp: "2025-01-01T00:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "original" }] } });
    capture.record({ type: "context_edit", id: "edit-1", parentId: "msg-1", timestamp: "2025-01-01T00:00:02.000Z",
      targetId: "msg-1", replacement: { content: [
        { type: "thinking", thinking: "edited private chain", thinkingSignature: "edit-signature" },
        { type: "text", text: secret },
      ] } });
    const snapshot = capture.finish(true, null);

    expect(snapshot.entries.map((entry) => entry.type)).toEqual(["session", "message", "context_edit"]);
    const serialized = JSON.stringify(snapshot.entries);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("edited private chain");
    expect(serialized).not.toContain("edit-signature");
  });

  it("preserves reasoning and signatures when captureReasoning is enabled", () => {
    const path = join(tempRoot("native-prefix-reasoning"), "prefix.jsonl");
    const secret = "prefix-secret-value";
    const capture = createNativeSessionCapture({
      path,
      guardedSecrets: [{ label: "TOKEN", value: secret }],
      captureReasoning: true,
    });
    const actualHeader = header();
    const actualMessage = {
      type: "message", id: "msg-actual", parentId: null, timestamp: "2025-01-01T00:00:01.000Z",
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "private chain", thinkingSignature: "signature" },
        { type: "text", text: secret },
      ] },
    };
    capture.record(actualHeader);
    capture.record(actualMessage);
    const snapshot = capture.finish(true, null);

    expect(snapshot.finished).toBe(true);
    expect(snapshot.completed).toBe(true);
    expect(JSON.stringify(snapshot.entries)).not.toContain(secret);
    expect(JSON.stringify(snapshot.entries)).toContain("private chain");
    expect(JSON.stringify(snapshot.entries)).toContain("signature");
  });

  it("omits an unfinished record but rejects torn content after a finish marker", () => {
    const root = tempRoot("native-torn");
    const interruptedPath = join(root, "interrupted.jsonl");
    const interrupted = createNativeSessionCapture({ path: interruptedPath });
    interrupted.record(header());
    appendFileSync(interruptedPath, '{"schemaVersion":2,"kind":"record"');
    const snapshot = readNativeSessionPrefix(interruptedPath);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.finished).toBe(false);
    expect(snapshot.completed).toBe(false);
    expect(snapshot.incompleteReason).toContain("interrupted");

    const finishedPath = join(root, "finished.jsonl");
    const finished = createNativeSessionCapture({ path: finishedPath });
    finished.record(header("finished"));
    finished.finish(true, null);
    appendFileSync(finishedPath, '{"schemaVersion":2');
    expect(() => readNativeSessionPrefix(finishedPath)).toThrow(/torn content after its finish marker/);
  });

  it("opens a leaf once and rejects symlinks, non-regular files, and extra hard links", () => {
    const root = tempRoot("native-file-kind");
    const target = join(root, "target.jsonl");
    writeFileSync(target, `${envelope(1, header())}\n`);
    const symlink = join(root, "symlink.jsonl");
    symlinkSync(target, symlink);
    expect(() => readNativeSessionPrefix(symlink)).toThrow(/not readable/);
    expect(() => readNativeSessionPrefix(root)).toThrow(/singly-linked regular file/);
    const fifo = join(root, "fifo.jsonl");
    const madeFifo = spawnSync("mkfifo", [fifo]);
    if (madeFifo.status === 0) {
      expect(() => readNativeSessionPrefix(fifo)).toThrow(/singly-linked regular file/);
    }
    const alias = join(root, "alias.jsonl");
    linkSync(target, alias);
    expect(() => readNativeSessionPrefix(target)).toThrow(/singly-linked regular file/);
  });

  it("reads one coherent bounded file while the pathname is atomically replaced and grows", async () => {
    const root = tempRoot("native-replacement");
    const path = join(root, "prefix.jsonl");
    const first = `${envelope(1, header("version-a"))}\n`;
    const second = `${envelope(1, header("version-b"))}\n${"x".repeat(256 * 1024)}`;
    writeFileSync(path, first);
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const { renameSync, writeFileSync } = require("node:fs");
      for (let i = 0; i < 80; i += 1) {
        const temp = workerData.path + "." + i;
        writeFileSync(temp, i % 2 === 0 ? workerData.first : workerData.second);
        renameSync(temp, workerData.path);
      }
      parentPort.postMessage("done");
    `, { eval: true, workerData: { path, first, second } });
    const observed = new Set<string>();
    for (let i = 0; i < 160; i += 1) {
      const snapshot = readNativeSessionPrefix(path);
      expect(snapshot.entries).toHaveLength(1);
      observed.add(snapshot.entries[0]!.id!);
    }
    await new Promise<void>((resolve, reject) => {
      worker.once("message", () => resolve());
      worker.once("error", reject);
    });
    expect([...observed].every((id) => id === "version-a" || id === "version-b")).toBe(true);
  });

  it("sanitizes finish metadata and verifies raw and commonly encoded canaries before writing", () => {
    const root = tempRoot("native-finish-secret");
    const secret = "finish-secret-canary-24680";
    const encoded = Buffer.from(secret, "utf8").toString("base64");
    for (const [name, reason] of [["raw", secret], ["encoded", encoded]] as const) {
      const path = join(root, `${name}.jsonl`);
      const capture = createNativeSessionCapture({ path, guardedSecrets: [{ label: "FINISH_KEY", value: secret }] });
      capture.record(header(name));
      const snapshot = capture.finish(false, `failure metadata ${reason}`);
      expect(snapshot.finished).toBe(true);
      expect(snapshot.completed).toBe(false);
      const serialized = readFileSync(path, "utf8");
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(encoded);
      expect(snapshot.incompleteReason).toContain("[REDACTED:FINISH_KEY]");
    }
  });

  it("fails closed for malformed, per-record, count, and total bounds", () => {
    const root = tempRoot("native-bounds");
    const malformed = join(root, "malformed.jsonl");
    writeFileSync(malformed, `${envelope(1, header())}\n{not-json}\n`);
    expect(() => readNativeSessionPrefix(malformed)).toThrow(/malformed JSON/);

    const oversizedRecord = join(root, "record.jsonl");
    writeFileSync(oversizedRecord, `${"x".repeat(NATIVE_PREFIX_MAX_RECORD_BYTES)}\n`);
    expect(() => readNativeSessionPrefix(oversizedRecord)).toThrow(/record bound/);

    const countPath = join(root, "count.jsonl");
    const lines = [envelope(1, header("h"))];
    let parent: string | null = null;
    for (let i = 1; i <= NATIVE_PREFIX_MAX_RECORDS; i += 1) {
      const id = `m${i}`;
      lines.push(envelope(i + 1, { type: "message", id, parentId: parent, message: { role: "user", content: "x" } }));
      parent = id;
    }
    writeFileSync(countPath, `${lines.join("\n")}\n`);
    expect(() => readNativeSessionPrefix(countPath)).toThrow(/exceeds 10000 records/);

    const totalPath = join(root, "total.jsonl");
    writeFileSync(totalPath, Buffer.alloc(NATIVE_PREFIX_MAX_TOTAL_BYTES + 1, 0x20));
    expect(() => readNativeSessionPrefix(totalPath)).toThrow(/exceeds 16777216 bytes/);
  });

  it("latches a capture bound failure, closes its descriptor, retains scratch, and drops every later entry", () => {
    const root = tempRoot("native-latch");
    const descriptorProbe = openSync(join(root, "probe"), "w");
    closeSync(descriptorProbe);
    const path = join(root, "prefix.jsonl");
    const capture = createNativeSessionCapture({ path });
    capture.record(header());
    expect(() => capture.record({
      type: "message", id: "too-large", parentId: null,
      message: { role: "assistant", content: "x".repeat(NATIVE_PREFIX_MAX_RECORD_BYTES) },
    })).toThrow(/record exceeds/);
    expect(() => capture.record({
      type: "message", id: "must-drop", parentId: null, message: { role: "assistant", content: "small" },
    })).toThrow(/record exceeds/);
    expect(capture.snapshot().entries.map((entry) => entry.id)).toEqual(["session-actual"]);
    expect(existsSync(path)).toBe(true);
    const reused = openSync(join(root, "after-append-failure"), "w");
    expect(reused).toBe(descriptorProbe);
    closeSync(reused);
  });

  it("closes independently and retains the last fsynced bytes when finish append fails", () => {
    const root = tempRoot("native-finish-latch");
    const descriptorProbe = openSync(join(root, "probe"), "w");
    closeSync(descriptorProbe);
    const path = join(root, "prefix.jsonl");
    const capture = createNativeSessionCapture({ path });
    capture.record(header());
    expect(() => capture.finish(false, "x".repeat(NATIVE_PREFIX_MAX_RECORD_BYTES))).toThrow(/record exceeds/);
    expect(existsSync(path)).toBe(true);
    expect(readNativeSessionPrefix(path).entries.map((entry) => entry.id)).toEqual(["session-actual"]);
    const reused = openSync(join(root, "after-finish-failure"), "w");
    expect(reused).toBe(descriptorProbe);
    closeSync(reused);
  });

  it("survives SIGKILL after a real SDK tool result is fsynced, without inventing a tail", async () => {
    const root = tempRoot("native-crash");
    const workspace = join(root, "workspace");
    const prefix = join(root, "prefix.jsonl");
    mkdirSync(workspace);
    const childPath = fileURLToPath(new URL("./native-prefix-crash-child.ts", import.meta.url));
    const child = fork(childPath, [workspace, prefix], {
      execArgv: ["--experimental-strip-types"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        TMPDIR: root,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
    });
    let stderr = "";
    child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`child marker timeout: ${stderr}`)), 10_000);
        child.once("message", (message) => {
          if ((message as any)?.type !== "prefix-fsynced") return;
          clearTimeout(timer);
          resolve();
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          reject(new Error(`child exited before marker code=${code} signal=${signal}: ${stderr}`));
        });
      });
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));

      const snapshot = readNativeSessionPrefix(prefix);
      expect(snapshot.finished).toBe(false);
      expect(snapshot.completed).toBe(false);
      expect(snapshot.entries[0]!.type).toBe("session");
      const nativeIds = snapshot.entries.slice(1).map((entry) => entry.id);
      expect(new Set(nativeIds).size).toBe(nativeIds.length);
      const ids = new Set(nativeIds);
      for (const entry of snapshot.entries.slice(1)) {
        expect(entry.parentId === null || ids.has(entry.parentId!)).toBe(true);
      }
      const serialized = JSON.stringify(snapshot.entries);
      expect(serialized).toContain("crash_write_1");
      expect(serialized).toContain("toolResult");
      expect(serialized).not.toContain("native-prefix-crash-canary");
      // system (Pi 1.x leading system prompt), user, assistant tool call, tool result
      expect(snapshot.entries.filter((entry) => entry.type === "message")).toHaveLength(4);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 15_000);
});
