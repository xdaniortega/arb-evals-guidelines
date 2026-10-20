/**
 * Guest Pi SDK session wrapper.
 *
 * Implements the in-guest SDK session contract:
 * - Instantiates the ACTUAL pinned SDK session (@earendil-works/pi-coding-agent@0.85.0).
 * - Creates ONE fresh session per arm.
 * - Enforces strict arm isolation: baseline loads zero skills; treatment loads exactly one frozen skill.
 * - Suppresses ambient AGENTS.md, global skills, settings, and extensions.
 * - Attests the SAME session instance that executes the prompt (closes Local Gap 1).
 * - Narrow test seam: replaces ONLY `ModelRuntime.streamSimple` when a scripted driver is provided.
 *
 * HONEST LIMIT STATEMENT: Mocking completion proves target wiring and SDK behaviour —
 * it does NOT prove live authentication, provider wire-protocol compatibility,
 * quotas, latency or skill quality.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { EvalError } from "../../core/types.mjs";
import { validateTargetConfiguration } from "../../runner/models.mjs";
import { createMcpClient, MCP_CLIENT_POLICY, MCP_CLIENT_TOOL_NAME } from "./mcp-tools.mjs";
/** @notice Recognize only the observed Pi 0.85.0 post-run usage dereference, failing closed elsewhere. */
function isPinnedPostRunUsageError(error) {
    if (!(error instanceof TypeError) || !/^Cannot read properties of undefined \(reading '(input|output)'\)$/.test(error.message))
        return false;
    const frames = error.stack?.split("\n").slice(1).map((frame) => frame.trim()) ?? [];
    // Verify the native post-run call chain, in compiled or source-mapped stacks.
    // Matching error text alone must never conceal a tool, callback or provider failure.
    return /^at isContextOverflow \(file:\/\/.+\/@earendil-works\/pi-ai\/(dist\/utils\/overflow\.js|src\/utils\/overflow\.ts):\d+:\d+\)$/.test(frames[0] ?? "") &&
        /^at AgentSession\._isRetryableError \(file:\/\/.+\/@earendil-works\/pi-coding-agent\/(dist\/core\/agent-session\.js|src\/core\/agent-session\.ts):\d+:\d+\)$/.test(frames[1] ?? "") &&
        /^at AgentSession\._handlePostAgentRun \(file:\/\/.+\/@earendil-works\/pi-coding-agent\/(dist\/core\/agent-session\.js|src\/core\/agent-session\.ts):\d+:\d+\)$/.test(frames[2] ?? "");
}
/**
 * @notice Allows near-cap usage when attributing provider truncation to a task budget.
 * @param clamp Output-token allowance actually forwarded to the provider.
 * @returns A tolerance of at least 16 tokens or one percent of the allowance.
 * @dev Attribution is heuristic; native truncation inside this window is indistinguishable.
 */
export function outputClampReachTolerance(clamp) {
    return Math.max(16, Math.ceil(clamp * 0.01));
}
/**
 * @notice Applies a finite cumulative output budget without overriding a smaller native cap.
 * @param input Arm allowance, previously consumed output, and SDK response-token setting.
 * @returns Forwarded response allowance and whether the harness remainder binds it.
 * @dev An unlimited allowance forwards the existing SDK setting unchanged.
 */
export function computeOutputClamp(input) {
    const { maxOutputTokens, priorOutput, existingMaxTokens } = input;
    const remainingOutput = maxOutputTokens !== null ? maxOutputTokens - priorOutput : undefined;
    const forwardedMaxTokens = remainingOutput === undefined
        ? existingMaxTokens
        : Math.min(existingMaxTokens ?? remainingOutput, remainingOutput);
    const harnessRemainderBinding = maxOutputTokens !== null &&
        remainingOutput !== undefined &&
        (existingMaxTokens === undefined || remainingOutput <= existingMaxTokens);
    return {
        forwardedMaxTokens,
        harnessRemainderBinding,
        forwardedClamp: harnessRemainderBinding ? remainingOutput : null,
    };
}
/**
 * @notice Attributes a length stop to a finite harness budget only with near-cap usage evidence.
 * @param input Budget, binding request constraint, and observed response output.
 * @returns Whether the response reached the harness clamp within accounting tolerance.
 * @dev Missing usage or a nonbinding clamp cannot establish cumulative exhaustion.
 */
export function lengthStopExhaustedOutputBudget(input) {
    const { maxOutputTokens, harnessRemainderBinding, forwardedClamp, responseOutput } = input;
    if (maxOutputTokens === null)
        return false;
    if (!harnessRemainderBinding || forwardedClamp === null)
        return false;
    if (responseOutput === null)
        return false;
    return responseOutput >= forwardedClamp - outputClampReachTolerance(forwardedClamp);
}
/**
 * @notice Initializes an isolated Pi SDK agent session configured with explicit model runtime settings and in-memory credential delivery.
 * @param options Session options controlling model configuration, working directories, skills, tools, and credentials.
 * @returns Managed Pi SDK session instance providing attestation, prompt dispatch, budget tracking, and disposal hooks.
 * @dev Validates model and provider against the runtime catalog without ambient fallback, isolates runtime credentials in memory, and decorates request dispatch to enforce task budgets and capture native traces.
 */
export async function createPiSdkSession(options) {
    // 1. Explicit target validation before any session or prompt dispatch
    validateTargetConfiguration(options.target);
    // 2. Set up clean temporary agent directory if none supplied
    let createdTempAgentDir = false;
    let agentDir = options.agentDir;
    if (!agentDir) {
        agentDir = mkdtempSync(join(tmpdir(), "pi-eval-agent-"));
        createdTempAgentDir = true;
    }
    // 3. Model runtime with in-memory authentication and modelsPath: null to prevent ambient reads
    const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
    });
    const model = modelRuntime.getModel(options.target.provider, options.target.model);
    if (!model) {
        throw new EvalError("input-invalid", `model '${options.target.model}' not found in runtime catalog for provider '${options.target.provider}'`, { at: "target.model" });
    }
    // A measured session must bind its explicitly delivered credential before it can
    // attest ready. Only the scripted completion seam may use a synthetic marker.
    const runtimeApiKey = options.apiKey ?? (options.streamSimpleOverride ? "synthetic-eval-test-key" : null);
    if (runtimeApiKey === null) {
        throw new EvalError("secret-quarantine", "Pi SDK initialization requires an explicitly delivered provider credential", { at: "pi.sdk.credential" });
    }
    await modelRuntime.setRuntimeApiKey(options.target.provider, runtimeApiKey);
    // 4. Decorate the SDK's actual request dispatch seam. Scripted tests replace only
    // the delegate; measured composition keeps the runtime's native implementation.
    const streamDelegate = options.streamSimpleOverride ?? modelRuntime.streamSimple.bind(modelRuntime);
    const budget = options.budget;
    let providerRequests = 0;
    let toolSteps = 0;
    let taskLimitReason = null;
    // Whether the MOST RECENT provider request forwarded the harness cumulative-output
    // remainder as its binding per-response `maxTokens` (the remainder was the minimum we
    // actually sent, no smaller native per-response cap won). This is structural: it can be
    // true on the FIRST request too, where the remainder still equals the full budget.
    // Whether a `length` stop actually REACHED that clamp (and is therefore cumulative-output
    // exhaustion) is decided from observed output usage in the message_end handler, never
    // from turn position alone.
    let lastRequestOutputClampBound = false;
    // The exact clamp value forwarded on the most recent request when the harness remainder
    // was binding; null otherwise (unlimited output, or a smaller native cap won the min).
    let lastForwardedOutputClamp = null;
    const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const usageAvailable = { input: true, output: true, cacheRead: true, cacheWrite: true };
    let finalizedAssistantMessages = 0;
    const observedMessages = new WeakSet();
    const setTaskLimit = (reason) => {
        taskLimitReason ??= reason;
    };
    const terminalBudgetStream = (reason) => {
        const stream = createAssistantMessageEventStream();
        const message = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            stopReason: "aborted",
            errorMessage: reason,
            timestamp: Date.now(),
            // Usage is intentionally absent: no provider request was delegated.
        };
        queueMicrotask(() => {
            stream.push({ type: "error", reason: "aborted", error: message });
            stream.end(message);
        });
        return stream;
    };
    modelRuntime.streamSimple = ((requestModel, context, streamOptions) => {
        // Each budget is enforced ONLY when it is a finite opt-in (not null/unlimited).
        if (budget && budget.maxProviderRequests !== null && providerRequests >= budget.maxProviderRequests) {
            const reason = `provider requests budget of ${budget.maxProviderRequests} exhausted`;
            setTaskLimit(reason);
            return terminalBudgetStream(reason);
        }
        if (budget && budget.maxOutputTokens !== null && usageTotals.output >= budget.maxOutputTokens) {
            const reason = `output token budget of ${budget.maxOutputTokens} exhausted`;
            setTaskLimit(reason);
            return terminalBudgetStream(reason);
        }
        providerRequests += 1;
        // Only clamp the per-request maxTokens to a shrinking cumulative remainder when a
        // FINITE output-token budget is configured. When output is unlimited (null), we
        // forward any legitimate SDK/provider per-response maxTokens unchanged and never
        // inject a cumulative clamp, so a request is never shrunk toward a harness cap.
        const existingMaxTokens = streamOptions?.maxTokens;
        const clamp = computeOutputClamp({
            maxOutputTokens: budget?.maxOutputTokens ?? null,
            priorOutput: usageTotals.output,
            existingMaxTokens,
        });
        const maxTokens = clamp.forwardedMaxTokens;
        // Record whether the harness remainder was the binding forwarded cap and, if so, its
        // exact value. Attribution of a later `length` stop to cumulative-output exhaustion is
        // then decided from observed output usage (see the message_end handler), so a
        // provider-native truncation below the clamp is never mislabeled and a genuine
        // first-turn or shrunken-remainder clamp that IS reached is not missed.
        lastRequestOutputClampBound = clamp.harnessRemainderBinding;
        lastForwardedOutputClamp = clamp.forwardedClamp;
        return streamDelegate(requestModel, context, {
            ...streamOptions,
            ...(maxTokens === undefined ? {} : { maxTokens }),
            maxRetries: 0,
        });
    });
    // 5. Settings manager: disable retry and compaction for evaluation arms
    const settingsManager = SettingsManager.create(options.cwd, agentDir);
    settingsManager.setRetryEnabled(false);
    settingsManager.setCompactionEnabled(false);
    // 6. Resource loader: strict ambient suppression and exact skill loading
    const additionalSkillPaths = options.arm === "treatment" && options.skillPath ? [options.skillPath] : [];
    const resourceLoader = new DefaultResourceLoader({
        cwd: options.cwd,
        agentDir,
        settingsManager,
        noSkills: true,
        additionalSkillPaths,
        noExtensions: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
    });
    await resourceLoader.reload();
    // 7. Evaluated sessions with a sanitized recorder are always in-memory: Pi's raw
    // JSONL must never be persisted beside the evaluator-owned sanitized scratch file.
    const sessionDir = options.sessionDir ?? join(agentDir, "sessions");
    const sessionManager = options.nativeSessionRecorder || options.inMemorySession
        ? SessionManager.inMemory(options.cwd)
        : SessionManager.create(options.cwd, sessionDir);
    // Capture the actual header and decorate only pinned public append APIs BEFORE
    // createAgentSession. Each wrapper invokes Pi first, then retrieves the actual entry
    // by returned ID; event subscribers run too early to prove persistence here.
    const decoratedAppendMethods = [
        "appendMessage",
        "appendThinkingLevelChange",
        "appendModelChange",
        "appendCompaction",
        "appendCustomEntry",
        "appendSessionInfo",
        "appendCustomMessageEntry",
        "appendLabelChange",
        "branchWithSummary",
    ];
    const restoredAppendMethods = [];
    if (options.nativeSessionRecorder) {
        const header = sessionManager.getHeader();
        if (header === null) {
            throw new EvalError("protocol-drift", "Pi 0.85.0 in-memory SessionManager returned no native header");
        }
        options.nativeSessionRecorder.record(structuredClone(header));
        const mutableManager = sessionManager;
        for (const methodName of decoratedAppendMethods) {
            const original = mutableManager[methodName];
            if (typeof original !== "function") {
                throw new EvalError("protocol-drift", `Pi 0.85.0 SessionManager is missing public ${methodName}`);
            }
            mutableManager[methodName] = (...args) => {
                const id = original.apply(sessionManager, args);
                if (typeof id !== "string" || id === "") {
                    throw new EvalError("protocol-drift", `Pi 0.85.0 ${methodName} returned no native entry ID`);
                }
                const actual = sessionManager.getEntry(id);
                if (actual === undefined) {
                    throw new EvalError("protocol-drift", `Pi 0.85.0 ${methodName} entry ${id} was not retrievable`);
                }
                options.nativeSessionRecorder.record(structuredClone(actual));
                return id;
            };
            restoredAppendMethods.push(() => { mutableManager[methodName] = original; });
        }
    }
    // 8. Create the AgentSession
    // Baseline receives the shared client, but never treatment server configuration.
    if (options.arm === "baseline") {
        if (options.skillToolBundle !== undefined && options.skillToolBundle !== null && options.skillToolBundle.servers.length > 0) {
            throw new EvalError("parity-violation", "baseline session cannot receive treatment MCP server configuration", { at: "pi.sdk.arm" });
        }
    }
    const mcpClient = await createMcpClient({
        conditionId: options.arm,
        bundle: options.arm === "treatment" ? (options.skillToolBundle ?? null) : null,
        guardedSecrets: options.guardedSecrets ?? (options.apiKey ? [{ label: "api-key", value: options.apiKey }] : []),
        deadlineAtMs: options.deadlineAtMs ?? (Date.now() + 180_000),
        signal: options.signal,
    });
    const baseAllowedTools = options.allowedTools ? [...options.allowedTools] : ["read", "bash", "edit", "write"];
    if (baseAllowedTools.includes(MCP_CLIENT_TOOL_NAME) || options.ambientTools?.some((tool) => tool.name === MCP_CLIENT_TOOL_NAME)) {
        mcpClient.dispose();
        throw new EvalError("parity-violation", "mcp is reserved for the shared client integration", { at: "pi.sdk.tools" });
    }
    const activeTools = [...baseAllowedTools, MCP_CLIENT_TOOL_NAME];
    const ambientDefs = options.ambientTools ? [...options.ambientTools] : [];
    const allCustomTools = [...ambientDefs, mcpClient.definition];
    const customTools = allCustomTools.length > 0 ? allCustomTools : undefined;
    const { session } = await createAgentSession({
        cwd: options.cwd,
        agentDir,
        modelRuntime,
        model,
        thinkingLevel: options.target.thinking,
        tools: activeTools,
        customTools,
        resourceLoader,
        settingsManager,
        sessionManager,
    }).catch((error) => {
        mcpClient.dispose();
        for (const restore of restoredAppendMethods)
            restore();
        if (createdTempAgentDir)
            rmSync(agentDir, { recursive: true, force: true });
        throw error;
    });
    // Explicitly ensure retry and compaction are disabled on the session
    session.setAutoRetryEnabled(false);
    session.setAutoCompactionEnabled(false);
    // Compose the SDK's native tool/turn hooks rather than replacing its loop.
    const previousBeforeToolCall = session.agent.beforeToolCall;
    session.agent.beforeToolCall = async (context, signal) => {
        const previous = await previousBeforeToolCall?.(context, signal);
        if (previous?.block)
            return previous;
        // Enforce the tool-step budget only when it is a finite opt-in; the counter below
        // always advances so telemetry is retained even when the budget is unlimited.
        if (budget && budget.maxToolSteps !== null && toolSteps >= budget.maxToolSteps) {
            const reason = `tool steps budget of ${budget.maxToolSteps} exhausted`;
            setTaskLimit(reason);
            return { block: true, terminate: true, reason };
        }
        toolSteps += 1;
        return previous;
    };
    // Pi 0.85.0 treats a returned AgentToolResult as successful regardless of its
    // isError property. Preserve this client's sanitized failure flag in native evidence.
    const previousAfterToolCall = session.agent.afterToolCall;
    session.agent.afterToolCall = async (context, signal) => {
        const previous = await previousAfterToolCall?.(context, signal);
        if (context.toolCall.name === MCP_CLIENT_TOOL_NAME && context.result.details?.isError === true) {
            return { ...previous, isError: true };
        }
        return previous;
    };
    const previousShouldStopAfterTurn = session.agent.shouldStopAfterTurn;
    session.agent.shouldStopAfterTurn = async (context, signal) => {
        if (await previousShouldStopAfterTurn?.(context, signal))
            return true;
        if (!budget)
            return false;
        if (taskLimitReason !== null)
            return true;
        const needsContinuation = context.message.content.some((block) => block.type === "toolCall");
        if (budget.maxProviderRequests !== null && providerRequests >= budget.maxProviderRequests && needsContinuation) {
            setTaskLimit(`provider requests budget of ${budget.maxProviderRequests} exhausted`);
            return true;
        }
        if (budget.maxOutputTokens !== null &&
            (usageTotals.output > budget.maxOutputTokens ||
                (usageTotals.output === budget.maxOutputTokens && needsContinuation))) {
            setTaskLimit(`output token budget of ${budget.maxOutputTokens} exhausted`);
            return true;
        }
        return false;
    };
    const unsubscribeBudgetObserver = session.subscribe((event) => {
        if (event.type !== "message_end" || event.message.role !== "assistant")
            return;
        const message = event.message;
        if (observedMessages.has(message))
            return;
        observedMessages.add(message);
        finalizedAssistantMessages += 1;
        const usage = message.usage;
        const responseOutput = typeof usage?.output === "number" ? usage.output : null;
        for (const component of ["input", "output", "cacheRead", "cacheWrite"]) {
            const value = usage?.[component];
            if (typeof value === "number")
                usageTotals[component] += value;
            else
                usageAvailable[component] = false;
        }
        // A provider `length` truncation is harness cumulative-output-token exhaustion ONLY
        // when the harness clamp was the binding forwarded cap AND the response actually
        // reached it (proven from this response's output usage). This uses the actual
        // forwarded request cap and observed output rather than turn position, so a genuine
        // first-turn clamp that is reached counts, while a provider-native truncation below
        // the clamp (or an unlimited budget) stays provider-native. Naming it here at the
        // source keeps host adapter and in-guest agent classifications identical and prevents
        // the fallback "length limit reached" reason from mislabeling an injected clamp.
        if (message.stopReason === "length" &&
            budget &&
            budget.maxOutputTokens !== null &&
            lengthStopExhaustedOutputBudget({
                maxOutputTokens: budget.maxOutputTokens,
                harnessRemainderBinding: lastRequestOutputClampBound,
                forwardedClamp: lastForwardedOutputClamp,
                responseOutput,
            })) {
            setTaskLimit(`output token budget of ${budget.maxOutputTokens} exhausted (provider truncated at clamped remaining allowance)`);
        }
    });
    // 9. Attestation on THAT SAME session instance
    function attest() {
        const currentModel = session.model;
        if (!currentModel) {
            throw new EvalError("protocol-drift", "Session has no model configured");
        }
        if (currentModel.provider !== options.target.provider) {
            throw new EvalError("protocol-drift", `Session model provider '${currentModel.provider}' does not match target provider '${options.target.provider}'`);
        }
        if (currentModel.id !== options.target.model) {
            throw new EvalError("protocol-drift", `Session model '${currentModel.id}' does not match target model '${options.target.model}'`);
        }
        if (session.thinkingLevel !== options.target.thinking) {
            throw new EvalError("protocol-drift", `Session thinking level '${session.thinkingLevel}' does not match target thinking '${options.target.thinking}'`);
        }
        const currentTools = session.getActiveToolNames();
        const skills = session.resourceLoader.getSkills().skills;
        const agentsFiles = session.resourceLoader.getAgentsFiles().agentsFiles;
        const extensions = session.resourceLoader.getExtensions().extensions;
        const prompts = session.resourceLoader.getPrompts().prompts;
        const themes = session.resourceLoader.getThemes().themes;
        // Enforce arm isolation
        if (options.arm === "baseline" && skills.length !== 0) {
            throw new EvalError("protocol-drift", `Baseline session has ${skills.length} skills loaded; expected exactly 0`);
        }
        if (options.arm === "treatment" && skills.length !== 1) {
            throw new EvalError("protocol-drift", `Treatment session has ${skills.length} skills loaded; expected exactly 1`);
        }
        if (agentsFiles.length !== 0) {
            throw new EvalError("protocol-drift", `Ambient AGENTS.md files entered session: count=${agentsFiles.length}`);
        }
        if (extensions.length !== 0) {
            throw new EvalError("protocol-drift", `Ambient extensions entered session: count=${extensions.length}`);
        }
        if (prompts.length !== 0) {
            throw new EvalError("protocol-drift", `Ambient prompt templates entered session: count=${prompts.length}`);
        }
        if (session.autoRetryEnabled || session.settingsManager.getRetryEnabled()) {
            throw new EvalError("protocol-drift", "Retry was not disabled on the executing session");
        }
        if (session.autoCompactionEnabled || session.settingsManager.getCompactionEnabled()) {
            throw new EvalError("protocol-drift", "Compaction was not disabled on the executing session");
        }
        return {
            arm: options.arm,
            target: options.target,
            modelId: currentModel.id,
            providerId: currentModel.provider,
            thinkingLevel: session.thinkingLevel,
            activeTools: currentTools,
            ambientCustomTools: options.ambientTools ? options.ambientTools.map((t) => t.name).sort() : [],
            mcpClientId: MCP_CLIENT_POLICY.id,
            seededMcpServers: mcpClient.seededServers,
            skillToolBundleSha256: options.arm === "treatment" ? (options.skillToolBundleSha256 ?? null) : null,
            loadedSkills: skills.map((s) => ({ name: s.name, path: s.filePath })),
            agentsFilesCount: agentsFiles.length,
            extensionsCount: extensions.length,
            promptsCount: prompts.length,
            themesCount: themes.length,
            retryEnabled: session.autoRetryEnabled,
            compactionEnabled: session.autoCompactionEnabled,
        };
    }
    async function runPrompt(promptText) {
        try {
            await session.prompt(promptText);
        }
        catch (error) {
            // Pi 0.85.0's post-run overflow check dereferences the statically-required
            // usage object even when a test-double response intentionally omits it. The
            // native agent turn and session entry are already finalized at this point.
            // Treat only that narrow telemetry-unavailable case as settled; every model,
            // tool, cancellation, and transport error keeps its native behavior.
            const lastMessage = session.messages.filter((message) => message.role === "assistant").at(-1);
            if (lastMessage?.role === "assistant" &&
                lastMessage.usage === undefined &&
                lastMessage.stopReason !== "error" &&
                lastMessage.stopReason !== "aborted" &&
                !session.isStreaming &&
                finalizedAssistantMessages > 0 &&
                isPinnedPostRunUsageError(error)) {
                return;
            }
            throw error;
        }
    }
    function getBudgetSnapshot() {
        const observed = finalizedAssistantMessages > 0;
        return {
            providerRequests,
            toolSteps,
            inputTokens: observed && usageAvailable.input ? usageTotals.input : null,
            outputTokens: observed && usageAvailable.output ? usageTotals.output : null,
            cacheReadTokens: observed && usageAvailable.cacheRead ? usageTotals.cacheRead : null,
            cacheWriteTokens: observed && usageAvailable.cacheWrite ? usageTotals.cacheWrite : null,
            taskLimitReason,
            outputClampBoundLastRequest: lastRequestOutputClampBound,
        };
    }
    function getNativeSessionEntries() {
        // SessionManager intentionally excludes the metadata header from getEntries().
        // The evidence carrier represents native JSONL records, so retain the actual
        // header when the SDK has one rather than fabricating equivalent metadata.
        const header = session.sessionManager.getHeader();
        const entries = session.sessionManager.getEntries();
        return header === null
            ? entries
            : [header, ...entries];
    }
    function dispose() {
        mcpClient.dispose();
        unsubscribeBudgetObserver();
        for (const restore of restoredAppendMethods)
            restore();
        session.dispose();
        if (createdTempAgentDir && agentDir) {
            try {
                rmSync(agentDir, { recursive: true, force: true });
            }
            catch {
                // Ignore cleanup error in temp dir
            }
        }
    }
    return {
        session,
        resourceLoader,
        settingsManager,
        modelRuntime,
        sessionFile: session.sessionFile,
        attest,
        runPrompt,
        getBudgetSnapshot,
        getNativeSessionEntries,
        setDeadline: (atMs) => {
            mcpClient.setDeadline(atMs);
        },
        dispose,
    };
}
