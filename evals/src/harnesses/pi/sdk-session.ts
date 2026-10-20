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
import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
  ShouldStopAfterTurnContext,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { NativeSessionEntryRecorder } from "../../artifacts/native-prefix.ts";
import type { Target } from "../../core/experiment.ts";
import type { GuardedSecret } from "../../core/secret-scan.ts";
import type { SkillToolBundle } from "../../core/skill-tools.ts";
import { EvalError, type Limits } from "../../core/types.ts";
import { validateTargetConfiguration } from "../../runner/models.ts";
import type { NativeSessionEntry } from "./export-viewer.ts";
import { createMcpClient, MCP_CLIENT_POLICY, MCP_CLIENT_TOOL_NAME } from "./mcp-tools.ts";

/** @notice Recognize only the observed Pi 0.85.0 post-run usage dereference, failing closed elsewhere. */
function isPinnedPostRunUsageError(error: unknown): boolean {
  if (!(error instanceof TypeError) || !/^Cannot read properties of undefined \(reading '(input|output)'\)$/.test(error.message)) return false;
  const frames = error.stack?.split("\n").slice(1).map((frame) => frame.trim()) ?? [];
  // Verify the native post-run call chain, in compiled or source-mapped stacks.
  // Matching error text alone must never conceal a tool, callback or provider failure.
  return /^at isContextOverflow \(file:\/\/.+\/@earendil-works\/pi-ai\/(dist\/utils\/overflow\.js|src\/utils\/overflow\.ts):\d+:\d+\)$/.test(frames[0] ?? "") &&
    /^at AgentSession\._isRetryableError \(file:\/\/.+\/@earendil-works\/pi-coding-agent\/(dist\/core\/agent-session\.js|src\/core\/agent-session\.ts):\d+:\d+\)$/.test(frames[1] ?? "") &&
    /^at AgentSession\._handlePostAgentRun \(file:\/\/.+\/@earendil-works\/pi-coding-agent\/(dist\/core\/agent-session\.js|src\/core\/agent-session\.ts):\d+:\d+\)$/.test(frames[2] ?? "");
}

export interface PiSdkSessionOptions {
  readonly cwd: string;
  readonly arm: "baseline" | "treatment";
  readonly target: Target;
  readonly skillPath?: string;
  readonly allowedTools?: readonly string[];
  readonly ambientTools?: readonly ToolDefinition[];
  readonly skillToolBundle?: SkillToolBundle | null;
  readonly skillToolBundleSha256?: string | null;
  readonly guardedSecrets?: readonly GuardedSecret[];
  readonly deadlineAtMs?: number;
  readonly signal?: AbortSignal;
  readonly agentDir?: string;
  readonly sessionDir?: string;
  readonly inMemorySession?: boolean;
  readonly apiKey?: string;
  readonly budget?: Pick<Limits, "maxProviderRequests" | "maxToolSteps" | "maxOutputTokens">;
  /** Evaluator-owned durable sink; the SDK receives no snapshot/read capability. */
  readonly nativeSessionRecorder?: NativeSessionEntryRecorder;
  readonly streamSimpleOverride?: (
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ) => any;
}

export interface PiSdkAttestation {
  readonly arm: "baseline" | "treatment";
  readonly target: Target;
  readonly modelId: string;
  readonly providerId: string;
  readonly thinkingLevel: string;
  readonly activeTools: readonly string[];
  readonly ambientCustomTools: string[];
  readonly mcpClientId: string | null;
  readonly seededMcpServers: readonly string[];
  readonly skillToolBundleSha256: string | null;
  readonly loadedSkills: readonly { readonly name: string; readonly path?: string }[];
  readonly agentsFilesCount: number;
  readonly extensionsCount: number;
  readonly promptsCount: number;
  readonly themesCount: number;
  readonly retryEnabled: boolean;
  readonly compactionEnabled: boolean;
}

export interface PiSdkBudgetSnapshot {
  readonly providerRequests: number;
  readonly toolSteps: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly taskLimitReason: string | null;
}

export interface PiSdkSessionInstance {
  readonly session: AgentSession;
  readonly resourceLoader: ResourceLoader;
  readonly settingsManager: SettingsManager;
  readonly modelRuntime: ModelRuntime;
  readonly sessionFile?: string;
  readonly attest: () => PiSdkAttestation;
  readonly runPrompt: (promptText: string) => Promise<void>;
  readonly getBudgetSnapshot: () => PiSdkBudgetSnapshot;
  readonly getNativeSessionEntries: () => readonly NativeSessionEntry[];
  readonly setDeadline?: (atMs: number) => void;
  readonly dispose: () => void;
}

/**
 * @notice Initializes an isolated Pi SDK agent session configured with explicit model runtime settings and in-memory credential delivery.
 * @param options Session options controlling model configuration, working directories, skills, tools, and credentials.
 * @returns Managed Pi SDK session instance providing attestation, prompt dispatch, budget tracking, and disposal hooks.
 * @dev Validates model and provider against the runtime catalog without ambient fallback, isolates runtime credentials in memory, and decorates request dispatch to enforce task budgets and capture native traces.
 */
export async function createPiSdkSession(options: PiSdkSessionOptions): Promise<PiSdkSessionInstance> {
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
    throw new EvalError(
      "input-invalid",
      `model '${options.target.model}' not found in runtime catalog for provider '${options.target.provider}'`,
      { at: "target.model" },
    );
  }

  // A measured session must bind its explicitly delivered credential before it can
  // attest ready. Only the scripted completion seam may use a synthetic marker.
  const runtimeApiKey = options.apiKey ?? (options.streamSimpleOverride ? "synthetic-eval-test-key" : null);
  if (runtimeApiKey === null) {
    throw new EvalError(
      "secret-quarantine",
      "Pi SDK initialization requires an explicitly delivered provider credential",
      { at: "pi.sdk.credential" },
    );
  }
  await modelRuntime.setRuntimeApiKey(options.target.provider, runtimeApiKey);

  // 4. Decorate the SDK's actual request dispatch seam. Scripted tests replace only
  // the delegate; measured composition keeps the runtime's native implementation.
  const streamDelegate = options.streamSimpleOverride ?? modelRuntime.streamSimple.bind(modelRuntime);
  const budget = options.budget;
  let providerRequests = 0;
  let toolSteps = 0;
  let taskLimitReason: string | null = null;
  const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const usageAvailable = { input: true, output: true, cacheRead: true, cacheWrite: true };
  let finalizedAssistantMessages = 0;
  const observedMessages = new WeakSet<object>();

  const setTaskLimit = (reason: string): void => {
    taskLimitReason ??= reason;
  };

  const terminalBudgetStream = (reason: string) => {
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
    } as unknown as AssistantMessage;
    queueMicrotask(() => {
      stream.push({ type: "error", reason: "aborted", error: message });
      stream.end(message);
    });
    return stream;
  };

  modelRuntime.streamSimple = ((requestModel, context, streamOptions) => {
    if (budget && providerRequests >= budget.maxProviderRequests) {
      const reason = `provider requests budget of ${budget.maxProviderRequests} exhausted`;
      setTaskLimit(reason);
      return terminalBudgetStream(reason);
    }
    if (budget && usageTotals.output >= budget.maxOutputTokens) {
      const reason = `output token budget of ${budget.maxOutputTokens} exhausted`;
      setTaskLimit(reason);
      return terminalBudgetStream(reason);
    }

    providerRequests += 1;
    const remainingOutput = budget ? budget.maxOutputTokens - usageTotals.output : undefined;
    const existingMaxTokens = streamOptions?.maxTokens;
    const maxTokens = remainingOutput === undefined
      ? existingMaxTokens
      : Math.min(existingMaxTokens ?? remainingOutput, remainingOutput);
    return streamDelegate(requestModel, context, {
      ...streamOptions,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      maxRetries: 0,
    });
  }) as ModelRuntime["streamSimple"];

  // 5. Settings manager: disable retry and compaction for evaluation arms
  const settingsManager = SettingsManager.create(options.cwd, agentDir);
  settingsManager.setRetryEnabled(false);
  settingsManager.setCompactionEnabled(false);

  // 6. Resource loader: strict ambient suppression and exact skill loading
  const additionalSkillPaths =
    options.arm === "treatment" && options.skillPath ? [options.skillPath] : [];

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
  ] as const;
  const restoredAppendMethods: Array<() => void> = [];
  if (options.nativeSessionRecorder) {
    const header = sessionManager.getHeader();
    if (header === null) {
      throw new EvalError("protocol-drift", "Pi 0.85.0 in-memory SessionManager returned no native header");
    }
    options.nativeSessionRecorder.record(structuredClone(header) as unknown as NativeSessionEntry);
    const mutableManager = sessionManager as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const methodName of decoratedAppendMethods) {
      const original = mutableManager[methodName];
      if (typeof original !== "function") {
        throw new EvalError("protocol-drift", `Pi 0.85.0 SessionManager is missing public ${methodName}`);
      }
      mutableManager[methodName] = (...args: unknown[]): unknown => {
        const id = original.apply(sessionManager, args);
        if (typeof id !== "string" || id === "") {
          throw new EvalError("protocol-drift", `Pi 0.85.0 ${methodName} returned no native entry ID`);
        }
        const actual = sessionManager.getEntry(id);
        if (actual === undefined) {
          throw new EvalError("protocol-drift", `Pi 0.85.0 ${methodName} entry ${id} was not retrievable`);
        }
        options.nativeSessionRecorder!.record(structuredClone(actual) as unknown as NativeSessionEntry);
        return id;
      };
      restoredAppendMethods.push(() => { mutableManager[methodName] = original; });
    }
  }

  // 8. Create the AgentSession
  // Baseline receives the shared client, but never treatment server configuration.
  if (options.arm === "baseline") {
    if (options.skillToolBundle !== undefined && options.skillToolBundle !== null && options.skillToolBundle.servers.length > 0) {
      throw new EvalError(
        "parity-violation",
        "baseline session cannot receive treatment MCP server configuration",
        { at: "pi.sdk.arm" },
      );
    }
  }

  const hasDeclaredMcp = options.arm === "treatment" && (options.skillToolBundle?.servers.length ?? 0) > 0;
  const mcpClient = hasDeclaredMcp ? await createMcpClient({
    conditionId: options.arm,
    bundle: options.skillToolBundle!,
    guardedSecrets: options.guardedSecrets ?? (options.apiKey ? [{ label: "api-key", value: options.apiKey }] : []),
    deadlineAtMs: options.deadlineAtMs ?? (Date.now() + 180_000),
    signal: options.signal,
  }) : null;

  const baseAllowedTools = options.allowedTools ? [...options.allowedTools] : ["read", "bash", "edit", "write"];
  if (baseAllowedTools.includes(MCP_CLIENT_TOOL_NAME) || options.ambientTools?.some((tool) => tool.name === MCP_CLIENT_TOOL_NAME)) {
    mcpClient?.dispose();
    throw new EvalError("parity-violation", "mcp is reserved for the shared client integration", { at: "pi.sdk.tools" });
  }
  const activeTools = hasDeclaredMcp ? [...baseAllowedTools, MCP_CLIENT_TOOL_NAME] : baseAllowedTools;
  const ambientDefs = options.ambientTools ? [...options.ambientTools] : [];
  const allCustomTools = mcpClient === null ? ambientDefs : [...ambientDefs, mcpClient.definition];
  const customTools = allCustomTools.length > 0 ? allCustomTools : undefined;
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: options.target.thinking as ThinkingLevel,
    tools: activeTools,
    customTools,
    resourceLoader,
    settingsManager,
    sessionManager,
  }).catch((error) => {
    mcpClient?.dispose();
    for (const restore of restoredAppendMethods) restore();
    if (createdTempAgentDir) rmSync(agentDir!, { recursive: true, force: true });
    throw error;
  });

  // Explicitly ensure retry and compaction are disabled on the session
  session.setAutoRetryEnabled(false);
  session.setAutoCompactionEnabled(false);

  // Compose the SDK's native tool/turn hooks rather than replacing its loop.
  const previousBeforeToolCall = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined> => {
    const previous = await previousBeforeToolCall?.(context, signal);
    if (previous?.block) return previous;
    if (budget && toolSteps >= budget.maxToolSteps) {
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
    if (mcpClient !== null && context.toolCall.name === MCP_CLIENT_TOOL_NAME && context.result.details?.isError === true) {
      return { ...previous, isError: true };
    }
    return previous;
  };

  const previousShouldStopAfterTurn = session.agent.shouldStopAfterTurn;
  session.agent.shouldStopAfterTurn = async (
    context: ShouldStopAfterTurnContext,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    if (await previousShouldStopAfterTurn?.(context, signal)) return true;
    if (!budget) return false;
    if (taskLimitReason !== null) return true;

    const needsContinuation = context.message.content.some((block) => block.type === "toolCall");
    if (providerRequests >= budget.maxProviderRequests && needsContinuation) {
      setTaskLimit(`provider requests budget of ${budget.maxProviderRequests} exhausted`);
      return true;
    }
    if (usageTotals.output > budget.maxOutputTokens ||
        (usageTotals.output === budget.maxOutputTokens && needsContinuation)) {
      setTaskLimit(`output token budget of ${budget.maxOutputTokens} exhausted`);
      return true;
    }
    return false;
  };

  const unsubscribeBudgetObserver = session.subscribe((event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    const message = event.message as AssistantMessage;
    if (observedMessages.has(message as object)) return;
    observedMessages.add(message as object);
    finalizedAssistantMessages += 1;
    const usage = (message as Partial<AssistantMessage>).usage as Record<string, unknown> | undefined;
    for (const component of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const value = usage?.[component];
      if (typeof value === "number") usageTotals[component] += value;
      else usageAvailable[component] = false;
    }
  });

  // 9. Attestation on THAT SAME session instance
  function attest(): PiSdkAttestation {
    const currentModel = session.model;
    if (!currentModel) {
      throw new EvalError("protocol-drift", "Session has no model configured");
    }
    if (currentModel.provider !== options.target.provider) {
      throw new EvalError(
        "protocol-drift",
        `Session model provider '${currentModel.provider}' does not match target provider '${options.target.provider}'`,
      );
    }
    if (currentModel.id !== options.target.model) {
      throw new EvalError(
        "protocol-drift",
        `Session model '${currentModel.id}' does not match target model '${options.target.model}'`,
      );
    }
    if (session.thinkingLevel !== options.target.thinking) {
      throw new EvalError(
        "protocol-drift",
        `Session thinking level '${session.thinkingLevel}' does not match target thinking '${options.target.thinking}'`,
      );
    }

    const currentTools = session.getActiveToolNames();
    const skills = session.resourceLoader.getSkills().skills;
    const agentsFiles = session.resourceLoader.getAgentsFiles().agentsFiles;
    const extensions = session.resourceLoader.getExtensions().extensions;
    const prompts = session.resourceLoader.getPrompts().prompts;
    const themes = session.resourceLoader.getThemes().themes;

    // Enforce arm isolation
    if (options.arm === "baseline" && skills.length !== 0) {
      throw new EvalError(
        "protocol-drift",
        `Baseline session has ${skills.length} skills loaded; expected exactly 0`,
      );
    }
    if (options.arm === "treatment" && skills.length !== 1) {
      throw new EvalError(
        "protocol-drift",
        `Treatment session has ${skills.length} skills loaded; expected exactly 1`,
      );
    }
    if (agentsFiles.length !== 0) {
      throw new EvalError(
        "protocol-drift",
        `Ambient AGENTS.md files entered session: count=${agentsFiles.length}`,
      );
    }
    if (extensions.length !== 0) {
      throw new EvalError(
        "protocol-drift",
        `Ambient extensions entered session: count=${extensions.length}`,
      );
    }
    if (prompts.length !== 0) {
      throw new EvalError(
        "protocol-drift",
        `Ambient prompt templates entered session: count=${prompts.length}`,
      );
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
      mcpClientId: mcpClient === null ? null : MCP_CLIENT_POLICY.id,
      seededMcpServers: mcpClient?.seededServers ?? [],
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

  async function runPrompt(promptText: string): Promise<void> {
    try {
      await session.prompt(promptText);
    } catch (error) {
      // Pi 0.85.0's post-run overflow check dereferences the statically-required
      // usage object even when a test-double response intentionally omits it. The
      // native agent turn and session entry are already finalized at this point.
      // Treat only that narrow telemetry-unavailable case as settled; every model,
      // tool, cancellation, and transport error keeps its native behavior.
      const lastMessage = session.messages.filter((message) => message.role === "assistant").at(-1) as Partial<AssistantMessage> | undefined;
      if (
        lastMessage?.role === "assistant" &&
        lastMessage.usage === undefined &&
        lastMessage.stopReason !== "error" &&
        lastMessage.stopReason !== "aborted" &&
        !session.isStreaming &&
        finalizedAssistantMessages > 0 &&
        isPinnedPostRunUsageError(error)
      ) {
        return;
      }
      throw error;
    }
  }

  function getBudgetSnapshot(): PiSdkBudgetSnapshot {
    const observed = finalizedAssistantMessages > 0;
    return {
      providerRequests,
      toolSteps,
      inputTokens: observed && usageAvailable.input ? usageTotals.input : null,
      outputTokens: observed && usageAvailable.output ? usageTotals.output : null,
      cacheReadTokens: observed && usageAvailable.cacheRead ? usageTotals.cacheRead : null,
      cacheWriteTokens: observed && usageAvailable.cacheWrite ? usageTotals.cacheWrite : null,
      taskLimitReason,
    };
  }

  function getNativeSessionEntries(): readonly NativeSessionEntry[] {
    // SessionManager intentionally excludes the metadata header from getEntries().
    // The evidence carrier represents native JSONL records, so retain the actual
    // header when the SDK has one rather than fabricating equivalent metadata.
    const header = session.sessionManager.getHeader();
    const entries = session.sessionManager.getEntries() as unknown as readonly NativeSessionEntry[];
    return header === null
      ? entries
      : [header as unknown as NativeSessionEntry, ...entries];
  }

  function dispose(): void {
    mcpClient?.dispose();
    unsubscribeBudgetObserver();
    for (const restore of restoredAppendMethods) restore();
    session.dispose();
    if (createdTempAgentDir && agentDir) {
      try {
        rmSync(agentDir, { recursive: true, force: true });
      } catch {
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
    setDeadline: (atMs: number) => {
      mcpClient?.setDeadline(atMs);
    },
    dispose,
  };
}
