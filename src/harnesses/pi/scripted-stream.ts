/**
 * Scripted native model stream driver for L1/L2 eval testing.
 *
 * Replaces ONLY `ModelRuntime.streamSimple` at the test boundary.
 * Does NOT replace `createAgentSession`, the agent tool loop, resource discovery,
 * or the session manager — all of those remain 100% real.
 *
 * Returns deterministic assistant text, tool calls, thinking, usage, and error events.
 *
 * HONEST LIMIT STATEMENT: Mocking completion proves target wiring and SDK behaviour —
 * it does NOT prove live authentication, provider wire-protocol compatibility,
 * quotas, latency or skill quality.
 */

import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelsSimpleStreamOptions,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export interface ScriptedToolCall {
  readonly id?: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface ScriptedTextStep {
  readonly type: "text";
  readonly text: string;
  readonly usage?: Usage;
  readonly stopReason?: StopReason;
  /** Raw provider stop reason (e.g. MAX_TOKENS/STOP) preserved verbatim on the message. */
  readonly rawStopReason?: string;
}

export interface ScriptedToolCallStep {
  readonly type: "toolCall";
  readonly toolCalls: readonly ScriptedToolCall[];
  readonly usage?: Usage;
  readonly stopReason?: StopReason;
}

export interface ScriptedThinkingStep {
  readonly type: "thinking";
  readonly thinking: string;
  readonly text: string;
  readonly signature?: string;
  readonly usage?: Usage;
  readonly stopReason?: StopReason;
}

export interface ScriptedErrorStep {
  readonly type: "error";
  readonly errorMessage: string;
  readonly stopReason?: "error" | "aborted";
}

export interface ScriptedStopStep {
  readonly type: "stop";
  readonly stopReason: StopReason;
  readonly text?: string;
  readonly usage?: Usage;
  /** Raw provider stop reason (e.g. MAX_TOKENS/STOP) preserved verbatim on the message. */
  readonly rawStopReason?: string;
}

export type ScriptedStep =
  | ScriptedTextStep
  | ScriptedToolCallStep
  | ScriptedThinkingStep
  | ScriptedErrorStep
  | ScriptedStopStep;

export type ScriptedDriver = (
  model: Model<Api>,
  context: Context,
  options?: ModelsSimpleStreamOptions,
) => ScriptedStep | Promise<ScriptedStep>;

let callCounter = 0;

function generateToolCallId(): string {
  callCounter += 1;
  return `tool_call_${Date.now()}_${callCounter}`;
}

/**
 * @notice Emulates provider streaming for deterministic tests without network requests.
 * @param stepsOrDriver Fixed responses or a request-aware response generator.
 * @returns An SDK-compatible streaming function with synthetic usage and stop reasons.
 */
export function createScriptedStreamSimple(stepsOrDriver: readonly ScriptedStep[] | ScriptedDriver) {
  const steps = Array.isArray(stepsOrDriver) ? [...stepsOrDriver] : undefined;
  const driver = typeof stepsOrDriver === "function" ? stepsOrDriver : undefined;
  let stepIndex = 0;

  return function scriptedStreamSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ) {
    const stream = createAssistantMessageEventStream();

    queueMicrotask(async () => {
      try {
        if (options?.signal?.aborted) {
          const abortedMsg = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            stopReason: "aborted",
            errorMessage: "Operation aborted",
            timestamp: Date.now(),
          } as unknown as AssistantMessage;
          stream.push({ type: "error", reason: "aborted", error: abortedMsg });
          stream.end(abortedMsg);
          return;
        }

        let step: ScriptedStep | undefined;
        if (driver) {
          step = await driver(model, context, options);
        } else if (steps && stepIndex < steps.length) {
          step = steps[stepIndex];
          stepIndex += 1;
        }

        if (!step) {
          const errorMsg = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            stopReason: "error",
            errorMessage: `No more scripted steps available (turn ${stepIndex})`,
            timestamp: Date.now(),
          } as unknown as AssistantMessage;
          stream.push({ type: "error", reason: "error", error: errorMsg });
          stream.end(errorMsg);
          return;
        }

        if (step.type === "error") {
          const stopReason = step.stopReason ?? "error";
          const errorMsg = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            stopReason,
            errorMessage: step.errorMessage,
            timestamp: Date.now(),
          } as unknown as AssistantMessage;
          stream.push({ type: "error", reason: stopReason, error: errorMsg });
          stream.end(errorMsg);
          return;
        }

        if (step.type === "toolCall") {
          const toolCalls: ToolCall[] = step.toolCalls.map((tc) => ({
            type: "toolCall",
            id: tc.id ?? generateToolCallId(),
            name: tc.name,
            arguments: tc.arguments as ToolCall["arguments"],
          }));
          const stopReason = step.stopReason ?? "toolUse";
          const msg = {
            role: "assistant",
            content: toolCalls,
            api: model.api,
            provider: model.provider,
            model: model.id,
            ...(step.usage === undefined ? {} : { usage: step.usage }),
            stopReason,
            timestamp: Date.now(),
          } as unknown as AssistantMessage;

          stream.push({ type: "start", partial: { ...msg, content: [] } });
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i]!;
            stream.push({ type: "toolcall_start", contentIndex: i, partial: msg });
            stream.push({
              type: "toolcall_delta",
              contentIndex: i,
              delta: JSON.stringify(tc.arguments),
              partial: msg,
            });
            stream.push({ type: "toolcall_end", contentIndex: i, toolCall: tc, partial: msg });
          }
          if (stopReason === "error" || stopReason === "aborted") {
            stream.push({ type: "error", reason: stopReason, error: msg });
          } else {
            const doneReason = stopReason === "length" || stopReason === "deferred" ? stopReason : "toolUse";
            stream.push({ type: "done", reason: doneReason, message: msg });
          }
          stream.end(msg);
          return;
        }

        if (step.type === "thinking") {
          const thinkingBlock: ThinkingContent = {
            type: "thinking",
            thinking: step.thinking,
            thinkingSignature: step.signature ?? "test-signature-12345",
          };
          const textBlock: TextContent = {
            type: "text",
            text: step.text,
          };
          const stopReason = step.stopReason ?? "stop";
          const msg = {
            role: "assistant",
            content: [thinkingBlock, textBlock],
            api: model.api,
            provider: model.provider,
            model: model.id,
            ...(step.usage === undefined ? {} : { usage: step.usage }),
            stopReason,
            timestamp: Date.now(),
          } as unknown as AssistantMessage;

          stream.push({ type: "start", partial: { ...msg, content: [] } });
          // Thinking block
          stream.push({ type: "thinking_start", contentIndex: 0, partial: msg });
          stream.push({ type: "thinking_delta", contentIndex: 0, delta: step.thinking, partial: msg });
          stream.push({ type: "thinking_end", contentIndex: 0, content: step.thinking, partial: msg });
          // Text block
          stream.push({ type: "text_start", contentIndex: 1, partial: msg });
          stream.push({ type: "text_delta", contentIndex: 1, delta: step.text, partial: msg });
          stream.push({ type: "text_end", contentIndex: 1, content: step.text, partial: msg });
          if (stopReason === "error" || stopReason === "aborted") {
            stream.push({ type: "error", reason: stopReason, error: msg });
          } else {
            const doneReason = stopReason === "length" || stopReason === "toolUse" || stopReason === "deferred" ? stopReason : "stop";
            stream.push({ type: "done", reason: doneReason, message: msg });
          }
          stream.end(msg);
          return;
        }

        if (step.type === "stop") {
          const stopReason = step.stopReason;
          const content: TextContent[] = step.text ? [{ type: "text", text: step.text }] : [];
          const msg = {
            role: "assistant",
            content,
            api: model.api,
            provider: model.provider,
            model: model.id,
            ...(step.usage === undefined ? {} : { usage: step.usage }),
            stopReason,
            ...(step.rawStopReason === undefined ? {} : { rawStopReason: step.rawStopReason }),
            timestamp: Date.now(),
          } as unknown as AssistantMessage;
          stream.push({ type: "start", partial: { ...msg, content: [] } });
          if (step.text) {
            stream.push({ type: "text_start", contentIndex: 0, partial: msg });
            stream.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial: msg });
            stream.push({ type: "text_end", contentIndex: 0, content: step.text, partial: msg });
          }
          if (stopReason === "error" || stopReason === "aborted") {
            stream.push({ type: "error", reason: stopReason, error: msg });
          } else {
            const doneReason = stopReason === "length" || stopReason === "toolUse" || stopReason === "deferred" ? stopReason : "stop";
            stream.push({ type: "done", reason: doneReason, message: msg });
          }
          stream.end(msg);
          return;
        }

        // text step
        const textBlock: TextContent = {
          type: "text",
          text: step.text,
        };
        const stopReason = step.stopReason ?? "stop";
        const msg = {
          role: "assistant",
          content: [textBlock],
          api: model.api,
          provider: model.provider,
          model: model.id,
          ...(step.usage === undefined ? {} : { usage: step.usage }),
          stopReason,
          ...(step.rawStopReason === undefined ? {} : { rawStopReason: step.rawStopReason }),
          timestamp: Date.now(),
        } as unknown as AssistantMessage;

        stream.push({ type: "start", partial: { ...msg, content: [] } });
        stream.push({ type: "text_start", contentIndex: 0, partial: msg });
        stream.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial: msg });
        stream.push({ type: "text_end", contentIndex: 0, content: step.text, partial: msg });
        if (stopReason === "error" || stopReason === "aborted") {
          stream.push({ type: "error", reason: stopReason, error: msg });
        } else {
          const doneReason = stopReason === "length" || stopReason === "toolUse" || stopReason === "deferred" ? stopReason : "stop";
          stream.push({ type: "done", reason: doneReason, message: msg });
        }
        stream.end(msg);
      } catch (err) {
        const errorMsg = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        } as unknown as AssistantMessage;
        stream.push({ type: "error", reason: "error", error: errorMsg });
        stream.end(errorMsg);
      }
    });

    return stream;
  };
}
