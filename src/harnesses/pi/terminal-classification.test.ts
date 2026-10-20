/**
 * @notice Verifies shared terminal classification and generated guest parity for completion, limits, errors, cancellation, and aborts.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyTerminalState, failureCodeForTerminalClass } from "./terminal-classification.ts";

type Input = Parameters<typeof classifyTerminalState>[0];
type TerminalClass = ReturnType<typeof classifyTerminalState>["terminalClass"];
type StopCause = ReturnType<typeof classifyTerminalState>["stopCause"];
type FailureCode = ReturnType<typeof classifyTerminalState>["failureCode"];
type Case = readonly [
  name: string,
  input: Input,
  terminalClass: TerminalClass,
  stopCause: StopCause,
  failureCode: FailureCode,
  providerStopReason?: string | null,
];

const cases: Case[] = [
  ["clean completion", { stopReason: "stop", rawStopReason: "STOP" }, "completed", "completed", null, "STOP"],
  ["unsolicited abort", { stopReason: "aborted", rawStopReason: "ABORTED" }, "unexpected-abort", "unexpected-abort", "protocol-drift", "ABORTED"],
  ["unsolicited abort with standard message", { stopReason: "aborted", errorMessage: "This operation was aborted" }, "unexpected-abort", "unexpected-abort", "protocol-drift", "aborted"],
  ["aborted response with arbitrary error", { stopReason: "aborted", errorMessage: "upstream connection dropped: unexpected EOF" }, "execution-failure", "infrastructure-error", "provider-error", "aborted"],
  ["external cancellation", { stopReason: "aborted", semanticAbortCause: "external" }, "interrupted", "external-cancellation", "interrupted", "aborted"],
  [
    "requested abort reported as provider error",
    {
      stopReason: "error",
      errorMessage: "operation was aborted",
      semanticAbortCause: "external",
      executionError: Object.assign(new Error("aborted"), { name: "AbortError" }),
    },
    "interrupted", "external-cancellation", "interrupted", "aborted",
  ],
  ["provider error beats cancellation", { stopReason: "error", errorMessage: "quota exceeded (429)", semanticAbortCause: "external" }, "execution-failure", "infrastructure-error", "provider-error", "error"],
  ["arbitrary abort error beats arm budget", { stopReason: "aborted", errorMessage: "upstream failure", semanticAbortCause: "arm-budget" }, "execution-failure", "infrastructure-error", "provider-error", "aborted"],
  ["wall-clock deadline", { stopReason: "aborted", semanticAbortCause: "arm-budget", taskLimitReason: "wall-clock deadline of 600000ms elapsed" }, "task-limit", "wall-clock", null, "aborted"],
  ["arm-budget abort without reason", { stopReason: "aborted", semanticAbortCause: "arm-budget" }, "task-limit", "wall-clock", null, "aborted"],
  ["output-token exhaustion", { stopReason: "aborted", taskLimitReason: "output token budget of 100 exhausted" }, "task-limit", "cumulative-output-tokens", null, "aborted"],
  ["tool-step exhaustion", { stopReason: "aborted", taskLimitReason: "tool steps budget of 10 exhausted" }, "task-limit", "tool-steps", null, "aborted"],
  ["provider-request exhaustion", { stopReason: "aborted", taskLimitReason: "provider requests budget of 5 exhausted" }, "task-limit", "provider-requests", null, "aborted"],
  ["provider response-length limit", { stopReason: "length", rawStopReason: "MAX_TOKENS" }, "task-limit", "provider-response-length", null, "MAX_TOKENS"],
  ["clamped length with cumulative reason", { stopReason: "length", taskLimitReason: "output token budget of 100 exhausted" }, "task-limit", "cumulative-output-tokens", null, "length"],
  ["explicit protocol drift", { stopReason: "error", errorMessage: "protocol-drift: invalid frame" }, "execution-failure", "infrastructure-error", "protocol-drift", "error"],
];

function outcomeFor(terminalClass: TerminalClass) {
  if (terminalClass === "completed") return "completed";
  if (terminalClass === "task-limit") return "task-limit";
  return "infrastructure-failure";
}

describe("terminal classification", () => {
  for (const [name, input, terminalClass, stopCause, failureCode, providerStopReason] of cases) {
    it(`classifies ${name}`, () => {
      expect(classifyTerminalState(input)).toEqual({
        terminalClass,
        outcome: outcomeFor(terminalClass),
        stopCause,
        failureCode,
        normalizedStopReason: input.stopReason === "error" && terminalClass === "interrupted"
          ? "aborted"
          : input.stopReason ?? null,
        providerStopReason: providerStopReason ?? input.rawStopReason ?? input.stopReason ?? null,
      });
    });
  }

  it("matches the generated guest classifier", async () => {
    const guestPath = join(process.cwd(), "container/guest-runtime/src/harnesses/pi/terminal-classification.mjs");
    const guest = await import(pathToFileURL(guestPath).href) as {
      classifyTerminalState: typeof classifyTerminalState;
    };
    const input: Input = { stopReason: "aborted", errorMessage: "upstream failure" };
    expect(guest.classifyTerminalState(input)).toEqual(classifyTerminalState(input));
  });
});

describe("failure code mapping", () => {
  it.each([
    ["interrupted", null, "interrupted"],
    ["unexpected-abort", null, "protocol-drift"],
    ["execution-failure", null, "provider-error"],
    ["execution-failure", "protocol-drift occurred", "protocol-drift"],
    ["execution-failure", "saw drift_event", "protocol-drift"],
    ["completed", null, null],
    ["task-limit", null, null],
  ] as const)("maps %s with %s", (terminalClass, errorText, expected) => {
    expect(failureCodeForTerminalClass(terminalClass, errorText)).toBe(expected);
  });
});
