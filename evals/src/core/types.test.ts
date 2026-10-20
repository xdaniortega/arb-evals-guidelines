/**
 * Schema rejection tests.
 *
 * Every decoder at the input boundary must fail closed: unknown fields, missing
 * fields, wrong types, wrong schema version, invalid tool names, and validator output
 * drift are all rejected rather than coerced, because a silently-accepted input would
 * be frozen into evidence and bound to both arms of a pair.
 */

import { describe, expect, it } from "vitest";
import {
  EvalError,
  LIMIT_KEYS,
  SAFE_DEFAULT_LIMITS,
  SCHEMA_VERSION,
  assertNotAborted,
  FRESH_RUN_CANDIDATE_MODE,
  HISTORICAL_CANDIDATE_MODE,
  decodeFreshCaseConfig,
  decodePartialLimits,
  decodeRetainedCaseConfig,
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

describe("decodeRetainedCaseConfig", () => {
  it("keeps a recorded file mode instead of the fresh-run default", () => {
    const config = decodeRetainedCaseConfig({ ...validCase, candidateMode: "file" }, "retained case configuration", {
      recordedCandidateMode: "file",
    });
    expect(config.candidateMode).toBe("file");
  });

  it("keeps a recorded workspace mode", () => {
    const config = decodeRetainedCaseConfig({ ...validCase, candidateMode: "workspace" }, "retained case configuration", {
      recordedCandidateMode: "workspace",
    });
    expect(config.candidateMode).toBe("workspace");
  });

  it("recovers an omitted mode from the recorded execution policy", () => {
    expect(
      decodeRetainedCaseConfig(validCase, "retained case configuration", { recordedCandidateMode: "workspace" })
        .candidateMode,
    ).toBe("workspace");
    expect(
      decodeRetainedCaseConfig(validCase, "retained case configuration", { recordedCandidateMode: "file" })
        .candidateMode,
    ).toBe("file");
  });

  it("falls back to the documented historical default, never the fresh-run default", () => {
    expect(HISTORICAL_CANDIDATE_MODE).toBe("file");
    expect(decodeRetainedCaseConfig(validCase, "retained case configuration").candidateMode).toBe("file");
  });

  it("rejects a retained mode that contradicts the recorded execution policy", () => {
    const error = expectEvalError(
      () =>
        decodeRetainedCaseConfig({ ...validCase, candidateMode: "workspace" }, "retained case configuration", {
          recordedCandidateMode: "file",
        }),
      "evidence-invalid",
    );
    expect(error.message).toContain("recorded file");
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

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, "5", null])("rejects invalid value %p", (value) => {
    expectEvalError(() => decodePartialLimits({ wallClockMs: value }, "limits"), "limit-invalid");
  });

  it("accepts every known limit key", () => {
    const input: Record<string, number> = {};
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
