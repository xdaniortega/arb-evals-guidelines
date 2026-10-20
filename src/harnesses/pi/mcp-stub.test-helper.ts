/**
 * Scripted loopback MCP server stub for test isolation.
 *
 * Test-helper only: bound to 127.0.0.1:0.
 * MUST NOT be included in the guest runtime closure (evals/scripts/build-guest-runtime.mjs).
 */

import http from "node:http";
import type { Socket } from "node:net";

export type McpStubMode = "json" | "sse";
export type McpStubFault =
  | "timeout"
  | "http-500"
  | "jsonrpc-error"
  | "malformed"
  | "id-mismatch"
  | "oversized"
  | "socket-destroy"
  | "unsupported-content-type";

export interface McpStubRecordedRequest {
  readonly method?: string;
  readonly body: any;
  readonly headers: http.IncomingHttpHeaders;
}

export interface McpStubOptions {
  readonly mode?: McpStubMode;
  readonly tools?: unknown[];
  readonly toolsResult?: unknown;
  readonly responses?: Record<string, { readonly text: string; readonly isError?: boolean }>;
  readonly fault?: McpStubFault;
  readonly faultStep?: "initialize" | "notifications/initialized" | "tools/list" | "tools/call";
  readonly faultErrorMessage?: string;
  /** Server-controlled JSON-RPC error `code`; a string proves it is clamped like any other server fragment. */
  readonly faultErrorCode?: number | string;
  readonly delayMs?: number;
  readonly sessionId?: string;
  readonly splitSseDataLines?: boolean;
  readonly notificationResponse?: "202" | "json-200";
  readonly sseHeartbeat?: boolean;
}

export interface McpStub {
  readonly url: string;
  readonly requests: readonly McpStubRecordedRequest[];
  close(): Promise<void>;
}

export async function createMcpStub(options: McpStubOptions = {}): Promise<McpStub> {
  const mode = options.mode ?? "json";
  const recordedRequests: McpStubRecordedRequest[] = [];
  const sockets = new Set<Socket>();
  const defaultSessionId = options.sessionId ?? "test-mcp-session-uuid-1234";

  const server = http.createServer(async (req, res) => {
    // Collect body
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    req.on("end", async () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body: any = null;
      try {
        body = JSON.parse(rawBody);
      } catch {
        // Leave body as null if not parseable
      }

      const method = typeof body === "object" && body !== null ? body.method : undefined;
      recordedRequests.push({
        method,
        body,
        headers: { ...req.headers },
      });

      if (options.delayMs && options.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }

      // Check fault injection
      const fault = options.fault;
      const faultStep = options.faultStep;
      const faultMatches = fault !== undefined && (faultStep === undefined || faultStep === method);

      if (faultMatches) {
        switch (fault) {
          case "timeout":
            // Keep request hanging; do not write response
            return;
          case "http-500":
            res.writeHead(500, { "content-type": "text/plain" });
            res.end("Internal Server Error (fault injection)");
            return;
          case "jsonrpc-error": {
            const errPayload = {
              jsonrpc: "2.0",
              id: body?.id ?? 1,
              error: {
                code: options.faultErrorCode ?? -32603,
                message: options.faultErrorMessage ?? "Synthetic internal JSON-RPC error",
              },
            };
            if (mode === "sse") {
              res.writeHead(200, { "content-type": "text/event-stream" });
              res.end(`event: message\ndata: ${JSON.stringify(errPayload)}\n\n`);
            } else {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify(errPayload));
            }
            return;
          }
          case "malformed":
            if (mode === "sse") {
              res.writeHead(200, { "content-type": "text/event-stream" });
              res.end(`data: {malformed json payload\n\n`);
            } else {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(`{malformed json payload`);
            }
            return;
          case "id-mismatch": {
            const mismatchPayload = {
              jsonrpc: "2.0",
              id: (body?.id ?? 1) + 99999,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                serverInfo: { name: "stub", version: "1.0.0" },
              },
            };
            if (mode === "sse") {
              res.writeHead(200, { "content-type": "text/event-stream" });
              res.end(`data: ${JSON.stringify(mismatchPayload)}\n\n`);
            } else {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify(mismatchPayload));
            }
            return;
          }
          case "oversized": {
            // Generate > 512 KiB payload
            const bigPayload = {
              jsonrpc: "2.0",
              id: body?.id ?? 1,
              result: {
                padding: "X".repeat(550 * 1024),
              },
            };
            if (mode === "sse") {
              res.writeHead(200, { "content-type": "text/event-stream" });
              res.write(`: comment\n`);
              res.write(`data: ${JSON.stringify(bigPayload)}\n\n`);
              res.end();
            } else {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify(bigPayload));
            }
            return;
          }
          case "socket-destroy": {
            res.writeHead(200, { "content-type": "application/json" });
            res.write(`{"jsonrpc":"2.0",`);
            (res.socket ?? req.socket)?.destroy();
            return;
          }
          case "unsupported-content-type": {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end("<html><body>Not MCP</body></html>");
            return;
          }
        }
      }

      // Normal dispatch by JSON-RPC method
      if (method === "initialize") {
        const initResult = {
          jsonrpc: "2.0",
          id: body?.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "stub-server",
              version: "1.0.0",
            },
          },
        };
        if (mode === "sse") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "mcp-session-id": defaultSessionId,
          });
          if (options.sseHeartbeat) {
            res.write(`data:   \n\n`);
          }
          res.write(`: ping comment\n`);
          res.write(`event: message\n`);
          res.write(`id: 1\n`);
          if (options.splitSseDataLines) {
            const raw = JSON.stringify(initResult);
            // Split at a top-level comma so both lines are valid JSON when joined with \n
            const commaIndex = raw.indexOf(",");
            if (commaIndex !== -1) {
              res.write(`data: ${raw.slice(0, commaIndex + 1)}\n`);
              res.write(`data: ${raw.slice(commaIndex + 1)}\n\n`);
            } else {
              res.write(`data: ${raw}\n\n`);
            }
          } else {
            res.write(`data: ${JSON.stringify(initResult)}\n\n`);
          }
          res.end();
        } else {
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": defaultSessionId,
          });
          res.end(JSON.stringify(initResult));
        }
        return;
      }

      if (method === "notifications/initialized") {
        if (options.notificationResponse === "json-200") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        } else {
          // MCP spec: notification is answered with 202 Accepted, no body, no content-type
          res.writeHead(202);
          res.end();
        }
        return;
      }

      if (method === "tools/list") {
        const defaultTools = [
          {
            name: "sample-tool",
            description: "A sample tool",
            inputSchema: { type: "object" },
          },
        ];
        const listResult = {
          jsonrpc: "2.0",
          id: body?.id,
          result: options.toolsResult !== undefined
            ? options.toolsResult
            : {
                tools: options.tools ?? defaultTools,
              },
        };
        if (mode === "sse") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`event: message\n`);
          res.write(`data: ${JSON.stringify(listResult)}\n\n`);
          res.end();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(listResult));
        }
        return;
      }

      if (method === "tools/call") {
        const toolName = body?.params?.name;
        const configuredResponse = options.responses?.[toolName] ?? {
          text: `result for ${String(toolName)}`,
          isError: false,
        };
        const callResult = {
          jsonrpc: "2.0",
          id: body?.id,
          result: {
            content: [
              {
                type: "text",
                text: configuredResponse.text,
              },
            ],
            isError: configuredResponse.isError ?? false,
          },
        };
        if (mode === "sse") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          if (options.sseHeartbeat) {
            res.write(`data:\n\n`);
          }
          res.write(`event: message\n`);
          res.write(`data: ${JSON.stringify(callResult)}\n\n`);
          res.end();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(callResult));
        }
        return;
      }

      // Unknown method
      const unknownResult = {
        jsonrpc: "2.0",
        id: body?.id ?? null,
        error: {
          code: -32601,
          message: `Method not found: ${String(method)}`,
        },
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(unknownResult));
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    requests: recordedRequests,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
