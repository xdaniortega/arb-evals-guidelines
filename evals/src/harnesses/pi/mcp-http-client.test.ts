import { describe, expect, it } from "vitest";
import { EvalError } from "../../core/types.ts";
import {
  MCP_MAX_RESULT_TEXT_BYTES,
  MCP_MAX_TOOLS,
  MCP_PROTOCOL_VERSION,
  MCP_TRUNCATION_MARKER,
  McpCallError,
  McpProvisionError,
  openMcpSession,
  truncateUtf8,
} from "./mcp-http-client.ts";
import { createMcpStub, type McpStub } from "./mcp-stub.test-helper.ts";

function assertNoCredentialHeaders(requests: readonly { readonly headers: Record<string, any> }[]): void {
  const forbiddenHeaderKeys = ["authorization", "x-api-key", "token", "auth", "secret", "bearer", "credential"];
  for (const req of requests) {
    for (const [key, value] of Object.entries(req.headers)) {
      const lowerKey = key.toLowerCase();
      for (const forbidden of forbiddenHeaderKeys) {
        expect(lowerKey).not.toContain(forbidden);
      }
      if (typeof value === "string") {
        expect(value).not.toMatch(/^(Bearer|Basic)\s+/i);
        expect(value).not.toMatch(/^sk-[a-zA-Z0-9_-]+/);
      }
    }
  }
}

describe("MCP HTTP client (openMcpSession)", () => {
  describe("Happy path: json mode", () => {
    it("executes the exact handshake and call sequence, sorts tools, echoes session id, and sends no credentials", async () => {
      const toolsPayload = [
        { name: "zebra", description: "Zebra tool", inputSchema: { type: "object" } },
        { name: "apple", description: "Apple tool", inputSchema: null },
        { name: "banana", description: null, inputSchema: { type: "string" } },
      ];
      const stub = await createMcpStub({
        mode: "json",
        tools: toolsPayload,
        responses: {
          apple: { text: "tasty apple result", isError: false },
        },
      });

      try {
        const session = await openMcpSession({
          serverName: "test-server",
          url: stub.url,
          handshakeTimeoutMs: 5_000,
        });

        expect(session.serverName).toBe("test-server");
        // Check sorted tools: apple, banana, zebra
        expect(session.tools.map((t) => t.name)).toEqual(["apple", "banana", "zebra"]);
        expect(session.tools[0]?.description).toBe("Apple tool");
        expect(session.tools[1]?.description).toBeNull();

        // Call tool
        const result = await session.callTool("apple", { variety: "fuji" }, { timeoutMs: 2_000 });
        expect(result).toEqual({
          text: "tasty apple result",
          isError: false,
          truncated: false,
        });

        await session.close();

        // Assert exact request sequence:
        // 1. initialize
        // 2. notifications/initialized
        // 3. tools/list
        // 4. tools/call
        expect(stub.requests.length).toBe(4);
        expect(stub.requests[0]?.method).toBe("initialize");
        expect(stub.requests[1]?.method).toBe("notifications/initialized");
        expect(stub.requests[2]?.method).toBe("tools/list");
        expect(stub.requests[3]?.method).toBe("tools/call");

        // Protocol version header present on every request
        for (const req of stub.requests) {
          expect(req.headers["mcp-protocol-version"]).toBe(MCP_PROTOCOL_VERSION);
          expect(req.headers["content-type"]).toBe("application/json");
        }

        // Mcp-Session-Id echo: NOT on initialize, but present on subsequent requests
        expect(stub.requests[0]?.headers["mcp-session-id"]).toBeUndefined();
        expect(stub.requests[1]?.headers["mcp-session-id"]).toBe("test-mcp-session-uuid-1234");
        expect(stub.requests[2]?.headers["mcp-session-id"]).toBe("test-mcp-session-uuid-1234");
        expect(stub.requests[3]?.headers["mcp-session-id"]).toBe("test-mcp-session-uuid-1234");

        // Zero credentials invariant
        assertNoCredentialHeaders(stub.requests);
      } finally {
        await stub.close();
      }
    });

    it("completes handshake and discovers tools when notification is answered with 202 Accepted and no body", async () => {
      const stub = await createMcpStub({
        mode: "json",
        notificationResponse: "202",
        tools: [{ name: "tool-202", description: "from 202 notification reply", inputSchema: {} }],
      });
      try {
        const session = await openMcpSession({
          serverName: "srv-202",
          url: stub.url,
          handshakeTimeoutMs: 5_000,
        });
        expect(session.tools.map((t) => t.name)).toEqual(["tool-202"]);
        await session.close();
      } finally {
        await stub.close();
      }
    });

    it("completes handshake and discovers tools when notification is answered with 200 OK and JSON body", async () => {
      const stub = await createMcpStub({
        mode: "json",
        notificationResponse: "json-200",
        tools: [{ name: "tool-200", description: "from 200 notification reply", inputSchema: {} }],
      });
      try {
        const session = await openMcpSession({
          serverName: "srv-200",
          url: stub.url,
          handshakeTimeoutMs: 5_000,
        });
        expect(session.tools.map((t) => t.name)).toEqual(["tool-200"]);
        await session.close();
      } finally {
        await stub.close();
      }
    });
  });

  describe("Happy path: sse mode", () => {
    it("executes sequence with text/event-stream response frames", async () => {
      const stub = await createMcpStub({
        mode: "sse",
        tools: [
          { name: "search-tool", description: "Search docs", inputSchema: {} },
        ],
        responses: {
          "search-tool": { text: "search query output", isError: false },
        },
      });

      try {
        const session = await openMcpSession({
          serverName: "sse-server",
          url: stub.url,
          handshakeTimeoutMs: 5_000,
        });

        expect(session.tools.map((t) => t.name)).toEqual(["search-tool"]);
        const result = await session.callTool("search-tool", { q: "arb" }, { timeoutMs: 2_000 });
        expect(result.text).toBe("search query output");
        expect(result.isError).toBe(false);
        expect(result.truncated).toBe(false);

        await session.close();

        expect(stub.requests.length).toBe(4);
        expect(stub.requests[0]?.method).toBe("initialize");
        expect(stub.requests[1]?.method).toBe("notifications/initialized");
        expect(stub.requests[2]?.method).toBe("tools/list");
        expect(stub.requests[3]?.method).toBe("tools/call");

        assertNoCredentialHeaders(stub.requests);
      } finally {
        await stub.close();
      }
    });

    it("handles SSE continuation lines (split data: lines) correctly", async () => {
      const stub = await createMcpStub({
        mode: "sse",
        splitSseDataLines: true,
        tools: [{ name: "split-tool", description: "Tool from split SSE", inputSchema: {} }],
      });

      try {
        const session = await openMcpSession({
          serverName: "split-sse-server",
          url: stub.url,
          handshakeTimeoutMs: 5_000,
        });

        expect(session.tools.map((t) => t.name)).toEqual(["split-tool"]);
        await session.close();
      } finally {
        await stub.close();
      }
    });

    it("tolerates SSE heartbeat frames with empty or whitespace data before real message frame", async () => {
      const stub = await createMcpStub({
        mode: "sse",
        sseHeartbeat: true,
        tools: [{ name: "heartbeat-tool", description: "Survived heartbeats", inputSchema: {} }],
        responses: {
          "heartbeat-tool": { text: "heartbeat tool result", isError: false },
        },
      });
      try {
        const session = await openMcpSession({
          serverName: "heartbeat-sse-server",
          url: stub.url,
          handshakeTimeoutMs: 5_000,
        });
        expect(session.tools.map((t) => t.name)).toEqual(["heartbeat-tool"]);

        const result = await session.callTool("heartbeat-tool", {}, { timeoutMs: 2_000 });
        expect(result.text).toBe("heartbeat tool result");

        await session.close();
      } finally {
        await stub.close();
      }
    });
  });

  describe("Fault mapping to McpProvisionError", () => {
    it("maps http-500 during handshake to McpProvisionError", async () => {
      const stub = await createMcpStub({ fault: "http-500" });
      try {
        await expect(
          openMcpSession({ serverName: "fault-srv", url: stub.url, handshakeTimeoutMs: 2_000 }),
        ).rejects.toThrow(McpProvisionError);
      } finally {
        await stub.close();
      }
    });

    it("maps malformed JSON during handshake to McpProvisionError", async () => {
      const stub = await createMcpStub({ fault: "malformed" });
      try {
        await expect(
          openMcpSession({ serverName: "fault-srv", url: stub.url, handshakeTimeoutMs: 2_000 }),
        ).rejects.toThrow(McpProvisionError);
      } finally {
        await stub.close();
      }
    });

    it("maps jsonrpc-error on initialize to McpProvisionError", async () => {
      const stub = await createMcpStub({ fault: "jsonrpc-error", faultStep: "initialize" });
      try {
        await expect(
          openMcpSession({ serverName: "fault-srv", url: stub.url, handshakeTimeoutMs: 2_000 }),
        ).rejects.toThrow(McpProvisionError);
      } finally {
        await stub.close();
      }
    });

    it("maps id-mismatch during handshake to McpProvisionError", async () => {
      const stub = await createMcpStub({ fault: "id-mismatch" });
      try {
        await expect(
          openMcpSession({ serverName: "fault-srv", url: stub.url, handshakeTimeoutMs: 2_000 }),
        ).rejects.toThrow(McpProvisionError);
      } finally {
        await stub.close();
      }
    });

    it("maps oversized response (>512 KiB) during handshake to McpProvisionError", async () => {
      const stub = await createMcpStub({ fault: "oversized" });
      try {
        await expect(
          openMcpSession({ serverName: "fault-srv", url: stub.url, handshakeTimeoutMs: 2_000 }),
        ).rejects.toThrow(McpProvisionError);
      } finally {
        await stub.close();
      }
    });

    it("maps non-2xx status on notifications/initialized to McpProvisionError", async () => {
      const stub = await createMcpStub({ fault: "http-500", faultStep: "notifications/initialized" });
      try {
        await expect(
          openMcpSession({ serverName: "fault-srv", url: stub.url, handshakeTimeoutMs: 2_000 }),
        ).rejects.toThrow(McpProvisionError);
      } finally {
        await stub.close();
      }
    });

    it("maps unsupported content-type during non-notification steps to McpProvisionError", async () => {
      const stub = await createMcpStub({ fault: "unsupported-content-type", faultStep: "initialize" });
      try {
        let caughtError: unknown;
        try {
          await openMcpSession({ serverName: "html-srv", url: stub.url, handshakeTimeoutMs: 2_000 });
        } catch (err) {
          caughtError = err;
        }
        expect(caughtError).toBeInstanceOf(McpProvisionError);
        expect((caughtError as Error).message).toContain("unsupported content-type");
      } finally {
        await stub.close();
      }
    });

    it("maps mid-body socket destruction during handshake to McpProvisionError without leaking bare TypeError", async () => {
      const stub = await createMcpStub({ fault: "socket-destroy", faultStep: "initialize" });
      try {
        let caughtError: unknown;
        try {
          await openMcpSession({ serverName: "socket-fault-srv", url: stub.url, handshakeTimeoutMs: 2_000 });
        } catch (err) {
          caughtError = err;
        }
        expect(caughtError).toBeInstanceOf(McpProvisionError);
        expect(caughtError).toBeInstanceOf(EvalError);
        expect(caughtError).not.toBeInstanceOf(TypeError);
        expect((caughtError as EvalError).cause).toBeDefined();
        const msg = (caughtError as Error).message;
        expect(msg).toContain("socket-fault-srv");
        expect(msg).toContain("initialize");
        expect(msg).not.toContain("http://");
        expect(msg).not.toContain("127.0.0.1");
      } finally {
        await stub.close();
      }
    });

    it("maps invalid URL or missing serverName to McpProvisionError with code input-invalid", async () => {
      await expect(
        openMcpSession({ serverName: "", url: "http://127.0.0.1:1" }),
      ).rejects.toThrow(McpProvisionError);

      await expect(
        openMcpSession({ serverName: "srv", url: "not-a-valid-url" }),
      ).rejects.toThrow(McpProvisionError);

      await expect(
        openMcpSession({ serverName: "srv", url: "ftp://127.0.0.1:1" }),
      ).rejects.toThrow(McpProvisionError);

      await expect(
        openMcpSession({ serverName: "srv", url: "http://user:pass@127.0.0.1:1" }),
      ).rejects.toThrow(McpProvisionError);
    });
  });

  describe("Fault mapping to McpCallError", () => {
    it("maps tools/call JSON-RPC error to McpCallError without invalidating session", async () => {
      const stub = await createMcpStub({
        fault: "jsonrpc-error",
        faultStep: "tools/call",
        tools: [{ name: "test-tool", description: null, inputSchema: {} }],
      });
      try {
        const session = await openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 2_000 });
        expect(session.tools.length).toBe(1);

        await expect(
          session.callTool("test-tool", {}, { timeoutMs: 2_000 }),
        ).rejects.toThrow(McpCallError);

        await session.close();
      } finally {
        await stub.close();
      }
    });

    it("maps tools/call HTTP 500 to McpCallError", async () => {
      const stub = await createMcpStub({
        fault: "http-500",
        faultStep: "tools/call",
        tools: [{ name: "test-tool", description: null, inputSchema: {} }],
      });
      try {
        const session = await openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 2_000 });

        await expect(
          session.callTool("test-tool", {}, { timeoutMs: 2_000 }),
        ).rejects.toThrow(McpCallError);

        await session.close();
      } finally {
        await stub.close();
      }
    });

    it("maps tools/call oversized response (>512 KiB) to McpCallError", async () => {
      const stub = await createMcpStub({
        fault: "oversized",
        faultStep: "tools/call",
        tools: [{ name: "test-tool", description: null, inputSchema: {} }],
      });
      try {
        const session = await openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 2_000 });

        await expect(
          session.callTool("test-tool", {}, { timeoutMs: 2_000 }),
        ).rejects.toThrow(McpCallError);

        await session.close();
      } finally {
        await stub.close();
      }
    });

    it("maps tools/call id-mismatch to McpCallError", async () => {
      const stub = await createMcpStub({
        fault: "id-mismatch",
        faultStep: "tools/call",
        tools: [{ name: "test-tool", description: null, inputSchema: {} }],
      });
      try {
        const session = await openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 2_000 });

        await expect(
          session.callTool("test-tool", {}, { timeoutMs: 2_000 }),
        ).rejects.toThrow(McpCallError);

        await session.close();
      } finally {
        await stub.close();
      }
    });

    it("maps mid-body socket destruction during tools/call to McpCallError without leaking bare TypeError", async () => {
      const stub = await createMcpStub({
        fault: "socket-destroy",
        faultStep: "tools/call",
        tools: [{ name: "test-tool", description: null, inputSchema: {} }],
      });
      try {
        const session = await openMcpSession({ serverName: "socket-srv", url: stub.url, handshakeTimeoutMs: 2_000 });
        let caughtError: unknown;
        try {
          await session.callTool("test-tool", {}, { timeoutMs: 2_000 });
        } catch (err) {
          caughtError = err;
        }
        expect(caughtError).toBeInstanceOf(McpCallError);
        expect(caughtError).toBeInstanceOf(EvalError);
        expect(caughtError).not.toBeInstanceOf(TypeError);
        expect((caughtError as EvalError).cause).toBeDefined();
        const msg = (caughtError as Error).message;
        expect(msg).toContain("socket-srv");
        expect(msg).toContain("tools/call");
        expect(msg).not.toContain("http://");
        expect(msg).not.toContain("127.0.0.1");
        await session.close();
      } finally {
        await stub.close();
      }
    });

    it("maps invalid tool call name or invalid timeout to McpCallError with code input-invalid", async () => {
      const stub = await createMcpStub({
        tools: [{ name: "valid-tool", description: null, inputSchema: {} }],
      });
      try {
        const session = await openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 2_000 });

        await expect(
          session.callTool("123-invalid", {}, { timeoutMs: 2_000 }),
        ).rejects.toThrow(McpCallError);

        await expect(
          session.callTool("valid-tool", {}, { timeoutMs: -1 }),
        ).rejects.toThrow(McpCallError);

        await session.close();
      } finally {
        await stub.close();
      }
    });

    it("rejects tool calls after session is closed", async () => {
      const stub = await createMcpStub({
        tools: [{ name: "valid-tool", description: null, inputSchema: {} }],
      });
      try {
        const session = await openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 2_000 });
        await session.close();

        await expect(
          session.callTool("valid-tool", {}, { timeoutMs: 2_000 }),
        ).rejects.toThrow(McpCallError);
      } finally {
        await stub.close();
      }
    });
  });

  describe("Timeouts and AbortSignal cancellation", () => {
    it("respects handshake timeout on timeout fault", async () => {
      const stub = await createMcpStub({ fault: "timeout" });
      try {
        const start = Date.now();
        await expect(
          openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 50 }),
        ).rejects.toThrow(McpProvisionError);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(1_500);
      } finally {
        await stub.close();
      }
    });

    it("respects per-call timeoutMs on tools/call timeout", async () => {
      const stub = await createMcpStub({
        fault: "timeout",
        faultStep: "tools/call",
        tools: [{ name: "tool-a", description: null, inputSchema: {} }],
      });
      try {
        const session = await openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 2_000 });
        const start = Date.now();
        await expect(
          session.callTool("tool-a", {}, { timeoutMs: 50 }),
        ).rejects.toThrow(McpCallError);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(1_500);
        await session.close();
      } finally {
        await stub.close();
      }
    });

    it("cancels in-flight call when caller AbortSignal is aborted with code interrupted and elapsed under 1000ms", async () => {
      const stub = await createMcpStub({
        fault: "timeout",
        faultStep: "tools/call",
        tools: [{ name: "tool-a", description: null, inputSchema: {} }],
      });
      try {
        const session = await openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 2_000 });
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 20);

        const start = Date.now();
        let thrownError: unknown;
        try {
          await session.callTool("tool-a", {}, { timeoutMs: 5_000, signal: ac.signal });
        } catch (err) {
          thrownError = err;
        }
        const elapsed = Date.now() - start;

        expect(thrownError).toBeInstanceOf(McpCallError);
        expect((thrownError as McpCallError).code).toBe("interrupted");
        expect(elapsed).toBeLessThan(1_000);

        await session.close();
      } finally {
        await stub.close();
      }
    });

    it("cancels in-flight handshake when caller AbortSignal is aborted with code interrupted and elapsed under 1000ms", async () => {
      const stub = await createMcpStub({ fault: "timeout" });
      try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 20);

        const start = Date.now();
        let thrownError: unknown;
        try {
          await openMcpSession({
            serverName: "srv",
            url: stub.url,
            handshakeTimeoutMs: 5_000,
            signal: ac.signal,
          });
        } catch (err) {
          thrownError = err;
        }
        const elapsed = Date.now() - start;

        expect(thrownError).toBeInstanceOf(McpProvisionError);
        expect((thrownError as McpProvisionError).code).toBe("interrupted");
        expect(elapsed).toBeLessThan(1_000);
      } finally {
        await stub.close();
      }
    });

    it("rejects immediately on pre-aborted signal during handshake", async () => {
      const stub = await createMcpStub({ fault: "timeout" });
      try {
        const preAborted = AbortSignal.abort();
        const start = Date.now();
        let thrownError: unknown;
        try {
          await openMcpSession({
            serverName: "srv",
            url: stub.url,
            handshakeTimeoutMs: 5_000,
            signal: preAborted,
          });
        } catch (err) {
          thrownError = err;
        }
        const elapsed = Date.now() - start;

        expect(thrownError).toBeInstanceOf(McpProvisionError);
        expect((thrownError as McpProvisionError).code).toBe("interrupted");
        expect(elapsed).toBeLessThan(100);
      } finally {
        await stub.close();
      }
    });

    it("rejects immediately on pre-aborted signal during tools/call", async () => {
      const stub = await createMcpStub({
        tools: [{ name: "tool-a", description: null, inputSchema: {} }],
      });
      try {
        const session = await openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 2_000 });
        const preAborted = AbortSignal.abort();
        const start = Date.now();
        let thrownError: unknown;
        try {
          await session.callTool("tool-a", {}, { timeoutMs: 5_000, signal: preAborted });
        } catch (err) {
          thrownError = err;
        }
        const elapsed = Date.now() - start;

        expect(thrownError).toBeInstanceOf(McpCallError);
        expect((thrownError as McpCallError).code).toBe("interrupted");
        expect(elapsed).toBeLessThan(100);

        await session.close();
      } finally {
        await stub.close();
      }
    });
  });

  describe("Result truncation and UTF-8 boundaries", () => {
    it("truncates result text exceeding MCP_MAX_RESULT_TEXT_BYTES and appends [truncated]", async () => {
      const longText = "A".repeat(70 * 1024); // 70 KiB
      const stub = await createMcpStub({
        tools: [{ name: "big-tool", description: null, inputSchema: {} }],
        responses: {
          "big-tool": { text: longText, isError: false },
        },
      });
      try {
        const session = await openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 2_000 });
        const result = await session.callTool("big-tool", {}, { timeoutMs: 2_000 });

        expect(result.truncated).toBe(true);
        expect(result.text.endsWith(MCP_TRUNCATION_MARKER)).toBe(true);
        const prefix = result.text.slice(0, -MCP_TRUNCATION_MARKER.length);
        expect(Buffer.byteLength(prefix, "utf8")).toBe(MCP_MAX_RESULT_TEXT_BYTES);

        await session.close();
      } finally {
        await stub.close();
      }
    });

    it("does not slice across multibyte UTF-8 code points", () => {
      // 3 bytes before cap, then a 4-byte character (😀)
      const asciiPrefix = "X".repeat(MCP_MAX_RESULT_TEXT_BYTES - 2);
      const testString = `${asciiPrefix}😀remainder`;
      const truncated = truncateUtf8(testString, MCP_MAX_RESULT_TEXT_BYTES);

      expect(truncated.truncated).toBe(true);
      expect(truncated.text.endsWith(MCP_TRUNCATION_MARKER)).toBe(true);
      const prefix = truncated.text.slice(0, -MCP_TRUNCATION_MARKER.length);
      // The 4-byte emoji must NOT be partially included
      expect(prefix).toBe(asciiPrefix);
      expect(prefix).not.toContain("\uFFFD");
      expect(Buffer.byteLength(prefix, "utf8")).toBe(MCP_MAX_RESULT_TEXT_BYTES - 2);
    });

    it("preserves isError flag in tools/call result", async () => {
      const stub = await createMcpStub({
        tools: [{ name: "err-tool", description: null, inputSchema: {} }],
        responses: {
          "err-tool": { text: "tool reported failure", isError: true },
        },
      });
      try {
        const session = await openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 2_000 });
        const result = await session.callTool("err-tool", {}, { timeoutMs: 2_000 });

        expect(result.isError).toBe(true);
        expect(result.text).toBe("tool reported failure");
        expect(result.truncated).toBe(false);

        await session.close();
      } finally {
        await stub.close();
      }
    });
  });

  describe("Tool shape validation and limits", () => {
    it("refuses duplicate tool names", async () => {
      const stub = await createMcpStub({
        tools: [
          { name: "duplicate-tool", description: "first", inputSchema: {} },
          { name: "duplicate-tool", description: "second", inputSchema: {} },
        ],
      });
      try {
        await expect(
          openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 2_000 }),
        ).rejects.toThrow(McpProvisionError);
      } finally {
        await stub.close();
      }
    });

    it("refuses invalid tool names", async () => {
      const invalidNames = [
        "123-leading-digit",
        "_leading_underscore",
        "-leading-dash",
        "has space",
        "",
        "a".repeat(65), // > 64 chars
      ];

      for (const name of invalidNames) {
        const stub = await createMcpStub({
          tools: [{ name, description: "invalid", inputSchema: {} }],
        });
        try {
          await expect(
            openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 2_000 }),
          ).rejects.toThrow(McpProvisionError);
        } finally {
          await stub.close();
        }
      }
    });

    it("refuses tool lists exceeding MCP_MAX_TOOLS (16)", async () => {
      const excessiveTools = Array.from({ length: 17 }, (_, i) => ({
        name: `tool-${i}`,
        description: null,
        inputSchema: {},
      }));

      const stub = await createMcpStub({ tools: excessiveTools });
      try {
        await expect(
          openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 2_000 }),
        ).rejects.toThrow(McpProvisionError);
      } finally {
        await stub.close();
      }
    });

    it("accepts an empty tool list", async () => {
      const stub = await createMcpStub({ tools: [] });
      try {
        const session = await openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 2_000 });
        expect(session.tools).toEqual([]);
        await session.close();
      } finally {
        await stub.close();
      }
    });

    it("fails loudly with McpProvisionError when tools/list result is not an array (result: {})", async () => {
      const stub = await createMcpStub({ toolsResult: {} });
      try {
        let caughtError: unknown;
        try {
          await openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 2_000 });
        } catch (err) {
          caughtError = err;
        }
        expect(caughtError).toBeInstanceOf(McpProvisionError);
        expect((caughtError as Error).message).toContain("tools/list result.tools must be an array");
      } finally {
        await stub.close();
      }
    });

    it("fails loudly with McpProvisionError when result.tools contains a non-object entry ([null])", async () => {
      const stub = await createMcpStub({ tools: [null] });
      try {
        let caughtError: unknown;
        try {
          await openMcpSession({ serverName: "srv", url: stub.url, handshakeTimeoutMs: 2_000 });
        } catch (err) {
          caughtError = err;
        }
        expect(caughtError).toBeInstanceOf(McpProvisionError);
        expect((caughtError as Error).message).toContain("tool entry must be an object");
      } finally {
        await stub.close();
      }
    });
  });

  describe("Error taxonomy and sanitization", () => {
    it("both McpProvisionError and McpCallError extend EvalError and retain infrastructure failureClass", () => {
      const provErr = new McpProvisionError("protocol-drift", "prov test");
      expect(provErr).toBeInstanceOf(EvalError);
      expect(provErr.failureClass).toBe("infrastructure");
      expect(provErr.code).toBe("protocol-drift");

      const callErr = new McpCallError("protocol-drift", "call test");
      expect(callErr).toBeInstanceOf(EvalError);
      expect(callErr.failureClass).toBe("infrastructure");
      expect(callErr.code).toBe("protocol-drift");
    });

    it("never leaks URL query string or header values in error messages", async () => {
      const stub = await createMcpStub({ fault: "http-500" });
      const secretQuery = "secret_token_12345";
      const sensitiveUrl = `${stub.url}/mcp?api_key=${secretQuery}`;

      try {
        let caughtError: unknown;
        try {
          await openMcpSession({ serverName: "safe-server", url: sensitiveUrl, handshakeTimeoutMs: 2_000 });
        } catch (err) {
          caughtError = err;
        }

        expect(caughtError).toBeInstanceOf(McpProvisionError);
        const errMsg = (caughtError as Error).message;
        expect(errMsg).toContain("safe-server");
        expect(errMsg).toContain("initialize");
        expect(errMsg).not.toContain(secretQuery);
        expect(errMsg).not.toContain("api_key");
      } finally {
        await stub.close();
      }
    });

    it("clamps a server-controlled JSON-RPC error code, not just its message", async () => {
      // Regression: `code` was interpolated raw, so a server could push ~512 KiB of
      // attacker-chosen text into an EvalError message that nothing downstream clamps.
      const oversizedCode = "Z".repeat(400 * 1024);
      const stub = await createMcpStub({
        fault: "jsonrpc-error",
        faultStep: "initialize",
        faultErrorCode: oversizedCode,
      });
      try {
        let caught: unknown;
        try {
          await openMcpSession({ serverName: "clamp-code", url: stub.url, handshakeTimeoutMs: 2_000 });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(McpProvisionError);
        const message = (caught as Error).message;
        expect(message).not.toContain("Z".repeat(201));
        expect(message.length).toBeLessThan(1_000);
      } finally {
        await stub.close();
      }
    });

    it("clamps server-controlled strings to at most 200 characters in error messages", async () => {
      // 1. Oversized tool name (400 KiB)
      const oversizedToolName = "tool_" + "X".repeat(400 * 1024);
      const toolStub = await createMcpStub({
        tools: [{ name: oversizedToolName, description: null, inputSchema: {} }],
      });
      try {
        let caughtError: unknown;
        try {
          await openMcpSession({ serverName: "clamp-srv", url: toolStub.url, handshakeTimeoutMs: 2_000 });
        } catch (err) {
          caughtError = err;
        }
        expect(caughtError).toBeInstanceOf(McpProvisionError);
        const errMsg = (caughtError as Error).message;
        expect(errMsg).not.toContain("X".repeat(201));
      } finally {
        await toolStub.close();
      }

      // 2. Oversized JSON-RPC error message (400 KiB)
      const oversizedJsonRpcMsg = "synthetic_error_" + "Y".repeat(400 * 1024);
      const jsonRpcStub = await createMcpStub({
        fault: "jsonrpc-error",
        faultStep: "initialize",
        faultErrorMessage: oversizedJsonRpcMsg,
      });
      try {
        let caughtError: unknown;
        try {
          await openMcpSession({ serverName: "clamp-srv", url: jsonRpcStub.url, handshakeTimeoutMs: 2_000 });
        } catch (err) {
          caughtError = err;
        }
        expect(caughtError).toBeInstanceOf(McpProvisionError);
        const errMsg = (caughtError as Error).message;
        expect(errMsg).not.toContain("Y".repeat(201));
      } finally {
        await jsonRpcStub.close();
      }
    });
  });
});
