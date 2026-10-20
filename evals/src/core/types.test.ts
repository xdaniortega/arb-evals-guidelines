/**
 * @notice Verifies schema decoders reject malformed, unknown, or incompatible evaluation inputs.
 */

import { describe, expect, it } from "vitest";
import {
  EvalError,
  LIMIT_KEYS,
  SAFE_DEFAULT_LIMITS,
  STOP_CAUSES,
  deriveStopCause,
  resolveGuestTimeouts,
  SCHEMA_VERSION,
  assertNotAborted,
  FRESH_RUN_CANDIDATE_MODE,
  decodeFreshCaseConfig,
  decodePartialLimits,
  decodeSuiteConfig,
  decodeValidationOutcome,
  requireEnum,
  requireKeys,
  requirePositiveInteger,
  requireRecord,
  requireString,
  requireUniqueStringArray,
  toStructuredFailure,
} from "./types.ts";

describe("shared guest timeouts", () => {
  it("defaults all four task budgets to unlimited (null) and keeps resource bounds finite", () => {
    expect(SAFE_DEFAULT_LIMITS.wallClockMs).toBeNull();
    expect(SAFE_DEFAULT_LIMITS.maxOutputTokens).toBeNull();
    expect(SAFE_DEFAULT_LIMITS.maxToolSteps).toBeNull();
    expect(SAFE_DEFAULT_LIMITS.maxProviderRequests).toBeNull();

    for (const key of ["maxExportedFiles", "maxExportedFileBytes", "maxWorkspaceBytes", "cpus", "memoryMiB", "pids", "diskMiB"] as const) {
      expect(SAFE_DEFAULT_LIMITS[key]).toBeGreaterThan(0);
    }
  });

  it.each([1, 110_000, 300_000, 600_000, 900_000])("nests finite host and guest lifetimes for %ims per arm", (wallClockMs) => {
    const timeouts = resolveGuestTimeouts(wallClockMs);

    expect(timeouts.prePromptMs).toBe(620_000 + wallClockMs);
    expect(timeouts.supervisorMs).toBe(930_000 + wallClockMs + Math.max(wallClockMs, 180_000));
    expect(timeouts.streamMs).not.toBeNull();
    expect(timeouts.supervisorMs).not.toBeNull();
    expect(timeouts.streamMs! - timeouts.supervisorMs!).toBe(20_000);
    expect(timeouts.supervisorMs!).toBeGreaterThan(timeouts.prePromptMs! + wallClockMs);
  });

  it("arms NO wall-clock-derived guest deadline for an unlimited (null) arm", () => {
    const timeouts = resolveGuestTimeouts(null);
    expect(timeouts.prePromptMs).toBeNull();
    expect(timeouts.supervisorMs).toBeNull();
    expect(timeouts.streamMs).toBeNull();
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid finite arm allowance %s", (wallClockMs) => {
    expect(() => resolveGuestTimeouts(wallClockMs)).toThrow("positive integer or null");
  });
});

function expectEvalError(fn: () => unknown, code: string): EvalError {
  let caught: unknown;
  try {
    fn();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EvalError);
  const error = caught as EvalError;
  expect(error.code).toBe(code);
  return error;
}

const validSuite = {
  schemaVersion: SCHEMA_VERSION,
  id: "arbitrum-docs",
  skillPath: "skills/arbitrum-docs",
};

const validCase = {
  id: "network-config-01",
  version: 4,
  prompt: "do the thing",
  outputPath: "config.json",
  allowedTools: ["read", "write"],
  validator: "validator.ts",
};

describe("decodeSuiteConfig", () => {
  it("accepts a minimal suite and applies defaults", () => {
    const config = decodeSuiteConfig(validSuite, "eval.json");
    expect(config.runtimeProfileId).toBe("default");
    expect(config.limits).toEqual({});
  });

  it("rejects an unknown field", () => {
    const error = expectEvalError(() => decodeSuiteConfig({ ...validSuite, extra: 1 }, "eval.json"), "input-invalid");
    expect(error.message).toContain("unknown field(s): extra");
  });

  it("rejects a missing required field", () => {
    const error = expectEvalError(
      () => decodeSuiteConfig({ schemaVersion: SCHEMA_VERSION, id: "x" }, "eval.json"),
      "input-invalid",
    );
    expect(error.message).toContain("skillPath");
  });

  it("rejects a wrong-typed field", () => {
    expectEvalError(() => decodeSuiteConfig({ ...validSuite, id: 7 }, "eval.json"), "input-invalid");
  });

  it("rejects a wrong schemaVersion", () => {
    const error = expectEvalError(
      () => decodeSuiteConfig({ ...validSuite, schemaVersion: SCHEMA_VERSION + 1 }, "eval.json"),
      "input-invalid",
    );
    expect(error.message).toContain(`must be ${SCHEMA_VERSION}`);
  });

  it("rejects a non-object", () => {
    expectEvalError(() => decodeSuiteConfig([], "eval.json"), "input-invalid");
    expectEvalError(() => decodeSuiteConfig(null, "eval.json"), "input-invalid");
  });

  it("rejects an unknown runtimeProfileId", () => {
    const error = expectEvalError(
      () => decodeSuiteConfig({ ...validSuite, runtimeProfileId: "stylus" }, "eval.json"),
      "input-invalid",
    );
    expect(error.at).toBe("eval.json.runtimeProfileId");
  });
});

describe("decodeFreshCaseConfig", () => {
  it("applies fixtureDir and oracle defaults and a null profile", () => {
    const config = decodeFreshCaseConfig(validCase, "case.json");
    expect(config.fixtureDir).toBe("fixture");
    expect(config.oracle).toBe("oracle.json");
    expect(config.runtimeProfileId).toBeNull();
  });

  it("rejects an unknown field", () => {
    expectEvalError(() => decodeFreshCaseConfig({ ...validCase, notes: "hi" }, "case.json"), "input-invalid");
  });

  it("rejects a missing required field", () => {
    const { validator: _drop, ...withoutValidator } = validCase;
    expectEvalError(() => decodeFreshCaseConfig(withoutValidator, "case.json"), "input-invalid");
  });

  it("rejects a non-integer version", () => {
    expectEvalError(() => decodeFreshCaseConfig({ ...validCase, version: 1.5 }, "case.json"), "input-invalid");
  });

  it("rejects an invalid tool name", () => {
    for (const tool of ["Read", "rm -rf", "1tool", "", "tool!"]) {
      expectEvalError(
        () => decodeFreshCaseConfig({ ...validCase, allowedTools: [tool] }, "case.json"),
        "input-invalid",
      );
    }
  });

  it("rejects duplicate tool names and an empty tool list", () => {
    expectEvalError(() => decodeFreshCaseConfig({ ...validCase, allowedTools: ["read", "read"] }, "case.json"), "input-invalid");
    expectEvalError(() => decodeFreshCaseConfig({ ...validCase, allowedTools: [] }, "case.json"), "input-invalid");
  });

  it("rejects a case requesting glob with actionable guidance to use native find", () => {
    const error = expectEvalError(
      () => decodeFreshCaseConfig({ ...validCase, allowedTools: ["read", "glob"] }, "case.json"),
      "input-invalid",
    );
    expect(error.message).toContain('allowedTools: "glob" is no longer provided; use "find" (Pi native)');
  });

  it("rejects an unknown runtimeProfileId in a case", () => {
    expectEvalError(() => decodeFreshCaseConfig({ ...validCase, runtimeProfileId: "nope" }, "case.json"), "input-invalid");
  });

  it("resolves an unauthored collection mode to bounded workspace collection", () => {
    expect(FRESH_RUN_CANDIDATE_MODE).toBe("workspace");
    expect(decodeFreshCaseConfig(validCase, "case.json").candidateMode).toBe("workspace");
  });

  it("still accepts an explicit workspace selection for compatibility", () => {
    const config = decodeFreshCaseConfig({ ...validCase, candidateMode: "workspace" }, "case.json");
    expect(config.candidateMode).toBe("workspace");
  });

  it("rejects an obsolete explicit file selection with an actionable message", () => {
    const error = expectEvalError(
      () => decodeFreshCaseConfig({ ...validCase, candidateMode: "file" }, "case.json"),
      "input-invalid",
    );
    expect(error.at).toBe("case.json.candidateMode");
    expect(error.message).toContain("remove the candidateMode field");
  });

  it("rejects an unsupported mode value", () => {
    expectEvalError(() => decodeFreshCaseConfig({ ...validCase, candidateMode: "all" }, "case.json"), "input-invalid");
  });

  it("accepts the workspace output marker without an authored mode", () => {
    const config = decodeFreshCaseConfig({ ...validCase, outputPath: "__workspace__" }, "case.json");
    expect(config.outputPath).toBe("__workspace__");
    expect(config.candidateMode).toBe("workspace");
  });
});

describe("decodePartialLimits", () => {
  it("returns an empty object for undefined", () => {
    expect(decodePartialLimits(undefined, "limits")).toEqual({});
  });

  it("rejects an unknown limit key", () => {
    const error = expectEvalError(() => decodePartialLimits({ ludicrousSpeed: 1 }, "limits"), "input-invalid");
    expect(error.message).toContain("ludicrousSpeed");
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 2, "5"])("rejects invalid value %p", (value) => {
    expectEvalError(() => decodePartialLimits({ wallClockMs: value }, "limits"), "limit-invalid");
  });

  it("accepts finite arm limits longer than Node's single-timer range", () => {
    expect(decodePartialLimits({ wallClockMs: 2_147_483_648 }, "limits")).toEqual({ wallClockMs: 2_147_483_648 });
  });

  it.each([0, null])("decodes %p as an unlimited (null) wall clock", (value) => {
    expect(decodePartialLimits({ wallClockMs: value }, "limits")).toEqual({ wallClockMs: null });
  });

  it.each(["wallClockMs", "maxOutputTokens", "maxToolSteps", "maxProviderRequests"] as const)(
    "normalizes 0 and null to unlimited for task budget %s",
    (key) => {
      expect(decodePartialLimits({ [key]: 0 }, "limits")).toEqual({ [key]: null });
      expect(decodePartialLimits({ [key]: null }, "limits")).toEqual({ [key]: null });
      expect(decodePartialLimits({ [key]: 5 }, "limits")).toEqual({ [key]: 5 });
    },
  );

  it.each(["maxOutputTokens", "maxToolSteps", "maxProviderRequests"] as const)(
    "rejects a fractional/unsafe/negative task budget %s",
    (key) => {
      for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
        expectEvalError(() => decodePartialLimits({ [key]: bad }, "limits"), "limit-invalid");
      }
    },
  );

  it.each(["maxExportedFiles", "maxWorkspaceBytes", "cpus", "memoryMiB", "pids", "diskMiB"] as const)(
    "refuses to disable resource/isolation bound %s via 0 or null",
    (key) => {
      expectEvalError(() => decodePartialLimits({ [key]: 0 }, "limits"), "limit-invalid");
      expectEvalError(() => decodePartialLimits({ [key]: null }, "limits"), "limit-invalid");
    },
  );

  it("accepts every known limit key", () => {
    const input: Record<string, number | null> = {};
    for (const key of LIMIT_KEYS) input[key] = SAFE_DEFAULT_LIMITS[key];
    expect(decodePartialLimits(input, "limits")).toEqual(SAFE_DEFAULT_LIMITS);
  });
});

describe("decodeValidationOutcome", () => {
  const check = { id: "c1", passed: true, message: "ok" };

  it("accepts a graded outcome", () => {
    const outcome = decodeValidationOutcome({ status: "graded", score: 0.5, fullPass: false, checks: [check] }, "v");
    expect(outcome.score).toBe(0.5);
  });

  it("rejects a graded outcome with a null score", () => {
    const error = expectEvalError(
      () => decodeValidationOutcome({ status: "graded", score: null, fullPass: false, checks: [check] }, "v"),
      "protocol-drift",
    );
    expect(error.at).toBe("v.score");
  });

  it("rejects an infrastructure outcome with a non-null score", () => {
    expectEvalError(
      () => decodeValidationOutcome({ status: "infrastructure-failure", score: 0, fullPass: null, checks: [check] }, "v"),
      "protocol-drift",
    );
  });

  it("rejects an infrastructure outcome with a non-null fullPass", () => {
    expectEvalError(
      () => decodeValidationOutcome({ status: "infrastructure-failure", score: null, fullPass: true, checks: [check] }, "v"),
      "protocol-drift",
    );
  });

  it("rejects an empty checks array", () => {
    expectEvalError(
      () => decodeValidationOutcome({ status: "graded", score: 1, fullPass: true, checks: [] }, "v"),
      "protocol-drift",
    );
  });

  it.each([-0.0001, 1.0001, Number.NaN, Number.POSITIVE_INFINITY])("rejects out-of-range score %p", (score) => {
    expectEvalError(
      () => decodeValidationOutcome({ status: "graded", score, fullPass: true, checks: [check] }, "v"),
      "protocol-drift",
    );
  });

  it("rejects a non-boolean check.passed and a non-boolean fullPass", () => {
    expectEvalError(
      () => decodeValidationOutcome({ status: "graded", score: 1, fullPass: "yes", checks: [check] }, "v"),
      "protocol-drift",
    );
    expectEvalError(
      () =>
        decodeValidationOutcome(
          { status: "graded", score: 1, fullPass: true, checks: [{ id: "c", passed: "yes", message: "" }] },
          "v",
        ),
      "protocol-drift",
    );
  });

  it("rejects an unknown status", () => {
    expectEvalError(
      () => decodeValidationOutcome({ status: "passed", score: 1, fullPass: true, checks: [check] }, "v"),
      "input-invalid",
    );
  });
});

describe("primitive decode helpers", () => {
  it("requireRecord rejects arrays and null", () => {
    expectEvalError(() => requireRecord([], "x"), "input-invalid");
    expectEvalError(() => requireRecord(null, "x"), "input-invalid");
  });

  it("requireString rejects blank strings", () => {
    expectEvalError(() => requireString("   ", "x"), "input-invalid");
  });

  it("requirePositiveInteger rejects zero", () => {
    expectEvalError(() => requirePositiveInteger(0, "x"), "input-invalid");
  });

  it("requireUniqueStringArray rejects a non-array", () => {
    expectEvalError(() => requireUniqueStringArray("a", "x"), "input-invalid");
  });

  it("requireEnum names the allowed values", () => {
    const error = expectEvalError(() => requireEnum("c", ["a", "b"] as const, "x"), "input-invalid");
    expect(error.message).toContain("a, b");
  });

  it("requireKeys reports unknown before missing", () => {
    expectEvalError(() => requireKeys({ a: 1 }, { required: ["b"] }, "x"), "input-invalid");
  });
});

describe("errors and cancellation", () => {
  it("classifies every EvalError as infrastructure", () => {
    expect(new EvalError("input-invalid", "m").failureClass).toBe("infrastructure");
  });

  it("assertNotAborted throws interrupted once aborted", () => {
    const controller = new AbortController();
    expect(() => assertNotAborted(controller.signal, "op")).not.toThrow();
    controller.abort();
    expectEvalError(() => assertNotAborted(controller.signal, "op"), "interrupted");
  });

  it("toStructuredFailure preserves an EvalError and wraps anything else", () => {
    expect(toStructuredFailure(new EvalError("path-unsafe", "m", { at: "p" }), "input-invalid")).toEqual({
      code: "path-unsafe",
      failureClass: "infrastructure",
      message: "m",
      at: "p",
    });
    expect(toStructuredFailure("boom", "input-invalid").code).toBe("input-invalid");
  });
});

describe("deriveStopCause — precise, provider-native-vs-harness-cap classification", () => {
  it("maps completion, cancellation, and infrastructure terminal classes directly", () => {
    expect(deriveStopCause({ terminalClass: "completed", semanticAbortCause: null, taskLimitReason: null, stopReason: "stop" })).toBe("completed");
    expect(deriveStopCause({ terminalClass: "interrupted", semanticAbortCause: "external", taskLimitReason: null, stopReason: "aborted" })).toBe("external-cancellation");
    expect(deriveStopCause({ terminalClass: "execution-failure", semanticAbortCause: null, taskLimitReason: null, stopReason: "error" })).toBe("infrastructure-error");
    expect(deriveStopCause({ terminalClass: "unexpected-abort", semanticAbortCause: null, taskLimitReason: null, stopReason: null })).toBe("unexpected-abort");
  });

  it("names each finite cumulative budget from its reason string", () => {
    expect(deriveStopCause({ terminalClass: "task-limit", semanticAbortCause: null, taskLimitReason: "output token budget of 8000 exhausted", stopReason: "length" })).toBe("cumulative-output-tokens");
    expect(deriveStopCause({ terminalClass: "task-limit", semanticAbortCause: null, taskLimitReason: "tool steps budget of 120 exhausted", stopReason: null })).toBe("tool-steps");
    expect(deriveStopCause({ terminalClass: "task-limit", semanticAbortCause: null, taskLimitReason: "provider requests budget of 200 exhausted", stopReason: null })).toBe("provider-requests");
    expect(deriveStopCause({ terminalClass: "task-limit", semanticAbortCause: "arm-budget", taskLimitReason: "wall-clock deadline of 300000ms elapsed", stopReason: null })).toBe("wall-clock");
  });

  it("maps a harness-initiated arm wall-clock abort (no reason string) to wall-clock", () => {
    expect(deriveStopCause({ terminalClass: "task-limit", semanticAbortCause: "arm-budget", taskLimitReason: null, stopReason: null })).toBe("wall-clock");
  });

  it("reports an UNLIMITED arm's native `length` truncation as provider-response-length, never a cumulative cap", () => {
    // No harness reason string: the provider truncated on its own per-response/context
    // limit while output was unlimited (no clamp was ever injected).
    expect(deriveStopCause({ terminalClass: "task-limit", semanticAbortCause: null, taskLimitReason: null, stopReason: "length" })).toBe("provider-response-length");
  });

  it("attributes a clamped near-boundary `length` stop to the cumulative cap even when usage never equals the cap", () => {
    // Observed finite-cap case: provider stopped at `length` with cumulative 7996 while a
    // clamped remaining allowance (cap 8000) was the binding maxTokens. The harness names
    // this an output-token exhaustion at the source; the reason string carries "output
    // token", so it classifies as cumulative-output-tokens — NOT provider-response-length
    // merely because 7996 !== 8000. This is the injected clamp, not a native limit.
    expect(
      deriveStopCause({
        terminalClass: "task-limit",
        semanticAbortCause: null,
        taskLimitReason: "output token budget of 8000 exhausted (provider truncated at clamped remaining allowance)",
        stopReason: "length",
      }),
    ).toBe("cumulative-output-tokens");
  });

  it("returns unknown for a task-limit with neither an attributable reason nor a length/arm-budget signal", () => {
    expect(deriveStopCause({ terminalClass: "task-limit", semanticAbortCause: null, taskLimitReason: null, stopReason: "stop" })).toBe("unknown");
  });

  it("only ever returns a declared stop cause", () => {
    const causes = new Set<string>(STOP_CAUSES);
    for (const stopReason of ["length", "stop", "error", "aborted", null] as const) {
      for (const semanticAbortCause of ["external", "arm-budget", null] as const) {
        const cause = deriveStopCause({ terminalClass: "task-limit", semanticAbortCause, taskLimitReason: null, stopReason });
        expect(causes.has(cause)).toBe(true);
      }
    }
  });
});
