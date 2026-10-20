import { redactSecrets, scanForSecrets } from "../../core/secret-scan.mjs";
import { EvalError } from "../../core/types.mjs";
import { MCP_HANDSHAKE_TIMEOUT_MS, MCP_MAX_RESPONSE_BYTES, MCP_MAX_RESULT_TEXT_BYTES, MCP_MAX_TOOLS, MCP_PROTOCOL_VERSION, MCP_TOOL_NAME_PATTERN, openMcpSession, truncateUtf8, } from "./mcp-http-client.mjs";
export const MCP_CALL_TIMEOUT_MS = 30_000;
export const MCP_CLEANUP_RESERVE_MS = 3000;
export const MCP_MAX_SERVERS = 4;
export const MCP_CLIENT_TOOL_NAME = "mcp";
// The complete advertised interface is constant: never interpolate arm-specific seeds here.
export const MCP_CLIENT_TOOL = {
    name: MCP_CLIENT_TOOL_NAME,
    label: "MCP client",
    description: "Connect to an unauthenticated Streamable HTTP MCP server and use its tools. Use action=list without server to see configured servers; action=connect with server and url to connect; action=list with server to inspect its discovered tool schemas; action=call with server, tool, and arguments to invoke a tool. HTTP/HTTPS only; no stdio, OAuth, or custom authentication headers. Connections are private to this session.",
    promptSnippet: "Use mcp to connect to Streamable HTTP servers, discover tool schemas, and call their tools.",
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: ["connect", "list", "call"] },
            server: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
            url: { type: "string", maxLength: 8192 },
            tool: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
            arguments: { type: "object", additionalProperties: true },
        },
        required: ["action"],
        additionalProperties: false,
    },
};
/** Frozen in the execution policy, separately from treatment's server declarations. */
export const MCP_CLIENT_POLICY = {
    id: "shared-mcp-client-v1",
    transport: "streamable_http",
    authentication: "none",
    protocolVersion: MCP_PROTOCOL_VERSION,
    tool: MCP_CLIENT_TOOL,
    limits: {
        servers: MCP_MAX_SERVERS, tools: MCP_MAX_TOOLS,
        responseBytes: MCP_MAX_RESPONSE_BYTES, resultTextBytes: MCP_MAX_RESULT_TEXT_BYTES,
        handshakeMs: MCP_HANDSHAKE_TIMEOUT_MS, callMs: MCP_CALL_TIMEOUT_MS,
        cleanupReserveMs: MCP_CLEANUP_RESERVE_MS,
    },
};
export async function createMcpClient(input) {
    if (input.conditionId === "baseline" && input.bundle !== null && input.bundle.servers.length > 0) {
        throw new EvalError("parity-violation", "baseline cannot receive treatment MCP server configuration", { at: "mcp-client.seeds" });
    }
    const seeds = input.conditionId === "treatment" ? input.bundle?.servers ?? [] : [];
    if (seeds.length > MCP_MAX_SERVERS)
        throw new EvalError("protocol-drift", "too many required MCP servers", { at: "mcp-client.seeds" });
    const lifetime = new AbortController();
    // A null entry reserves a connection slot before asynchronous handshakes begin.
    const sessions = new Map();
    let deadlineAtMs = input.deadlineAtMs;
    let totalRedactions = 0;
    const combinedSignal = (signal) => AbortSignal.any([
        lifetime.signal, ...(input.signal ? [input.signal] : []), ...(signal ? [signal] : []),
    ]);
    function assertOutbound(value) {
        if (scanForSecrets({ path: "mcp:arguments", content: JSON.stringify(value) }, input.guardedSecrets).length > 0) {
            throw new EvalError("secret-quarantine", "MCP arguments carried a guarded secret; the operation was refused", { at: "mcp:arguments" });
        }
    }
    function remainingTimeout(maxMs) {
        const remaining = Math.floor(deadlineAtMs - Date.now() - MCP_CLEANUP_RESERVE_MS);
        if (remaining <= 0)
            throw new Error("MCP operation refused: arm deadline budget exhausted");
        return Math.min(maxMs, remaining);
    }
    function safeResult(text, isError = false, alreadyTruncated = false) {
        const redacted = redactSecrets(text, input.guardedSecrets, "mcp:result");
        if (scanForSecrets({ path: "mcp:result", content: redacted.text }, input.guardedSecrets).length > 0) {
            throw new EvalError("secret-quarantine", "MCP result contained a surviving guarded secret", { at: "mcp:result" });
        }
        totalRedactions += redacted.count;
        const bounded = truncateUtf8(redacted.text, MCP_MAX_RESULT_TEXT_BYTES);
        return {
            content: [{ type: "text", text: bounded.text }],
            details: { isError, truncated: alreadyTruncated || bounded.truncated, redactions: redacted.count, ...(isError ? { error: bounded.text } : {}) },
            isError,
        };
    }
    function name(value, field) {
        if (typeof value !== "string" || !MCP_TOOL_NAME_PATTERN.test(value))
            throw new Error(`MCP ${field} must be a valid name`);
        return value;
    }
    async function connect(server, url, signal, required = false) {
        name(server, "server");
        if (typeof url !== "string" || url.length > 8192)
            throw new Error("MCP connect requires a URL of at most 8192 characters");
        assertOutbound({ server, url });
        const existing = sessions.get(server);
        if (existing) {
            if (existing.url !== url)
                throw new Error("MCP server name is already connected to a different URL");
            return existing.session;
        }
        if (sessions.has(server))
            throw new Error("MCP server connection is already in progress");
        if (sessions.size >= MCP_MAX_SERVERS)
            throw new Error(`MCP connection limit of ${MCP_MAX_SERVERS} reached`);
        const operationSignal = combinedSignal(signal);
        operationSignal.throwIfAborted();
        sessions.set(server, null);
        let opened;
        try {
            opened = await openMcpSession({ serverName: server, url, signal: operationSignal, handshakeTimeoutMs: remainingTimeout(MCP_HANDSHAKE_TIMEOUT_MS) });
            operationSignal.throwIfAborted();
            if (required && opened.tools.length === 0)
                throw new Error(`Required MCP server "${server}" declared zero tools`);
            const totalTools = [...sessions.values()].reduce((total, item) => total + (item?.session.tools.length ?? 0), opened.tools.length);
            if (totalTools > MCP_MAX_TOOLS)
                throw new Error(`MCP discovered tool limit of ${MCP_MAX_TOOLS} exceeded`);
            sessions.set(server, { url, session: opened });
            return opened;
        }
        catch (error) {
            sessions.delete(server);
            await opened?.close();
            throw error;
        }
    }
    function dispose() {
        // Synchronous abort stops pending handshakes and calls before terminal cleanup returns.
        lifetime.abort(new Error("MCP client disposed"));
        for (const item of sessions.values())
            if (item)
                void item.session.close().catch(() => { });
        sessions.clear();
    }
    const definition = {
        ...MCP_CLIENT_TOOL,
        parameters: MCP_CLIENT_TOOL.parameters,
        async execute(_id, params, signal) {
            try {
                combinedSignal(signal).throwIfAborted();
                remainingTimeout(MCP_CALL_TIMEOUT_MS);
                assertOutbound(params ?? null);
                if (!params || typeof params !== "object" || Array.isArray(params))
                    throw new Error("MCP arguments must be an object");
                if (params.action === "connect") {
                    const server = name(params.server, "server");
                    const session = await connect(server, params.url, signal);
                    return safeResult(JSON.stringify({ server, tools: session.tools.map((tool) => tool.name) }));
                }
                if (params.action === "list" && params.server === undefined) {
                    return safeResult(JSON.stringify({ servers: [...sessions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([server, item]) => ({ server, status: item ? "connected" : "connecting" })) }));
                }
                const server = name(params.server, "server");
                const item = sessions.get(server);
                if (!item)
                    throw new Error(`MCP server "${server}" is not connected; use connect first`);
                if (params.action === "list")
                    return safeResult(JSON.stringify({ server, tools: item.session.tools }));
                if (params.action !== "call")
                    throw new Error("MCP action must be connect, list, or call");
                const tool = name(params.tool, "tool");
                if (!item.session.tools.some((entry) => entry.name === tool))
                    throw new Error(`MCP tool "${tool}" was not discovered on server "${server}"`);
                if (params.arguments !== undefined && (!params.arguments || typeof params.arguments !== "object" || Array.isArray(params.arguments)))
                    throw new Error("MCP call arguments must be an object");
                const result = await item.session.callTool(tool, params.arguments ?? {}, { timeoutMs: remainingTimeout(MCP_CALL_TIMEOUT_MS), signal: combinedSignal(signal) });
                return safeResult(result.text, result.isError, result.truncated);
            }
            catch (error) {
                if (error instanceof EvalError && error.code === "secret-quarantine")
                    throw error;
                return safeResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
            }
        },
    };
    try {
        for (const server of seeds) {
            if (server.transport !== "streamable_http")
                throw new Error("Required MCP transport must be streamable_http");
            await connect(server.name, server.url, undefined, true);
        }
    }
    catch (error) {
        dispose();
        if (error instanceof EvalError && error.code === "secret-quarantine")
            throw error;
        const safe = safeResult(error instanceof Error ? error.message : String(error), true);
        throw new EvalError("protocol-drift", safe.content.filter((block) => block.type === "text").map((block) => block.text).join(""), { at: "mcp-client.seeds" });
    }
    return {
        definition, seededServers: Object.freeze(seeds.map((server) => server.name).sort()),
        setDeadline: (atMs) => { deadlineAtMs = atMs; }, dispose, getRedactionCount: () => totalRedactions,
    };
}
