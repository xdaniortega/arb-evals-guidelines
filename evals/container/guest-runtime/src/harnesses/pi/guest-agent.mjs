#!/usr/bin/env node
import { scheduleTimeout } from "../../core/timing.mjs";
/**
 * Image-resident framed Pi SDK agent.
 *
 * This is compiled from the same sdk-session.ts used by L1. Configuration and the
 * prompt are separate bounded stdin frames so the host can hold the pair at its
 * readiness barrier. stdout contains only bounded, sanitized protocol frames.
 */
import { unlinkSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeSessionCapture, NATIVE_PREFIX_MAX_RECORD_BYTES, NATIVE_PREFIX_MAX_RECORDS, NATIVE_PREFIX_MAX_TOTAL_BYTES } from "../../artifacts/native-prefix.mjs";
import { redactSecrets, scanForSecrets } from "../../core/secret-scan.mjs";
import { canonicalJson } from "../../core/experiment.mjs";
import { CONDITION_OPERATION_ALLOWANCE_MS, deriveStopCause, resolveGuestTimeouts, } from "../../core/types.mjs";
import { createPiSdkSession } from "./sdk-session.mjs";
import { buildAmbientTools } from "./ambient-tools.mjs";
import { createScriptedStreamSimple } from "./scripted-stream.mjs";
import { installCompletionTransportBlocker } from "../../transport-blocker.mjs";
const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_PENDING_INPUT_FRAMES = 32;
const MAX_PENDING_INPUT_BYTES = 2 * 1024 * 1024;
const CREDENTIAL_TIMEOUT_MS = 5_000;
const ABORT_SETTLE_MS = 2_000;
const MAX_PROCESS_LIFETIME_MS = 180_000;
// Bound a child before it receives a validated init. Once initialized, the readiness
// barrier also allows its sibling's setup, serial prompt, capture and cleanup.
const MAX_PRE_PROMPT_MS = CONDITION_OPERATION_ALLOWANCE_MS;
const SYNTHETIC_KEY = "synthetic-scripted-eval-key";
// Cancellation messages emitted by a provider or the SDK when an abort we requested
// lands. Anchored at both ends so a decorated failure such as
// "This operation was aborted: upstream failure" is NOT treated as a clean cancellation.
const KNOWN_ABORT_MESSAGE = /^(?:abort(?:error)?: )?(?:this )?(?:operation|request|sdk prompt)(?: was)? aborted\.?$/i;
function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function knownFields(value, allowed, at) {
    const allowedSet = new Set(allowed);
    for (const key of Object.keys(value)) {
        if (!allowedSet.has(key))
            throw new Error(`${at} contains an unknown field`);
    }
}
function nonEmptyString(value, at) {
    if (typeof value !== "string" || value === "")
        throw new Error(`${at} must be a non-empty string`);
    return value;
}
function parseSteps(value) {
    if (!Array.isArray(value))
        throw new Error("init.scriptedSteps must be an array");
    return value.map((raw, index) => {
        if (!object(raw))
            throw new Error(`init.scriptedSteps[${index}] must be an object`);
        const type = raw.type;
        if (type === "text") {
            knownFields(raw, ["type", "text", "usage", "stopReason"], `init.scriptedSteps[${index}]`);
            nonEmptyString(raw.text, `init.scriptedSteps[${index}].text`);
        }
        else if (type === "toolCall") {
            knownFields(raw, ["type", "toolCalls", "usage", "stopReason"], `init.scriptedSteps[${index}]`);
            if (!Array.isArray(raw.toolCalls) || raw.toolCalls.length === 0)
                throw new Error(`init.scriptedSteps[${index}].toolCalls must be non-empty`);
            for (const [toolIndex, call] of raw.toolCalls.entries()) {
                if (!object(call))
                    throw new Error(`scripted tool call ${toolIndex} must be an object`);
                knownFields(call, ["id", "name", "arguments"], `scripted tool call ${toolIndex}`);
                nonEmptyString(call.name, `scripted tool call ${toolIndex}.name`);
                if (!object(call.arguments))
                    throw new Error(`scripted tool call ${toolIndex}.arguments must be an object`);
            }
        }
        else if (type === "thinking") {
            knownFields(raw, ["type", "thinking", "text", "signature", "usage", "stopReason"], `init.scriptedSteps[${index}]`);
            nonEmptyString(raw.thinking, `init.scriptedSteps[${index}].thinking`);
            if (typeof raw.text !== "string")
                throw new Error(`init.scriptedSteps[${index}].text must be a string`);
        }
        else if (type === "error") {
            knownFields(raw, ["type", "errorMessage", "stopReason"], `init.scriptedSteps[${index}]`);
            nonEmptyString(raw.errorMessage, `init.scriptedSteps[${index}].errorMessage`);
        }
        else if (type === "stop") {
            knownFields(raw, ["type", "stopReason", "text", "usage"], `init.scriptedSteps[${index}]`);
            nonEmptyString(raw.stopReason, `init.scriptedSteps[${index}].stopReason`);
            if (raw.text !== undefined && typeof raw.text !== "string")
                throw new Error(`init.scriptedSteps[${index}].text must be a string`);
        }
        else {
            throw new Error(`init.scriptedSteps[${index}] has unknown type`);
        }
        return structuredClone(raw);
    });
}
/**
 * @notice Rejects invalid guest initialization before credentials or prompts are accepted.
 * @param value Untrusted initialization frame received from the host.
 * @returns A validated frame with canonical nullable task budgets.
 */
export function parseInit(value) {
    knownFields(value, ["type", "protocolVersion", "mode", "arm", "target", "skillPath", "allowedTools", "ambientTools", "processLifetimeMs", "armWallClockMs", "limits", "credentialVariable", "captureReasoning", "scriptedSteps", "skillToolBundle", "skillToolBundleSha256"], "init");
    if (value.protocolVersion !== PROTOCOL_VERSION)
        throw new Error("unsupported guest agent protocolVersion");
    if (value.mode !== "measured" && value.mode !== "scripted")
        throw new Error("init.mode must be measured or scripted");
    if (value.arm !== "baseline" && value.arm !== "treatment")
        throw new Error("init.arm must be baseline or treatment");
    if (!object(value.target))
        throw new Error("init.target must be an object");
    knownFields(value.target, ["provider", "model", "thinking"], "init.target");
    const target = {
        provider: nonEmptyString(value.target.provider, "init.target.provider"),
        model: nonEmptyString(value.target.model, "init.target.model"),
        thinking: nonEmptyString(value.target.thinking, "init.target.thinking"),
    };
    if (!(value.skillPath === null || typeof value.skillPath === "string"))
        throw new Error("init.skillPath must be string or null");
    if (value.arm === "baseline" && value.skillPath !== null)
        throw new Error("baseline init must not carry a skillPath");
    if (value.arm === "treatment" && (typeof value.skillPath !== "string" || value.skillPath === ""))
        throw new Error("treatment init requires one skillPath");
    if (!Array.isArray(value.allowedTools) || value.allowedTools.some((tool) => typeof tool !== "string" || tool === ""))
        throw new Error("init.allowedTools must be a string array");
    if (!Array.isArray(value.ambientTools) || value.ambientTools.some((tool) => typeof tool !== "string" || !/^[a-z][a-z0-9_-]*$/.test(tool)))
        throw new Error("init.ambientTools must be an array of valid tool names");
    const ambientToolSet = new Set();
    const allowedToolSet = new Set(value.allowedTools);
    for (const tool of value.ambientTools) {
        if (ambientToolSet.has(tool))
            throw new Error("init.ambientTools contains duplicate entries");
        ambientToolSet.add(tool);
        if (!allowedToolSet.has(tool))
            throw new Error(`init.ambientTools entry '${tool}' is not in allowedTools`);
    }
    if (typeof value.skillToolBundleSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.skillToolBundleSha256)) {
        throw new Error("init.skillToolBundleSha256 must be a 64-char lowercase hex digest");
    }
    if (value.arm === "baseline") {
        if (value.skillToolBundle !== null) {
            throw new Error("baseline init must carry skillToolBundle: null");
        }
    }
    else {
        if (!object(value.skillToolBundle)) {
            throw new Error("treatment init requires a skillToolBundle object");
        }
        const bundle = value.skillToolBundle;
        knownFields(bundle, ["schemaVersion", "source", "sourceSha256", "servers"], "init.skillToolBundle");
        if (bundle.schemaVersion !== 1) {
            throw new Error("init.skillToolBundle.schemaVersion must be 1");
        }
        if (bundle.source !== null && typeof bundle.source !== "string") {
            throw new Error("init.skillToolBundle.source must be string or null");
        }
        if (bundle.sourceSha256 !== null && (typeof bundle.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(bundle.sourceSha256))) {
            throw new Error("init.skillToolBundle.sourceSha256 must be a 64-char lowercase hex digest or null");
        }
        if (!Array.isArray(bundle.servers) || bundle.servers.length > 4) {
            throw new Error("init.skillToolBundle.servers must be an array of at most 4 servers");
        }
        const servers = bundle.servers;
        for (let i = 0; i < servers.length; i++) {
            const server = servers[i];
            if (!object(server)) {
                throw new Error(`init.skillToolBundle.servers[${i}] must be an object`);
            }
            knownFields(server, ["name", "transport", "url", "description"], `init.skillToolBundle.servers[${i}]`);
            const serverName = nonEmptyString(server.name, `init.skillToolBundle.servers[${i}].name`);
            if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(serverName)) {
                throw new Error(`init.skillToolBundle.servers[${i}].name is invalid`);
            }
            if (server.transport !== "streamable_http") {
                throw new Error(`init.skillToolBundle.servers[${i}].transport must be streamable_http`);
            }
            if (typeof server.url !== "string") {
                throw new Error(`init.skillToolBundle.servers[${i}].url must be a string`);
            }
            let parsedUrl;
            try {
                parsedUrl = new URL(server.url);
            }
            catch {
                throw new Error(`init.skillToolBundle.servers[${i}].url is invalid`);
            }
            if (parsedUrl.protocol !== "https:") {
                throw new Error(`init.skillToolBundle.servers[${i}].url must use https: protocol`);
            }
            if (server.description !== null && typeof server.description !== "string") {
                throw new Error(`init.skillToolBundle.servers[${i}].description must be string or null`);
            }
            if (i > 0 && serverName <= servers[i - 1].name) {
                throw new Error("init.skillToolBundle.servers must be sorted and unique by name");
            }
        }
    }
    if (!Number.isSafeInteger(value.processLifetimeMs) || value.processLifetimeMs <= 0 || value.processLifetimeMs > MAX_PROCESS_LIFETIME_MS)
        throw new Error("init.processLifetimeMs must be a bounded positive integer");
    // `null` means unlimited (no per-arm wall-clock deadline). Any other value must be a
    // positive integer; there is no fixed maximum arm duration.
    if (value.armWallClockMs !== null && (!Number.isSafeInteger(value.armWallClockMs) || value.armWallClockMs <= 0))
        throw new Error("init.armWallClockMs must be a positive integer or null (unlimited)");
    if (!object(value.limits))
        throw new Error("init.limits must be an object");
    knownFields(value.limits, ["maxProviderRequests", "maxToolSteps", "maxOutputTokens"], "init.limits");
    for (const name of ["maxProviderRequests", "maxToolSteps", "maxOutputTokens"]) {
        // `null` means UNLIMITED (no harness cumulative cap); any other value must be a
        // positive integer. The host normalizes 0/none to null before it reaches here.
        const limitValue = value.limits[name];
        if (limitValue !== null && (!Number.isSafeInteger(limitValue) || limitValue <= 0)) {
            throw new Error(`init.limits.${name} must be a positive integer or null (unlimited)`);
        }
    }
    const expectedVariable = target.provider === "google" ? "GEMINI_API_KEY" : target.provider === "anthropic" ? "ANTHROPIC_API_KEY" : null;
    if (expectedVariable === null || value.credentialVariable !== expectedVariable)
        throw new Error("credential variable does not match the selected provider");
    if (value.captureReasoning !== undefined && typeof value.captureReasoning !== "boolean")
        throw new Error("init.captureReasoning must be a boolean");
    if (value.mode === "measured" && value.scriptedSteps !== undefined)
        throw new Error("measured init must not carry scriptedSteps");
    if (value.mode === "scripted" && value.scriptedSteps === undefined)
        throw new Error("scripted init requires scriptedSteps JSON data");
    return {
        type: "init",
        protocolVersion: 1,
        mode: value.mode,
        arm: value.arm,
        target: target,
        skillPath: value.skillPath,
        allowedTools: [...value.allowedTools],
        ambientTools: [...value.ambientTools],
        skillToolBundle: (value.arm === "treatment" ? structuredClone(value.skillToolBundle) : null),
        skillToolBundleSha256: value.skillToolBundleSha256,
        processLifetimeMs: value.processLifetimeMs,
        armWallClockMs: value.armWallClockMs,
        limits: value.limits,
        credentialVariable: value.credentialVariable,
        ...(value.captureReasoning !== undefined ? { captureReasoning: value.captureReasoning } : {}),
        ...(value.mode === "scripted" ? { scriptedSteps: parseSteps(value.scriptedSteps) } : {}),
    };
}
async function controlRequest(controlSocket, request) {
    return await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            resolve(value);
        };
        const socket = netConnect(controlSocket);
        let bytes = 0;
        let buffer = "";
        socket.setTimeout(CREDENTIAL_TIMEOUT_MS);
        socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
        socket.on("data", (chunk) => {
            bytes += chunk.byteLength;
            if (bytes > MAX_REQUEST_BYTES) {
                socket.destroy();
                finish(null);
                return;
            }
            buffer += chunk.toString("utf8");
        });
        socket.once("timeout", () => { socket.destroy(); finish(null); });
        socket.once("error", () => finish(null));
        socket.once("close", () => {
            try {
                const frame = JSON.parse(buffer.trim());
                finish(object(frame) ? frame : null);
            }
            catch {
                finish(null);
            }
        });
    });
}
async function getCredential(controlSocket, variable) {
    const frame = await controlRequest(controlSocket, { type: "get-credential", variable });
    return frame?.ok === true && frame.variable === variable && typeof frame.value === "string" ? frame.value : null;
}
async function registerTaskProcess(controlSocket) {
    const frame = await controlRequest(controlSocket, { type: "register-task-process", callerPid: process.pid });
    if (frame?.ok !== true)
        throw new Error("guest supervisor could not register the task process boundary");
}
async function stopTaskDescendants(controlSocket) {
    const frame = await controlRequest(controlSocket, { type: "quiesce-task-processes", callerPid: process.pid });
    if (frame?.ok !== true || frame.streamingStopped !== true || frame.descendantsStopped !== true || frame.remaining !== 0) {
        throw new Error("guest supervisor could not verify task descendant quiescence");
    }
}
/**
 * @notice Executes the guest-side Pi agent process inside a container using framed protocol messages and just-in-time credential access.
 * @param options Execution options containing the UNIX domain control socket path for supervisor communication.
 * @dev Enforces redaction and byte limits on all emitted frames, fetches credentials dynamically over the control socket, and verifies descendant process quiescence before completing.
 */
export async function runGuestAgent(options) {
    let state = "empty";
    let instance = null;
    let capture = null;
    let init = null;
    let secrets = [];
    let restoreCredentialEnvironment = null;
    let fatal = false;
    let outputBytes = 0;
    let nativeRecords = 0;
    let emittedEntries = 0;
    let emittedRedactions = 0;
    let promptSettlement = null;
    let semanticAbortCause = null;
    let prePromptTimer = null;
    let lifetimeTimer = null;
    const pendingNative = [];
    const emitFrame = (frame) => {
        let text = JSON.stringify(frame);
        if (secrets.length > 0)
            text = redactSecrets(text, secrets, "guest-agent:stdout").text;
        if (scanForSecrets({ path: "guest-agent:stdout", content: text }, secrets).length > 0)
            throw new Error("guest agent output sanitization failed");
        const bytes = Buffer.byteLength(text) + 1;
        if (bytes > NATIVE_PREFIX_MAX_RECORD_BYTES)
            throw new Error("guest agent response frame exceeded 1 MiB");
        if (outputBytes + bytes > NATIVE_PREFIX_MAX_TOTAL_BYTES)
            throw new Error("guest agent output exceeded 16 MiB");
        outputBytes += bytes;
        process.stdout.write(`${text}\n`);
    };
    const safeError = (error) => {
        const raw = error instanceof Error ? error.message : "unknown guest agent failure";
        return redactSecrets(raw, secrets, "guest-agent:error").text.slice(0, 16_000);
    };
    const dispose = () => {
        if (state === "disposed")
            return;
        if (prePromptTimer !== null) {
            prePromptTimer.cancel();
            prePromptTimer = null;
        }
        if (lifetimeTimer !== null) {
            lifetimeTimer.cancel();
            lifetimeTimer = null;
        }
        try {
            instance?.dispose();
        }
        catch { /* terminal path */ }
        restoreCredentialEnvironment?.();
        restoreCredentialEnvironment = null;
        try {
            capture?.removeAfterSeal();
        }
        catch {
            if (capture) {
                try {
                    unlinkSync(capture.path);
                }
                catch { /* terminal path */ }
            }
        }
        instance = null;
        capture = null;
        state = "disposed";
    };
    const fail = (error) => {
        if (fatal)
            return;
        fatal = true;
        const wasStreaming = instance?.session.isStreaming === true;
        if (wasStreaming)
            instance?.session.abort();
        try {
            emitFrame({ type: "error", protocolVersion: PROTOCOL_VERSION, state, error: safeError(error), streamingStopped: wasStreaming ? false : true });
        }
        catch {
            process.stdout.write(`${JSON.stringify({ type: "error", protocolVersion: PROTOCOL_VERSION, state: "disposed", error: "bounded guest agent failure", streamingStopped: false })}\n`);
        }
        process.exitCode = 1;
        process.stdin.pause();
        if (wasStreaming) {
            setTimeout(() => { dispose(); process.exit(1); }, ABORT_SETTLE_MS).unref();
        }
        else
            dispose();
    };
    prePromptTimer = scheduleTimeout(() => fail(new Error("guest agent exceeded its pre-prompt lifetime")), MAX_PRE_PROMPT_MS);
    prePromptTimer.unref();
    const emitNewNative = () => {
        if (!capture)
            return;
        const snapshot = capture.snapshot();
        while (emittedEntries < snapshot.entries.length) {
            const entry = snapshot.entries[emittedEntries];
            const nextEntryIndex = emittedEntries + 1;
            const newRedactions = snapshot.redactions.entries.slice(emittedRedactions);
            const item = { record: entry, redactions: { count: newRedactions.reduce((sum, item) => sum + item.count, 0), entries: newRedactions } };
            emittedEntries = nextEntryIndex;
            emittedRedactions = snapshot.redactions.entries.length;
            if (state === "initializing")
                pendingNative.push(item);
            else {
                nativeRecords += 1;
                if (nativeRecords > NATIVE_PREFIX_MAX_RECORDS)
                    throw new Error("guest native record count exceeded 10000");
                emitFrame({ type: "record", protocolVersion: PROTOCOL_VERSION, sequence: nativeRecords, ...item });
            }
        }
    };
    const initialize = async (frame) => {
        if (state !== "empty")
            throw new Error("duplicate init frame");
        state = "initializing";
        init = parseInit(frame);
        // Scripted composition is synthetic even when its override is accidentally bypassed.
        // Install the shared blocker before any SDK runtime is constructed; measured mode is untouched.
        if (init.mode === "scripted")
            installCompletionTransportBlocker();
        const credential = await getCredential(options.controlSocket, init.credentialVariable);
        if (fatal)
            return;
        if (init.mode === "measured" && credential === null)
            throw new Error("selected provider credential was unavailable during initialization");
        if (credential !== null) {
            const variable = init.credentialVariable;
            secrets = [{ label: variable, value: credential }];
            // The supplied key intentionally belongs to the Pi/tool guest boundary.
            // Runtime overrides avoid auth-file persistence; tools inherit this one allowed entry.
            const previous = process.env[variable];
            process.env[variable] = credential;
            restoreCredentialEnvironment = () => {
                if (previous === undefined)
                    delete process.env[variable];
                else
                    process.env[variable] = previous;
            };
        }
        await registerTaskProcess(options.controlSocket);
        const capturePath = join(tmpdir(), `pi-eval-native-${process.pid}.jsonl`);
        capture = createNativeSessionCapture({
            path: capturePath,
            guardedSecrets: secrets,
            captureReasoning: init.captureReasoning,
        });
        const recorder = {
            record(entry) {
                capture.record(entry);
                emitNewNative();
            },
        };
        const createdInstance = await createPiSdkSession({
            cwd: process.cwd(),
            arm: init.arm,
            target: init.target,
            ...(init.skillPath === null ? {} : { skillPath: init.skillPath }),
            allowedTools: init.allowedTools,
            ambientTools: buildAmbientTools(init.ambientTools, process.cwd()),
            skillToolBundle: init.skillToolBundle,
            skillToolBundleSha256: init.skillToolBundleSha256,
            guardedSecrets: secrets,
            apiKey: credential ?? SYNTHETIC_KEY,
            budget: init.limits,
            inMemorySession: true,
            nativeSessionRecorder: recorder,
            ...(init.mode === "scripted" ? { streamSimpleOverride: createScriptedStreamSimple(init.scriptedSteps) } : {}),
        });
        if (fatal) {
            createdInstance.dispose();
            return;
        }
        instance = createdInstance;
        const entries = instance.getNativeSessionEntries();
        const header = entries[0];
        if (!header || header.type !== "session" || typeof header.id !== "string" || header.id === "")
            throw new Error("SDK session did not expose its actual native header");
        const durableHeader = pendingNative[0]?.record;
        const wireHeader = JSON.parse(JSON.stringify(header));
        if (!durableHeader || canonicalJson(durableHeader, "durable native header") !== canonicalJson(wireHeader, "SDK native header")) {
            throw new Error("SDK readiness header did not canonically match the first durable native record");
        }
        const attestation = instance.attest();
        state = "ready";
        if (prePromptTimer !== null)
            prePromptTimer.cancel();
        // An unlimited arm has no wall-clock-derived pre-prompt lifetime; do not arm the timer.
        const prePromptMs = resolveGuestTimeouts(init.armWallClockMs).prePromptMs;
        if (prePromptMs !== null) {
            prePromptTimer = scheduleTimeout(() => fail(new Error("guest agent exceeded its pre-prompt lifetime")), prePromptMs);
            prePromptTimer.unref();
        }
        emitFrame({
            type: "ready",
            protocolVersion: PROTOCOL_VERSION,
            sessionId: header.id,
            header: wireHeader,
            attestation,
            process: { platform: process.platform, pid: process.pid, uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null, cwd: process.cwd() },
        });
        for (const item of pendingNative.splice(0)) {
            nativeRecords += 1;
            emitFrame({ type: "record", protocolVersion: PROTOCOL_VERSION, sequence: nativeRecords, ...item });
        }
    };
    const settlePrompt = async (prompt) => {
        if (!instance || !capture || !init)
            throw new Error("guest agent session is unavailable");
        const startedAt = new Date().toISOString();
        const startedMs = Date.now();
        // A finite arm caps guest lifetime and arms a wall-clock watchdog. An unlimited arm
        // arms neither: it runs until it completes or is cancelled, with no hidden finite cap.
        let armTimer = null;
        if (init.armWallClockMs !== null) {
            const armWallClockMs = init.armWallClockMs;
            const lifetimeMs = Math.max(init.processLifetimeMs, armWallClockMs + ABORT_SETTLE_MS);
            lifetimeTimer = scheduleTimeout(() => fail(new Error("guest agent exceeded its maximum process lifetime")), lifetimeMs);
            lifetimeTimer.unref();
            instance.setDeadline?.(startedMs + armWallClockMs);
            armTimer = scheduleTimeout(() => {
                semanticAbortCause = "arm-budget";
                instance?.session.abort();
            }, armWallClockMs);
            armTimer.unref();
        }
        else {
            instance.setDeadline?.(Number.POSITIVE_INFINITY);
        }
        let executionError = null;
        try {
            await instance.runPrompt(prompt);
        }
        catch (error) {
            executionError = error;
        }
        finally {
            if (armTimer !== null) {
                armTimer.cancel();
                armTimer = null;
            }
            if (lifetimeTimer !== null) {
                lifetimeTimer.cancel();
                lifetimeTimer = null;
            }
        }
        if (instance.session.isStreaming)
            throw new Error("SDK prompt returned while the session was still streaming");
        await stopTaskDescendants(options.controlSocket);
        const snapshot = instance.getBudgetSnapshot();
        // The wire usage frame is EXACTLY the seven-field transport contract the host adapter
        // validates. The internal clamp-attribution diagnostic (outputClampBoundLastRequest)
        // stays in-process; its effect is already folded into taskLimitReason and stopCause.
        const usage = {
            providerRequests: snapshot.providerRequests,
            toolSteps: snapshot.toolSteps,
            inputTokens: snapshot.inputTokens,
            outputTokens: snapshot.outputTokens,
            cacheReadTokens: snapshot.cacheReadTokens,
            cacheWriteTokens: snapshot.cacheWriteTokens,
            taskLimitReason: snapshot.taskLimitReason,
        };
        const last = instance.session.messages.filter((message) => message.role === "assistant").at(-1);
        const nativeStopReason = typeof last?.stopReason === "string" ? last.stopReason : null;
        // The RAW provider stop reason (e.g. MAX_TOKENS/STOP), preserved verbatim and
        // independently of the normalized `stopReason` used for semantic classification.
        // Absent for legacy/unmanaged responses, in which case it is null.
        const rawStopReason = typeof last?.rawStopReason === "string" ? last.rawStopReason : null;
        const expectedAbortError = executionError instanceof Error && executionError.name === "AbortError";
        const nativeErrorMessage = typeof last?.errorMessage === "string" ? last.errorMessage : null;
        const knownAbortMessage = nativeErrorMessage !== null && KNOWN_ABORT_MESSAGE.test(nativeErrorMessage.trim());
        // Some providers report a cancellation we requested as a plain error rather than an
        // abort. Normalize it only when THIS harness initiated the abort, so an unsolicited
        // provider-side abort error still classifies as a genuine failure.
        const stopReason = nativeStopReason === "error" && semanticAbortCause !== null && knownAbortMessage
            ? "aborted"
            : nativeStopReason;
        const aborted = stopReason === "aborted";
        // A budget-terminal message is the harness's own doing, not an arbitrary failure.
        const nativeArbitraryFailure = aborted && nativeErrorMessage !== null && !knownAbortMessage && usage.taskLimitReason === null;
        const arbitraryExecutionFailure = nativeArbitraryFailure || (executionError !== null && !(semanticAbortCause !== null && expectedAbortError));
        const terminalClass = arbitraryExecutionFailure || stopReason === "error"
            ? "execution-failure"
            : semanticAbortCause === "external"
                ? "interrupted"
                : semanticAbortCause === "arm-budget" || usage.taskLimitReason !== null || stopReason === "length"
                    ? "task-limit"
                    : aborted
                        ? "unexpected-abort"
                        : "completed";
        const outcome = terminalClass === "completed" ? "completed" : terminalClass === "task-limit" ? "task-limit" : "infrastructure-failure";
        // Precise stop cause: a provider-native `length` truncation is reported distinctly and
        // is never conflated with a harness cumulative-output-token cap (see deriveStopCause).
        const stopCause = deriveStopCause({ terminalClass, semanticAbortCause, taskLimitReason: usage.taskLimitReason, stopReason });
        capture.finish(terminalClass === "completed", terminalClass === "completed" ? null : executionError === null ? terminalClass : safeError(executionError));
        state = "settled";
        emitFrame({
            type: "result",
            protocolVersion: PROTOCOL_VERSION,
            sessionId: instance.getNativeSessionEntries()[0]?.id ?? null,
            outcome,
            usage,
            timing: { startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - startedMs },
            terminal: { stopReason, rawStopReason, classification: terminalClass, stopCause, semanticAbortCause, error: executionError === null ? null : safeError(executionError), streamingStopped: true },
            redactions: capture.snapshot().redactions,
        });
        dispose();
    };
    const handle = async (raw) => {
        if (!object(raw) || typeof raw.type !== "string")
            throw new Error("request frame must be an object with a type");
        if (raw.type === "init")
            return await initialize(raw);
        if (raw.type === "prompt") {
            knownFields(raw, ["type", "prompt"], "prompt");
            if (state !== "ready")
                throw new Error("prompt is only valid in ready state");
            const prompt = nonEmptyString(raw.prompt, "prompt.prompt");
            state = "prompting";
            if (prePromptTimer !== null) {
                prePromptTimer.cancel();
                prePromptTimer = null;
            }
            promptSettlement = settlePrompt(prompt).catch(fail);
            return;
        }
        if (raw.type === "abort") {
            knownFields(raw, ["type", "reason", "cause"], "abort");
            if (raw.reason !== undefined && typeof raw.reason !== "string")
                throw new Error("abort.reason must be a string");
            if (raw.cause !== "external" && raw.cause !== "arm-budget")
                throw new Error("abort.cause must be external or arm-budget");
            if (state !== "prompting" || !instance || !promptSettlement)
                throw new Error("abort is only valid while prompting");
            semanticAbortCause = raw.cause;
            instance.session.abort();
            return;
        }
        throw new Error("unknown guest agent frame type");
    };
    let input = Buffer.alloc(0);
    let queue = Promise.resolve();
    let pendingFrames = 0;
    let pendingBytes = 0;
    const applyBackpressure = () => {
        if (pendingFrames >= MAX_PENDING_INPUT_FRAMES || pendingBytes >= MAX_PENDING_INPUT_BYTES)
            process.stdin.pause();
        else if (!fatal)
            process.stdin.resume();
    };
    process.stdin.on("data", (chunk) => {
        if (fatal)
            return;
        input = Buffer.concat([input, chunk]);
        if (input.byteLength > MAX_REQUEST_BYTES && input.indexOf(0x0a) === -1)
            return fail(new Error("request frame exceeded 1 MiB"));
        let newline;
        while (!fatal && (newline = input.indexOf(0x0a)) !== -1) {
            const line = input.subarray(0, newline);
            input = input.subarray(newline + 1);
            if (line.byteLength === 0)
                continue;
            if (line.byteLength > MAX_REQUEST_BYTES)
                return fail(new Error("request frame exceeded 1 MiB"));
            if (pendingFrames + 1 > MAX_PENDING_INPUT_FRAMES || pendingBytes + line.byteLength > MAX_PENDING_INPUT_BYTES) {
                return fail(new Error("pending request frames exceeded the initialization limit"));
            }
            pendingFrames += 1;
            pendingBytes += line.byteLength;
            applyBackpressure();
            queue = queue.then(async () => {
                pendingFrames -= 1;
                pendingBytes -= line.byteLength;
                applyBackpressure();
                if (fatal)
                    return;
                let value;
                try {
                    value = JSON.parse(line.toString("utf8"));
                }
                catch {
                    throw new Error("request frame is malformed JSON");
                }
                if (!fatal)
                    await handle(value);
            }).catch(fail);
        }
    });
    await new Promise((resolve) => process.stdin.once("end", resolve));
    await queue;
    if (fatal)
        return;
    if (input.byteLength !== 0)
        return fail(new Error("request stream ended with an incomplete frame"));
    if (promptSettlement)
        await promptSettlement;
    else
        fail(new Error("request stream ended before a prompt settled"));
}
