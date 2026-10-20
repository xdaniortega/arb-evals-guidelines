/** Shared-client behavior through loopback HTTP, with no provider calls. */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as secretScan from "../../core/secret-scan.ts";
import { EMPTY_SKILL_TOOL_BUNDLE, type SkillToolBundle } from "../../core/skill-tools.ts";
import { createMcpStub, type McpStub } from "./mcp-stub.test-helper.ts";
import { createMcpClient, MCP_CLIENT_TOOL, MCP_CLEANUP_RESERVE_MS, type McpClient } from "./mcp-tools.ts";
import { MCP_MAX_RESULT_TEXT_BYTES } from "./mcp-http-client.ts";

const clients: McpClient[] = [];
const stubs: McpStub[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  await Promise.all(stubs.splice(0).map((stub) => stub.close()));
  vi.restoreAllMocks();
});
async function stub(options: Parameters<typeof createMcpStub>[0] = {}) {
  const result = await createMcpStub(options); stubs.push(result); return result;
}
async function client(overrides: Partial<Parameters<typeof createMcpClient>[0]> = {}) {
  const result = await createMcpClient({ conditionId: "baseline", bundle: null, guardedSecrets: [], deadlineAtMs: Date.now() + 30_000, ...overrides });
  clients.push(result); return result;
}
function bundle(url: string): SkillToolBundle {
  return { ...EMPTY_SKILL_TOOL_BUNDLE, servers: [{ name: "docs", transport: "streamable_http", url, description: null }] };
}
const execute = (c: McpClient, params: Record<string, unknown>, signal?: AbortSignal) => c.definition.execute("test-call", params, signal);
const text = (result: Awaited<ReturnType<typeof execute>>) => result.content.filter((b) => b.type === "text").map((b) => b.text).join("");
async function connect(c: McpClient, url: string, server = "docs") {
  const result = await execute(c, { action: "connect", server, url });
  expect(result.isError).toBe(false);
  return result;
}

describe("shared MCP client", () => {
  it.each(["baseline", "treatment"] as const)("%s connects, discovers schemas and invokes a tool without seed configuration", async (conditionId) => {
    const server = await stub({ responses: { "sample-tool": { text: "answer" } } });
    const c = await client({ conditionId });
    expect(c.seededServers).toEqual([]);
    expect(server.requests).toHaveLength(0);
    expect(text(await execute(c, { action: "list" }))).toBe('{"servers":[]}');
    await connect(c, server.url);
    const listed = JSON.parse(text(await execute(c, { action: "list", server: "docs" })));
    expect(listed.tools[0]).toMatchObject({ name: "sample-tool", inputSchema: { type: "object" } });
    const result = await execute(c, { action: "call", server: "docs", tool: "sample-tool", arguments: { query: "test" } });
    expect(text(result)).toBe("answer");
    expect(server.requests.map((request) => request.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(server.requests.at(-1)?.body.params.arguments).toEqual({ query: "test" });
  });

  it("has one identical advertised tool for both arms and keeps seeds and connections private", async () => {
    const server = await stub();
    const baseline = await client();
    const treatment = await client({ conditionId: "treatment", bundle: bundle(server.url) });
    const advertised = (c: McpClient) => { const { execute: _, ...schema } = c.definition; return schema; };
    expect(advertised(baseline)).toEqual(MCP_CLIENT_TOOL);
    expect(advertised(treatment)).toEqual(advertised(baseline));
    expect(JSON.stringify(advertised(treatment))).not.toContain(server.url);
    expect(treatment.seededServers).toEqual(["docs"]);
    expect(text(await execute(baseline, { action: "list" }))).not.toContain("docs");
    expect((await execute(baseline, { action: "call", server: "docs", tool: "sample-tool" })).isError).toBe(true);
    expect((await execute(treatment, { action: "call", server: "docs", tool: "sample-tool" })).isError).toBe(false);
    await connect(baseline, server.url);
    expect(baseline.seededServers).toEqual([]);
    baseline.dispose();
    expect((await execute(treatment, { action: "list", server: "docs" })).isError).toBe(false);
  });

  it("refuses treatment seeds in baseline before network activity", async () => {
    const server = await stub();
    await expect(client({ bundle: bundle(server.url) })).rejects.toMatchObject({ code: "parity-violation" });
    expect(server.requests).toHaveLength(0);
  });

  it("required seed failures are readiness errors; agent endpoint failures are ordinary tool results", async () => {
    const server = await stub({ tools: [] });
    await expect(client({ conditionId: "treatment", bundle: bundle(server.url) })).rejects.toMatchObject({ code: "protocol-drift", message: expect.stringContaining("zero tools") });
    const c = await client();
    expect((await execute(c, { action: "connect", server: "bad", url: "not-a-url" })).isError).toBe(true);
    expect((await execute(c, { action: "connect", server: "bad", url: "file:///tmp/mcp" })).isError).toBe(true);
    await connect(c, server.url); // Optional connections may have no tools.
  });

  it("allows server tool names matching builtins and other servers because calls include a server name", async () => {
    const server = await stub({ tools: [{ name: "write", inputSchema: { type: "object" } }] });
    const c = await client();
    await connect(c, server.url, "one");
    await connect(c, server.url, "two");
    expect((await execute(c, { action: "call", server: "two", tool: "write" })).isError).toBe(false);
  });

  it("reserves the bounded connection slots before concurrent handshakes and reuses the same server", async () => {
    const server = await stub({ delayMs: 10 });
    const c = await client();
    const results = await Promise.all(Array.from({ length: 5 }, (_, n) => execute(c, { action: "connect", server: `s${n}`, url: server.url })));
    expect(results.map((result) => result.isError)).toEqual([false, false, false, false, true]);
    expect(text(results[4]!)).toContain("connection limit");
    const requestsBefore = server.requests.length;
    await connect(c, server.url, "s0");
    expect(server.requests).toHaveLength(requestsBefore);
    expect((await execute(c, { action: "connect", server: "s0", url: `${server.url}/other` })).isError).toBe(true);
  });

  it("preserves the total discovered-tool cap and does not register a failed connection", async () => {
    const server = await stub({ tools: Array.from({ length: 9 }, (_, n) => ({ name: `tool${n}` })) });
    const c = await client();
    await connect(c, server.url, "one");
    const result = await execute(c, { action: "connect", server: "two", url: server.url });
    expect(text(result)).toContain("tool limit");
    expect(text(await execute(c, { action: "list" }))).not.toContain("two");
  });

  it("refuses calls to undiscovered tools before issuing an HTTP request", async () => {
    const server = await stub(); const c = await client(); await connect(c, server.url);
    const before = server.requests.length;
    expect((await execute(c, { action: "call", server: "docs", tool: "unknown" })).isError).toBe(true);
    expect(server.requests).toHaveLength(before);
  });

  it.each(["connect", "call"] as const)("charges %s to the remaining child budget", async (action) => {
    const server = await stub({ fault: "timeout", faultStep: action === "connect" ? "initialize" : "tools/call" });
    const c = await client();
    if (action === "call") await connect(c, server.url);
    c.setDeadline(Date.now() + MCP_CLEANUP_RESERVE_MS + 60);
    const started = Date.now();
    const result = await execute(c, action === "connect" ? { action, server: "docs", url: server.url } : { action, server: "docs", tool: "sample-tool" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(1500);
    c.setDeadline(Date.now());
    expect((await execute(c, { action: "list" })).isError).toBe(true);
  });

  it.each(["connect", "call"] as const)("cancels in-flight %s and refuses operations after disposal", async (action) => {
    const server = await stub({ fault: "timeout", faultStep: action === "connect" ? "initialize" : "tools/call" });
    const c = await client();
    if (action === "call") await connect(c, server.url);
    const controller = new AbortController();
    const pending = execute(c, action === "connect" ? { action, server: "docs", url: server.url } : { action, server: "docs", tool: "sample-tool" }, controller.signal);
    setTimeout(() => controller.abort(), 30);
    expect((await pending).isError).toBe(true);
    c.dispose();
    expect(text(await execute(c, { action: "list" }))).toContain("disposed");
  });

  it("disposal alone aborts an outstanding handshake", async () => {
    const server = await stub({ fault: "timeout" }); const c = await client();
    const pending = execute(c, { action: "connect", server: "docs", url: server.url });
    setTimeout(() => c.dispose(), 30);
    expect((await pending).isError).toBe(true);
  });

  it("refuses guarded secrets in URLs and call arguments before external effects", async () => {
    const secret = "guarded-outbound-canary-987654";
    const server = await stub(); const c = await client({ guardedSecrets: [{ label: "canary", value: secret }] });
    await expect(execute(c, { action: "connect", server: "docs", url: `${server.url}?key=${secret}` })).rejects.toMatchObject({ code: "secret-quarantine" });
    expect(server.requests).toHaveLength(0);
    await connect(c, server.url);
    await expect(execute(c, { action: "call", server: "docs", tool: "sample-tool", arguments: { secret } })).rejects.toMatchObject({ code: "secret-quarantine" });
    expect(server.requests.filter((request) => request.method === "tools/call")).toHaveLength(0);
  });

  it("sanitizes schemas and results before bounding UTF-8 output", async () => {
    const secret = "guarded-result-canary-987654";
    const server = await stub({ tools: [{ name: "sample-tool", description: secret, inputSchema: { type: "object", description: secret } }], responses: { "sample-tool": { text: secret + "文".repeat(40_000) } } });
    const c = await client({ guardedSecrets: [{ label: "canary", value: secret }] }); await connect(c, server.url);
    const list = await execute(c, { action: "list", server: "docs" });
    expect(text(list)).not.toContain(secret); expect(list.details.redactions).toBeGreaterThan(0);
    const result = await execute(c, { action: "call", server: "docs", tool: "sample-tool" });
    expect(text(result)).not.toContain(secret); expect(text(result)).not.toContain("�");
    expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(MCP_MAX_RESULT_TEXT_BYTES + 20);
    expect(result.details.truncated).toBe(true);
    expect(c.getRedactionCount()).toBeGreaterThan(0);
  });

  it("bounds oversized discovered schemas returned by list", async () => {
    const server = await stub({ tools: [{ name: "sample-tool", inputSchema: { type: "object", description: "x".repeat(90_000) } }] });
    const c = await client(); await connect(c, server.url);
    expect((await execute(c, { action: "list", server: "docs" })).details.truncated).toBe(true);
  });

  it("sanitizes both agent errors and required readiness errors", async () => {
    const secret = "guarded-error-canary-987654";
    const server = await stub({ fault: "jsonrpc-error", faultErrorMessage: secret });
    const options = { guardedSecrets: [{ label: "canary", value: secret }] };
    const c = await client(options);
    expect(JSON.stringify(await execute(c, { action: "connect", server: "docs", url: server.url }))).not.toContain(secret);
    await expect(client({ ...options, conditionId: "treatment", bundle: bundle(server.url) })).rejects.not.toThrow(secret);
  });

  it("fails hard if guarded content survives redaction", async () => {
    const secret = "surviving-canary-987654";
    const server = await stub({ responses: { "sample-tool": { text: secret } } });
    const c = await client({ guardedSecrets: [{ label: "canary", value: secret }] }); await connect(c, server.url);
    vi.spyOn(secretScan, "redactSecrets").mockImplementation((value) => ({ text: value, count: 0, redactions: [] }));
    await expect(execute(c, { action: "call", server: "docs", tool: "sample-tool" })).rejects.toMatchObject({ code: "secret-quarantine" });
  });
});
