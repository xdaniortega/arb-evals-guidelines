/**
 * Minimal MCP client over streamable HTTP.
 *
 * - Pure streamable-HTTP JSON-RPC 2.0 client for Model Context Protocol.
 * - Enforces zero-credential invariant: NEVER sends an Authorization header,
 *   API keys, or credentials, and never reads process.env.
 * - Streams responses chunk-by-chunk and aborts immediately if MCP_MAX_RESPONSE_BYTES is exceeded.
 * - Enforces MCP_MAX_RESULT_TEXT_BYTES on tool call text, truncating cleanly on UTF-8 boundaries.
 * - Supports both application/json and text/event-stream (SSE) response shapes.
 * - Security boundary: this client operates inside the isolated guest environment
 *   (or unit tests) with public egress policy, never accessing local secrets.
 */
import { EvalError } from "../../core/types.mjs";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_MAX_RESPONSE_BYTES = 512 * 1024; // 512 KiB
export const MCP_MAX_RESULT_TEXT_BYTES = 64 * 1024; // 64 KiB
export const MCP_TRUNCATION_MARKER = "[truncated]";
export const MCP_HANDSHAKE_TIMEOUT_MS = 15_000;
export const MCP_MAX_TOOLS = 16;
export const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
export class McpProvisionError extends EvalError {
    constructor(code, message, options) {
        super(code, message, { at: options?.at ?? "mcp-provision", cause: options?.cause });
        this.name = "McpProvisionError";
    }
}
export class McpCallError extends EvalError {
    constructor(code, message, options) {
        super(code, message, { at: options?.at ?? "mcp-call", cause: options?.cause });
        this.name = "McpCallError";
    }
}
/**
 * Truncates UTF-8 text to maxBytes without slicing across multibyte code point boundaries.
 * Appends MCP_TRUNCATION_MARKER if truncated.
 */
export function truncateUtf8(text, maxBytes) {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength <= maxBytes) {
        return { text, truncated: false };
    }
    let end = maxBytes;
    let i = end - 1;
    while (i >= 0 && i >= end - 4) {
        const byte = bytes[i];
        if (byte < 0x80) {
            break;
        }
        if ((byte & 0xc0) === 0xc0) {
            let seqLen = 0;
            if ((byte & 0xe0) === 0xc0)
                seqLen = 2;
            else if ((byte & 0xf0) === 0xe0)
                seqLen = 3;
            else if ((byte & 0xf8) === 0xf0)
                seqLen = 4;
            if (i + seqLen > end) {
                end = i;
            }
            break;
        }
        i--;
    }
    const truncatedSlice = bytes.subarray(0, end);
    const truncatedText = Buffer.from(truncatedSlice).toString("utf8");
    return {
        text: `${truncatedText}${MCP_TRUNCATION_MARKER}`,
        truncated: true,
    };
}
/**
 * Truncates server-derived fragments to at most maxLen characters before interpolation into error messages.
 */
export function clampServerString(value, maxLen = 200) {
    const str = typeof value === "string" ? value : String(value ?? "");
    return str.length > maxLen ? str.slice(0, maxLen) : str;
}
function makeError(ctx, message, options = {}) {
    const code = options.code ?? "protocol-drift";
    const fullMessage = `MCP server "${ctx.serverName}" failed at step "${ctx.step}": ${message}`;
    return ctx.isProvision
        ? new McpProvisionError(code, fullMessage, { cause: options.cause })
        : new McpCallError(code, fullMessage, { cause: options.cause });
}
async function parseResponseBody(response, ctx) {
    // Notifications expect no response body or JSON-RPC result; short-circuit before content-type check.
    if (ctx.expectedId === null) {
        if (response.body) {
            await response.body.cancel().catch(() => { });
        }
        return {};
    }
    const rawContentType = response.headers.get("content-type") ?? "";
    const contentType = rawContentType.toLowerCase().split(";")[0]?.trim() ?? "";
    if (contentType !== "application/json" && contentType !== "text/event-stream") {
        if (response.body) {
            await response.body.cancel().catch(() => { });
        }
        throw makeError(ctx, `unsupported content-type "${clampServerString(contentType)}" (expected application/json or text/event-stream)`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
        throw makeError(ctx, "empty response body");
    }
    if (contentType === "application/json") {
        const chunks = [];
        let totalBytes = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (value) {
                    totalBytes += value.byteLength;
                    if (totalBytes > MCP_MAX_RESPONSE_BYTES) {
                        await reader.cancel().catch(() => { });
                        throw makeError(ctx, `response exceeded byte cap of ${MCP_MAX_RESPONSE_BYTES} bytes`);
                    }
                    chunks.push(value);
                }
            }
        }
        catch (err) {
            await reader.cancel().catch(() => { });
            throw err;
        }
        if (ctx.expectedId === null) {
            return {};
        }
        const combined = Buffer.concat(chunks);
        let parsed;
        try {
            parsed = JSON.parse(combined.toString("utf8"));
        }
        catch (cause) {
            throw makeError(ctx, "malformed JSON response", { cause });
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw makeError(ctx, "response is not a JSON object");
        }
        if (parsed.id !== ctx.expectedId) {
            throw makeError(ctx, `response id mismatch (expected ${ctx.expectedId}, received ${clampServerString(parsed.id)})`);
        }
        if (parsed.error !== undefined && parsed.error !== null) {
            const errorObj = parsed.error;
            const errorMsg = typeof errorObj === "object" && errorObj !== null && typeof errorObj.message === "string"
                ? `${clampServerString(errorObj.message)} (code ${clampServerString(errorObj.code, 40)})`
                : clampServerString(JSON.stringify(errorObj));
            throw makeError(ctx, `server returned JSON-RPC error: ${errorMsg}`);
        }
        return parsed;
    }
    // Handle text/event-stream (SSE)
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let dataLines = [];
    let totalBytes = 0;
    let matchedFrame = null;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (value) {
                totalBytes += value.byteLength;
                if (totalBytes > MCP_MAX_RESPONSE_BYTES) {
                    await reader.cancel().catch(() => { });
                    throw makeError(ctx, `response exceeded byte cap of ${MCP_MAX_RESPONSE_BYTES} bytes`);
                }
                buffer += decoder.decode(value, { stream: true });
            }
            let lineEndIndex;
            while ((lineEndIndex = buffer.indexOf("\n")) !== -1) {
                let line = buffer.slice(0, lineEndIndex);
                buffer = buffer.slice(lineEndIndex + 1);
                if (line.endsWith("\r")) {
                    line = line.slice(0, -1);
                }
                if (line.startsWith(":")) {
                    // SSE comment
                    continue;
                }
                if (line.startsWith("event:") || line.startsWith("id:") || line.startsWith("retry:")) {
                    // SSE metadata lines to ignore
                    continue;
                }
                if (line.startsWith("data:")) {
                    let data = line.slice(5);
                    if (data.startsWith(" ")) {
                        data = data.slice(1);
                    }
                    dataLines.push(data);
                    continue;
                }
                if (line === "") {
                    // End of SSE event frame
                    if (dataLines.length > 0) {
                        const rawData = dataLines.join("\n");
                        dataLines = [];
                        // Tolerate SSE heartbeats: skip empty or whitespace data frames
                        if (rawData.trim() === "") {
                            continue;
                        }
                        let frame;
                        try {
                            frame = JSON.parse(rawData);
                        }
                        catch (cause) {
                            await reader.cancel().catch(() => { });
                            throw makeError(ctx, "malformed JSON in SSE data frame", { cause });
                        }
                        if (ctx.expectedId !== null && typeof frame === "object" && frame !== null) {
                            if (frame.id !== undefined && frame.id !== null) {
                                if (frame.id === ctx.expectedId) {
                                    matchedFrame = frame;
                                    await reader.cancel().catch(() => { });
                                    break;
                                }
                                else {
                                    await reader.cancel().catch(() => { });
                                    throw makeError(ctx, `response id mismatch (expected ${ctx.expectedId}, received ${clampServerString(frame.id)})`);
                                }
                            }
                        }
                    }
                }
            }
            if (matchedFrame !== null) {
                break;
            }
        }
        // Flush any trailing event
        if (matchedFrame === null && dataLines.length > 0) {
            const rawData = dataLines.join("\n");
            if (rawData.trim() !== "") {
                let frame;
                try {
                    frame = JSON.parse(rawData);
                }
                catch (cause) {
                    throw makeError(ctx, "malformed JSON in SSE data frame", { cause });
                }
                if (ctx.expectedId !== null && typeof frame === "object" && frame !== null) {
                    if (frame.id === ctx.expectedId) {
                        matchedFrame = frame;
                    }
                    else if (frame.id !== undefined && frame.id !== null) {
                        throw makeError(ctx, `response id mismatch (expected ${ctx.expectedId}, received ${clampServerString(frame.id)})`);
                    }
                }
            }
        }
    }
    finally {
        await reader.cancel().catch(() => { });
    }
    // Notifications already returned above; a result-bearing response never reaches here
    // without an expected id.
    if (matchedFrame === null) {
        throw makeError(ctx, `stream ended without response matching id ${ctx.expectedId}`);
    }
    if (matchedFrame.error !== undefined && matchedFrame.error !== null) {
        const errorObj = matchedFrame.error;
        const errorMsg = typeof errorObj === "object" && errorObj !== null && typeof errorObj.message === "string"
            ? `${clampServerString(errorObj.message)} (code ${clampServerString(errorObj.code, 40)})`
            : clampServerString(JSON.stringify(errorObj));
        throw makeError(ctx, `server returned JSON-RPC error: ${errorMsg}`);
    }
    return matchedFrame;
}
async function sendJsonRpcRequest(url, payload, sessionId, ctx, signal, callerSignal, timeoutSignal) {
    const headers = {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    };
    if (sessionId !== null) {
        headers["mcp-session-id"] = sessionId;
    }
    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal,
        });
    }
    catch (error) {
        if (callerSignal?.aborted) {
            throw makeError(ctx, "operation cancelled by caller", { code: "interrupted", cause: error });
        }
        if (timeoutSignal.aborted || error?.name === "TimeoutError") {
            throw makeError(ctx, "request timed out", { cause: error });
        }
        throw makeError(ctx, `network request failed: ${clampServerString(error?.message ?? String(error))}`, { cause: error });
    }
    const newSessionId = response.headers.get("mcp-session-id");
    if (!response.ok) {
        if (response.body) {
            await response.body.cancel().catch(() => { });
        }
        const statusDetails = response.statusText ? ` ${clampServerString(response.statusText)}` : "";
        throw makeError(ctx, `HTTP error ${response.status}${statusDetails}`);
    }
    let responseData;
    try {
        responseData = await parseResponseBody(response, ctx);
    }
    catch (error) {
        if (callerSignal?.aborted) {
            throw makeError(ctx, "operation cancelled by caller", { code: "interrupted", cause: error });
        }
        if (timeoutSignal.aborted || error?.name === "TimeoutError") {
            throw makeError(ctx, "response read timed out", { cause: error });
        }
        if (error instanceof EvalError) {
            throw error;
        }
        const rawMsg = error?.message ?? String(error);
        throw makeError(ctx, `response stream failed: ${clampServerString(rawMsg)}`, { cause: error });
    }
    return { responseData, newSessionId };
}
export async function openMcpSession(input) {
    if (typeof input !== "object" || input === null) {
        throw new McpProvisionError("input-invalid", "input must be an object");
    }
    if (typeof input.serverName !== "string" || input.serverName.trim() === "") {
        throw new McpProvisionError("input-invalid", "serverName must be a non-empty string");
    }
    let parsedUrl;
    try {
        parsedUrl = new URL(input.url);
    }
    catch {
        throw new McpProvisionError("input-invalid", `MCP server "${input.serverName}" failed at step "input-validation": invalid URL`);
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new McpProvisionError("input-invalid", `MCP server "${input.serverName}" failed at step "input-validation": URL protocol must be http: or https:`);
    }
    if (parsedUrl.username !== "" || parsedUrl.password !== "") {
        throw new McpProvisionError("input-invalid", `MCP server "${input.serverName}" failed at step "input-validation": URL must not contain credentials`);
    }
    const handshakeTimeoutMs = input.handshakeTimeoutMs ?? MCP_HANDSHAKE_TIMEOUT_MS;
    if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs <= 0) {
        throw new McpProvisionError("input-invalid", `MCP server "${input.serverName}" failed at step "input-validation": handshakeTimeoutMs must be a positive safe integer`);
    }
    if (input.signal?.aborted) {
        throw new McpProvisionError("interrupted", `MCP server "${input.serverName}" failed at step "initialize": cancelled by caller`);
    }
    // MCP_HANDSHAKE_TIMEOUT_MS is one shared budget across initialize + notifications/initialized + tools/list, not a per-request timeout.
    const timeoutSignal = AbortSignal.timeout(handshakeTimeoutMs);
    const combinedSignal = input.signal
        ? AbortSignal.any([input.signal, timeoutSignal])
        : timeoutSignal;
    let nextId = 1;
    let sessionId = null;
    // Step 1: initialize
    const initId = nextId++;
    const initPayload = {
        jsonrpc: "2.0",
        id: initId,
        method: "initialize",
        params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
                name: "arbitrum-eval-pi",
                version: "1.0.0",
            },
        },
    };
    const initCtx = {
        serverName: input.serverName,
        step: "initialize",
        expectedId: initId,
        isProvision: true,
    };
    const initResult = await sendJsonRpcRequest(input.url, initPayload, sessionId, initCtx, combinedSignal, input.signal, timeoutSignal);
    if (initResult.newSessionId !== null && initResult.newSessionId.trim() !== "") {
        sessionId = initResult.newSessionId;
    }
    if (typeof initResult.responseData.result !== "object" || initResult.responseData.result === null) {
        throw makeError(initCtx, "initialize response missing result object");
    }
    // Step 2: notifications/initialized (notification: no id, no response expected)
    const notifPayload = {
        jsonrpc: "2.0",
        method: "notifications/initialized",
    };
    const notifCtx = {
        serverName: input.serverName,
        step: "notifications/initialized",
        expectedId: null,
        isProvision: true,
    };
    await sendJsonRpcRequest(input.url, notifPayload, sessionId, notifCtx, combinedSignal, input.signal, timeoutSignal);
    // Step 3: tools/list
    const listId = nextId++;
    const listPayload = {
        jsonrpc: "2.0",
        id: listId,
        method: "tools/list",
        params: {},
    };
    const listCtx = {
        serverName: input.serverName,
        step: "tools/list",
        expectedId: listId,
        isProvision: true,
    };
    const listResult = await sendJsonRpcRequest(input.url, listPayload, sessionId, listCtx, combinedSignal, input.signal, timeoutSignal);
    const rawTools = listResult.responseData.result?.tools;
    if (!Array.isArray(rawTools)) {
        throw makeError(listCtx, "tools/list result.tools must be an array");
    }
    if (rawTools.length > MCP_MAX_TOOLS) {
        throw makeError(listCtx, `server returned ${rawTools.length} tools, exceeding maximum allowed of ${MCP_MAX_TOOLS}`);
    }
    const seenNames = new Set();
    const discoveredTools = [];
    for (const rawTool of rawTools) {
        if (typeof rawTool !== "object" || rawTool === null) {
            throw makeError(listCtx, "tool entry must be an object");
        }
        const name = rawTool.name;
        if (typeof name !== "string" || !MCP_TOOL_NAME_PATTERN.test(name)) {
            throw makeError(listCtx, `invalid tool name: "${clampServerString(name)}"`);
        }
        if (seenNames.has(name)) {
            throw makeError(listCtx, `duplicate tool name: "${clampServerString(name)}"`);
        }
        seenNames.add(name);
        const description = typeof rawTool.description === "string" ? rawTool.description : null;
        discoveredTools.push({
            name,
            description,
            inputSchema: rawTool.inputSchema ?? null,
        });
    }
    // Sort tools ascending by name
    discoveredTools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const frozenTools = Object.freeze(discoveredTools.map((t) => Object.freeze(t)));
    let closed = false;
    return {
        serverName: input.serverName,
        tools: frozenTools,
        async callTool(name, args, options) {
            if (closed) {
                throw new McpCallError("protocol-drift", `MCP server "${input.serverName}" failed at step "tools/call": session is closed`);
            }
            if (typeof name !== "string" || !MCP_TOOL_NAME_PATTERN.test(name)) {
                throw new McpCallError("input-invalid", `MCP server "${input.serverName}" failed at step "tools/call": invalid tool name "${clampServerString(name)}"`);
            }
            if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
                throw new McpCallError("input-invalid", `MCP server "${input.serverName}" failed at step "tools/call": timeoutMs must be a positive safe integer`);
            }
            if (options.signal?.aborted) {
                throw new McpCallError("interrupted", `MCP server "${input.serverName}" failed at step "tools/call": operation cancelled by caller`);
            }
            const callTimeoutSignal = AbortSignal.timeout(options.timeoutMs);
            const callCombinedSignal = options.signal
                ? AbortSignal.any([options.signal, callTimeoutSignal])
                : callTimeoutSignal;
            const callId = nextId++;
            const callPayload = {
                jsonrpc: "2.0",
                id: callId,
                method: "tools/call",
                params: {
                    name,
                    arguments: typeof args === "object" && args !== null ? args : {},
                },
            };
            const callCtx = {
                serverName: input.serverName,
                step: "tools/call",
                expectedId: callId,
                isProvision: false,
            };
            const callResult = await sendJsonRpcRequest(input.url, callPayload, sessionId, callCtx, callCombinedSignal, options.signal, callTimeoutSignal);
            if (callResult.newSessionId !== null && callResult.newSessionId.trim() !== "") {
                sessionId = callResult.newSessionId;
            }
            const resultObj = callResult.responseData.result;
            if (typeof resultObj !== "object" || resultObj === null) {
                throw makeError(callCtx, "tools/call response missing result object");
            }
            let concatenatedText = "";
            if (Array.isArray(resultObj.content)) {
                for (const item of resultObj.content) {
                    if (typeof item === "object" && item !== null && item.type === "text" && typeof item.text === "string") {
                        concatenatedText += item.text;
                    }
                }
            }
            const isError = Boolean(resultObj.isError);
            const truncated = truncateUtf8(concatenatedText, MCP_MAX_RESULT_TEXT_BYTES);
            return {
                text: truncated.text,
                isError,
                truncated: truncated.truncated,
            };
        },
        async close() {
            closed = true;
        },
    };
}
