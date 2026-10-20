/**
 * @notice Verifies tests block paid provider transport, real credentials, and unsafe socket or network access.
 */

import { createServer } from "node:net";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RealCompletionTransportBlockedError,
  SocketFixtureError,
  TEST_GUARDS_PRELOAD_FLAG,
  buildAllowlistedEnv,
  startSocketServer,
} from "./test-guards.ts";
import { loadGuardedCredentials } from "./runner/credentials.ts";

function createSafetyPreload(tempDir: string): { preloadPath: string; preloadUrl: string } {
  const preloadPath = join(tempDir, "independent-safety-preload.mjs");
  const preloadContent = `
import dns from "node:dns";
import net from "node:net";
import http from "node:http";
import https from "node:https";

globalThis.__safetyCounters = {
  dnsCalls: 0,
  socketConnectCalls: 0,
  fetchCalls: 0,
  httpCalls: 0,
};

// 1. Failclosed DNS
const origDnsLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  globalThis.__safetyCounters.dnsCalls++;
  const cb = typeof options === "function" ? options : callback;
  const err = new Error("FAILCLOSED_SAFETY_NET: Outbound DNS resolution attempted for: " + hostname);
  err.code = "ENOTFOUND";
  process.nextTick(() => cb(err));
};
if (dns.promises?.lookup) {
  dns.promises.lookup = async (hostname) => {
    globalThis.__safetyCounters.dnsCalls++;
    const err = new Error("FAILCLOSED_SAFETY_NET: Outbound DNS resolution attempted for: " + hostname);
    err.code = "ENOTFOUND";
    throw err;
  };
}

// 2. Failclosed Socket Connect
const origSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function failClosedDenyConnect(...args) {
  globalThis.__safetyCounters.socketConnectCalls++;
  let host = "unknown";
  const first = args[0];
  if (Array.isArray(first)) {
    const opts = first[0];
    if (typeof opts === "object" && opts !== null) {
      host = opts.host ?? opts.hostname ?? "unknown";
    }
  } else if (typeof first === "object" && first !== null) {
    host = first.host ?? first.hostname ?? "unknown";
  } else if (typeof args[1] === "string") {
    host = args[1];
  }
  const err = new Error("FAILCLOSED_SAFETY_NET: Outbound socket connection attempted for: " + host);
  err.code = "ECONNREFUSED";
  process.nextTick(() => {
    this.destroy(err);
  });
  return this;
};

// 3. Failclosed global fetch
const origFetch = globalThis.fetch;
globalThis.fetch = async function failClosedDenyFetch(input, init) {
  globalThis.__safetyCounters.fetchCalls++;
  const target = typeof input === "string" ? input : (input?.url || input?.href || String(input));
  throw new Error("FAILCLOSED_SAFETY_NET: Outbound fetch attempted for: " + target);
};

// 4. Failclosed HTTP(S) request and get
const origHttpRequest = http.request;
http.request = function failClosedHttpRequest(...args) {
  globalThis.__safetyCounters.httpCalls++;
  const target = typeof args[0] === "string" || args[0] instanceof URL ? args[0].toString() : (args[0]?.host || args[0]?.hostname || "unknown");
  throw new Error("FAILCLOSED_SAFETY_NET: Outbound http.request attempted for: " + target);
};

const origHttpGet = http.get;
http.get = function failClosedHttpGet(...args) {
  globalThis.__safetyCounters.httpCalls++;
  const target = typeof args[0] === "string" || args[0] instanceof URL ? args[0].toString() : (args[0]?.host || args[0]?.hostname || "unknown");
  throw new Error("FAILCLOSED_SAFETY_NET: Outbound http.get attempted for: " + target);
};

const origHttpsRequest = https.request;
https.request = function failClosedHttpsRequest(...args) {
  globalThis.__safetyCounters.httpCalls++;
  const target = typeof args[0] === "string" || args[0] instanceof URL ? args[0].toString() : (args[0]?.host || args[0]?.hostname || "unknown");
  throw new Error("FAILCLOSED_SAFETY_NET: Outbound https.request attempted for: " + target);
};

const origHttpsGet = https.get;
https.get = function failClosedHttpsGet(...args) {
  globalThis.__safetyCounters.httpCalls++;
  const target = typeof args[0] === "string" || args[0] instanceof URL ? args[0].toString() : (args[0]?.host || args[0]?.hostname || "unknown");
  throw new Error("FAILCLOSED_SAFETY_NET: Outbound https.get attempted for: " + target);
};
`;
  writeFileSync(preloadPath, preloadContent, "utf8");
  return {
    preloadPath,
    preloadUrl: new URL(`file://${preloadPath}`).href,
  };
}

describe("zero-paid-call test guards", () => {
  it("blocks globalThis.fetch to Google Gemini completion endpoints before networking", async () => {
    await expect(
      fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent"),
    ).rejects.toThrow(RealCompletionTransportBlockedError);
  });

  it("blocks globalThis.fetch to Anthropic completion endpoints before networking", async () => {
    await expect(
      fetch("https://api.anthropic.com/v1/messages"),
    ).rejects.toThrow(RealCompletionTransportBlockedError);
  });

  it("blocks globalThis.fetch to OpenAI completion endpoints before networking", async () => {
    await expect(
      fetch("https://api.openai.com/v1/chat/completions"),
    ).rejects.toThrow(RealCompletionTransportBlockedError);
  });

  it("blocks http.request and https.request to provider endpoints before networking", () => {
    expect(() => {
      https.request("https://generativelanguage.googleapis.com/test");
    }).toThrow(RealCompletionTransportBlockedError);

    expect(() => {
      https.request("https://api.anthropic.com/test");
    }).toThrow(RealCompletionTransportBlockedError);

    expect(() => {
      http.request("http://api.openai.com/test");
    }).toThrow(RealCompletionTransportBlockedError);

    expect(() => {
      https.get("https://generativelanguage.googleapis.com/test");
    }).toThrow(RealCompletionTransportBlockedError);

    expect(() => {
      http.get("http://api.openai.com/test");
    }).toThrow(RealCompletionTransportBlockedError);
  });

  it("blocks net.connect to provider endpoints with options object or (port, host)", async () => {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const sock = net.connect({ host: "generativelanguage.googleapis.com", port: 443 });
      sock.on("error", (err) => {
        try {
          expect(err).toBeInstanceOf(RealCompletionTransportBlockedError);
          expect((err as RealCompletionTransportBlockedError).host).toBe("generativelanguage.googleapis.com");
          resolvePromise();
        } catch (e) {
          rejectPromise(e);
        }
      });
      sock.on("connect", () => {
        rejectPromise(new Error("Socket should NOT have connected to blocked provider host"));
      });
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const sock = net.connect(443, "api.anthropic.com");
      sock.on("error", (err) => {
        try {
          expect(err).toBeInstanceOf(RealCompletionTransportBlockedError);
          expect((err as RealCompletionTransportBlockedError).host).toBe("api.anthropic.com");
          resolvePromise();
        } catch (e) {
          rejectPromise(e);
        }
      });
      sock.on("connect", () => {
        rejectPromise(new Error("Socket should NOT have connected to blocked provider host"));
      });
    });
  });

  it("forbids loading the real evals/.env file during tests", async () => {
    const repoRoot = process.cwd();
    const realEnvPath = resolve(repoRoot, "evals", ".env");
    await expect(loadGuardedCredentials(realEnvPath, repoRoot)).rejects.toThrow(
      /Tests must NEVER load the real evals\/\.env file/,
    );
  });

  it("scrubs sensitive keys from test process environment", () => {
    expect(process.env.GEMINI_API_KEY).toBeUndefined();
    expect(process.env.GOOGLE_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("builds allowlisted environment for child processes without credentials and includes preload blocker", () => {
    const fakeDir = "/tmp/fake-test-dir";
    const env = buildAllowlistedEnv(fakeDir, { EXTRA_VAR: "value" });
    expect(env.HOME).toBe(fakeDir);
    expect(env.TMPDIR).toBe(fakeDir);
    expect(env.PATH).toBeDefined();
    expect(env.EXTRA_VAR).toBe("value");
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.EVAL_TEST_GUARD).toBe("1");
    expect(env.NODE_OPTIONS).toContain(TEST_GUARDS_PRELOAD_FLAG);
  });

  it("proves test subprocesses automatically preload blocker and fail forbidden transport before networking with independent safety net", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "subproc-guard-regression-"));
    const childScriptPath = join(tempDir, "child-regression.mjs");
    const negChildScriptPath = join(tempDir, "child-negative.mjs");

    try {
      const { preloadUrl: safetyPreloadUrl } = createSafetyPreload(tempDir);

      // Child script executes in a distinct Node subprocess with only buildAllowlistedEnv.
      // Notice: NO imports of test-guards.ts or safety-preload.mjs!
      // The independent failclosed safety net was preloaded BEFORE test-guards.
      // The preloaded test guard must reject before any network dispatch or safety net fallback occurs.
      const childScript = `
import http from "node:http";
import https from "node:https";
import net from "node:net";

async function main() {
  const verified = {
    fetchBlockedBeforeSocket: false,
    httpsRequestBlockedBeforeSocket: false,
    httpGetBlockedBeforeSocket: false,
    netOptionsBlocked: false,
    netArgsBlocked: false,
    finalDnsCalls: -1,
    finalSocketConnectCalls: -1,
    finalFetchCalls: -1,
    finalHttpCalls: -1,
  };


  try {
    await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=AIzaSy-SYNTHETIC-KEY", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "ping" }] }] }),
    });
    throw new Error("Synthetic fetch was NOT blocked!");
  } catch (err) {
    if (err.name === "RealCompletionTransportBlockedError" && err.host === "generativelanguage.googleapis.com") {
      verified.fetchBlockedBeforeSocket = true;
    } else {
      throw err;
    }
  }


  try {
    https.request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "synthetic-anthropic-key" },
    });
    throw new Error("Synthetic https.request was NOT blocked!");
  } catch (err) {
    if (err.name === "RealCompletionTransportBlockedError" && err.host === "api.anthropic.com") {
      verified.httpsRequestBlockedBeforeSocket = true;
    } else {
      throw err;
    }
  }


  try {
    http.get("http://api.openai.com/v1/chat/completions");
    throw new Error("Synthetic http.get was NOT blocked!");
  } catch (err) {
    if (err.name === "RealCompletionTransportBlockedError" && err.host === "api.openai.com") {
      verified.httpGetBlockedBeforeSocket = true;
    } else {
      throw err;
    }
  }


  await new Promise((resolve, reject) => {
    const sock = net.connect({ host: "generativelanguage.googleapis.com", port: 443 });
    sock.on("error", (err) => {
      if (err.name === "RealCompletionTransportBlockedError" && err.host === "generativelanguage.googleapis.com") {
        verified.netOptionsBlocked = true;
        resolve();
      } else {
        reject(err);
      }
    });
    sock.on("connect", () => {
      reject(new Error("net.connect unexpectedly connected!"));
    });
  });


  await new Promise((resolve, reject) => {
    const sock = net.connect(443, "api.anthropic.com");
    sock.on("error", (err) => {
      if (err.name === "RealCompletionTransportBlockedError" && err.host === "api.anthropic.com") {
        verified.netArgsBlocked = true;
        resolve();
      } else {
        reject(err);
      }
    });
    sock.on("connect", () => {
      reject(new Error("net.connect unexpectedly connected!"));
    });
  });


  const counters = globalThis.__safetyCounters || {};
  verified.finalDnsCalls = counters.dnsCalls ?? -1;
  verified.finalSocketConnectCalls = counters.socketConnectCalls ?? -1;
  verified.finalFetchCalls = counters.fetchCalls ?? -1;
  verified.finalHttpCalls = counters.httpCalls ?? -1;

  if (
    verified.fetchBlockedBeforeSocket &&
    verified.httpsRequestBlockedBeforeSocket &&
    verified.httpGetBlockedBeforeSocket &&
    verified.netOptionsBlocked &&
    verified.netArgsBlocked &&
    verified.finalDnsCalls === 0 &&
    verified.finalSocketConnectCalls === 0 &&
    verified.finalFetchCalls === 0 &&
    verified.finalHttpCalls === 0
  ) {
    process.stdout.write(JSON.stringify(verified));
    process.exit(0);
  } else {
    process.stderr.write("Verification failed: " + JSON.stringify(verified));
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write("Unhandled child exception: " + String(err?.stack || err));
  process.exit(2);
});
`;
      writeFileSync(childScriptPath, childScript, "utf8");

      // Spawn child process with safety preload prepended in NODE_OPTIONS
      const res = spawnSync(process.execPath, [childScriptPath], {
        cwd: tempDir,
        env: buildAllowlistedEnv(tempDir, {
          NODE_OPTIONS: `--import ${safetyPreloadUrl}`,
        }),
        encoding: "utf8",
        timeout: 15_000,
      });

      expect(res.status).toBe(0);
      expect(res.stderr).toBe("");
      const result = JSON.parse(res.stdout);
      expect(result.fetchBlockedBeforeSocket).toBe(true);
      expect(result.httpsRequestBlockedBeforeSocket).toBe(true);
      expect(result.httpGetBlockedBeforeSocket).toBe(true);
      expect(result.netOptionsBlocked).toBe(true);
      expect(result.netArgsBlocked).toBe(true);
      expect(result.finalDnsCalls).toBe(0);
      expect(result.finalSocketConnectCalls).toBe(0);
      expect(result.finalFetchCalls).toBe(0);
      expect(result.finalHttpCalls).toBe(0);

      // Negative control: deliberate required guard preload omission.
      // Demonstrates that absence of test-guards does NOT result in real networking;
      // instead, the independent failclosed safety net catches the probe and fails safely.
      const negChildScript = `
import net from "node:net";

async function main() {
  const outcome = {
    fetchBlockedBySafetyNet: false,
    socketBlockedBySafetyNet: false,
    guardErrorSeen: false,
    safetyCounters: null,
  };

  try {
    await fetch("https://generativelanguage.googleapis.com/test");
  } catch (err) {
    if (err?.name === "RealCompletionTransportBlockedError") {
      outcome.guardErrorSeen = true;
    } else if (String(err?.message).includes("FAILCLOSED_SAFETY_NET")) {
      outcome.fetchBlockedBySafetyNet = true;
    }
  }

  await new Promise((resolve) => {
    const sock = net.connect({ host: "generativelanguage.googleapis.com", port: 443 });
    sock.on("error", (err) => {
      if (err?.name === "RealCompletionTransportBlockedError") {
        outcome.guardErrorSeen = true;
      } else if (String(err?.message).includes("FAILCLOSED_SAFETY_NET")) {
        outcome.socketBlockedBySafetyNet = true;
      }
      resolve();
    });
    sock.on("connect", () => {
      resolve();
    });
  });

  outcome.safetyCounters = globalThis.__safetyCounters;
  process.stdout.write(JSON.stringify(outcome));
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(String(err?.stack || err));
  process.exit(2);
});
`;
      writeFileSync(negChildScriptPath, negChildScript, "utf8");

      const negEnv = {
        ...buildAllowlistedEnv(tempDir),
        NODE_OPTIONS: `--import ${safetyPreloadUrl}`,
        EVAL_TEST_GUARD: undefined,
      };

      const negRes = spawnSync(process.execPath, [negChildScriptPath], {
        cwd: tempDir,
        env: negEnv,
        encoding: "utf8",
        timeout: 15_000,
      });

      expect(negRes.status).toBe(0);
      const negResult = JSON.parse(negRes.stdout);
      expect(negResult.guardErrorSeen).toBe(false);
      expect(negResult.fetchBlockedBySafetyNet).toBe(true);
      expect(negResult.socketBlockedBySafetyNet).toBe(true);
      expect(negResult.safetyCounters.fetchCalls).toBe(1);
      expect(negResult.safetyCounters.socketConnectCalls).toBe(1);
      expect(negResult.safetyCounters.dnsCalls).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("enforces non-overridable EVAL_TEST_GUARD and ensures activation under production overrides", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guard-overrides-regression-"));
    const childScriptPath = join(tempDir, "child-overrides.mjs");

    try {
      const { preloadUrl: safetyPreloadUrl } = createSafetyPreload(tempDir);

      // 1. Calling buildAllowlistedEnv with production / clearing overrides cannot disable EVAL_TEST_GUARD
      const overriddenEnv = buildAllowlistedEnv(tempDir, {
        NODE_ENV: "production",
        VITEST: undefined,
        EVAL_TEST_GUARD: undefined,
        NODE_OPTIONS: `--import ${safetyPreloadUrl}`,
      });
      expect(overriddenEnv.NODE_ENV).toBe("production");
      expect(overriddenEnv.VITEST).toBeUndefined();
      expect(overriddenEnv.EVAL_TEST_GUARD).toBe("1");
      expect(overriddenEnv.NODE_OPTIONS).toContain(TEST_GUARDS_PRELOAD_FLAG);
      expect(overriddenEnv.NODE_OPTIONS).toContain(safetyPreloadUrl);

      const falseEnv = buildAllowlistedEnv(tempDir, {
        EVAL_TEST_GUARD: "0",
      });
      expect(falseEnv.EVAL_TEST_GUARD).toBe("1");

      // 2. Child executed with production overrides still loads test guards and blocks outbound transport
      // Notice: NO import of test-guards.ts in child script.
      const childScript = `
import http from "node:http";
import https from "node:https";

async function main() {
  let fetchBlocked = false;
  let httpsBlocked = false;

  try {
    await fetch("https://generativelanguage.googleapis.com/test");
  } catch (err) {
    if (err.name === "RealCompletionTransportBlockedError" && err.host === "generativelanguage.googleapis.com") {
      fetchBlocked = true;
    }
  }

  try {
    https.request("https://api.anthropic.com/v1/messages");
  } catch (err) {
    if (err.name === "RealCompletionTransportBlockedError" && err.host === "api.anthropic.com") {
      httpsBlocked = true;
    }
  }

  const counters = globalThis.__safetyCounters || {};
  const totalSafetyCalls = (counters.dnsCalls || 0) + (counters.socketConnectCalls || 0) + (counters.fetchCalls || 0) + (counters.httpCalls || 0);

  if (fetchBlocked && httpsBlocked && totalSafetyCalls === 0) {
    process.stdout.write(JSON.stringify({ ok: true, counters }));
    process.exit(0);
  } else {
    process.stderr.write("Overrides regression failed: " + JSON.stringify({ fetchBlocked, httpsBlocked, counters }));
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write("Unhandled exception: " + String(err?.stack || err));
  process.exit(2);
});
`;
      writeFileSync(childScriptPath, childScript, "utf8");

      const res = spawnSync(process.execPath, [childScriptPath], {
        cwd: tempDir,
        env: overriddenEnv,
        encoding: "utf8",
        timeout: 15_000,
      });

      expect(res.status).toBe(0);
      expect(res.stderr).toBe("");
      const result = JSON.parse(res.stdout);
      expect(result.ok).toBe(true);
      expect(result.counters.dnsCalls).toBe(0);
      expect(result.counters.socketConnectCalls).toBe(0);
      expect(result.counters.fetchCalls).toBe(0);
      expect(result.counters.httpCalls).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the fail-closed transport guard active in the image-resident SDK process", async () => {
    const supervisorPath = join(process.cwd(), "evals", "container", "run-measured.mjs");
    const tempDir = mkdtempSync(join(tmpdir(), "guest-sdk-guard-"));
    const socketPath = join(tempDir, "control.sock");
    const server = createServer((socket) => {
      socket.once("data", (chunk) => {
        const request = JSON.parse(chunk.toString("utf8").trim());
        const response = request.type === "get-credential"
          ? { ok: false }
          : request.type === "register-task-process"
            ? { ok: true }
            : request.type === "quiesce-task-processes"
              ? { ok: true, streamingStopped: true, descendantsStopped: true, remaining: 0 }
              : { ok: false };
        socket.end(`${JSON.stringify(response)}\n`);
      });
    });
    try {
      await startSocketServer(server, socketPath);
      // The replacement agent is not a nested `pi --mode rpc` child: it imports the
      // locked SDK in this guarded process. A legacy binary override must be ignored.
      const child = spawn(process.execPath, [supervisorPath, "agent"], {
        cwd: tempDir,
        env: buildAllowlistedEnv(tempDir, {
          EVAL_PI_BINARY: "/definitely/not/executable",
          EVAL_CONTROL_SOCKET: socketPath,
        }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const init = {
        type: "init",
        protocolVersion: 1,
        mode: "scripted",
        arm: "baseline",
        target: { provider: "google", model: "gemini-3.8-flash", thinking: "low" },
        skillPath: null,
        allowedTools: ["read"],
        skillToolBundle: null,
        skillToolBundleSha256: "f9cc8e2b85ebe6aa64c21b5be039960cdc74a5743ca280d0f84c440f745c993b",
        processLifetimeMs: 180_000,
        armWallClockMs: 10_000,
        limits: { maxProviderRequests: 1, maxToolSteps: 1, maxOutputTokens: 100 },
        credentialVariable: "GEMINI_API_KEY",
        scriptedSteps: [{ type: "text", text: "guarded scripted completion" }],
      };
      let output = "";
      let error = "";
      const ready = new Promise<void>((resolve) => {
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.includes('"type":"ready"')) resolve();
        });
      });
      child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString("utf8"); });
      child.stdin.write(`${JSON.stringify(init)}\n`);
      await ready;
      child.stdin.end(`${JSON.stringify({ type: "prompt", prompt: "test" })}\n`);
      const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
      expect(code).toBe(0);
      expect(error).toBe("");
      expect(output).toContain('"type":"ready"');
      expect(output).toContain('"type":"result"');
      expect(output).toContain('"providerRequests":1');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("surfaces socket denial promptly as a named SocketFixtureError without hanging", async () => {
    const server = createServer();
    // Attempting to bind to a non-existent directory will fail with ENOENT promptly
    const invalidSocketPath = "/nonexistent-dir-123456/test.sock";
    const startTime = Date.now();

    await expect(startSocketServer(server, invalidSocketPath)).rejects.toThrow(SocketFixtureError);

    const elapsed = Date.now() - startTime;
    // Must reject promptly, well under the 5000ms test timeout
    expect(elapsed).toBeLessThan(1000);
    server.close();
  });
});
