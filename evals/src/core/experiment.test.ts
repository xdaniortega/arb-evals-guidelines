/**
 * Path safety, canonical serialization, limit precedence, parity, and delta validity.
 *
 * These are the invariants the whole subsystem rests on: an unsafe path would escape a
 * root, a non-canonical hash would break reproducibility, a mis-resolved limit would
 * un-pair the arms, and a delta over an ungradeable pair would be a false measurement.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_RELATIVE_PATH_LENGTH,
  PARITY_FIELDS,
  assertParity,
  assertResourceNonce,
  assertSafeRelativePath,
  assertSafeSelector,
  buildConditionPlans,
  buildManifestTree,
  buildRunPlan,
  buildSchedule,
  canonicalJson,
  canonicalJsonSha256,
  computePairDelta,
  pairIdFor,
  resolveLimits,
  resourceNameFor,
  runIdFor,
  sha256Hex,
} from "./experiment.ts";
import type { ConditionGrade, ConditionPlan, ParityBinding } from "./experiment.ts";
import { EvalError, LIMIT_KEYS, SAFE_DEFAULT_LIMITS } from "./types.ts";
import type { Limits, RuntimeProfileId } from "./types.ts";

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

// ---------------------------------------------------------------------------
// Path rejection
// ---------------------------------------------------------------------------

describe("assertSafeRelativePath", () => {
  it("accepts a plain nested relative path", () => {
    expect(assertSafeRelativePath("a/b/c.json", "p")).toBe("a/b/c.json");
  });

  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["absolute", "/etc/passwd"],
    ["traversal", "../secret"],
    ["embedded traversal", "a/../../b"],
    ["single dot segment", "a/./b"],
    ["empty segment", "a//b"],
    ["trailing separator", "a/b/"],
    ["backslash", "a\\b"],
    ["NUL byte", "a\u0000b"],
    ["windows drive", "C:/Users/x"],
    ["windows drive lowercase", "c:x"],
    ["dotfile", ".env"],
    ["nested dotfile", "a/.git/config"],
    ["empty string", ""],
    ["space-led segment", " a"],
    ["over-length", `${"a".repeat(MAX_RELATIVE_PATH_LENGTH + 1)}`],
  ];

  it.each(rejected)("rejects %s", (_label, candidate) => {
    expectEvalError(() => assertSafeRelativePath(candidate, "p"), "path-unsafe");
  });

  it("rejects a non-string", () => {
    expectEvalError(() => assertSafeRelativePath(42, "p"), "path-unsafe");
  });

  it("assertSafeSelector applies the same rule", () => {
    expect(assertSafeSelector("chain-info/network-config-01", "--case")).toBe("chain-info/network-config-01");
    expectEvalError(() => assertSafeSelector("../other", "--case"), "path-unsafe");
  });
});

// ---------------------------------------------------------------------------
// Canonical JSON and hashing
// ---------------------------------------------------------------------------

class Widget {
  value = 1;
}

describe("canonicalJson", () => {
  it("sorts object keys deterministically at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson({ a: { c: 3, d: 2 }, b: 1 })).toBe(canonicalJson({ b: 1, a: { d: 2, c: 3 } }));
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("accepts a null-prototype object", () => {
    const record = Object.create(null) as Record<string, unknown>;
    record.a = 1;
    expect(canonicalJson(record)).toBe('{"a":1}');
  });

  const rejectedValues: ReadonlyArray<readonly [string, unknown]> = [
    ["Date", new Date(0)],
    ["Map", new Map([["a", 1]])],
    ["Set", new Set([1])],
    ["RegExp", /x/],
    ["class instance", new Widget()],
    ["Buffer", Buffer.from("x")],
    ["toJSON bearer", { toJSON: () => 1 }],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["function", () => 1],
    ["symbol", Symbol("x")],
    ["bigint", 1n],
  ];

  it.each(rejectedValues)("rejects %s", (_label, value) => {
    expectEvalError(() => canonicalJson(value), "evidence-invalid");
  });

  it("rejects undefined reachable as an object property and names its path", () => {
    const error = expectEvalError(() => canonicalJson({ a: { b: undefined } }), "evidence-invalid");
    expect(error.at).toBe("value.a.b");
  });

  it("rejects a rejected value nested in an array and names its index", () => {
    const error = expectEvalError(() => canonicalJson([1, new Date(0)]), "evidence-invalid");
    expect(error.at).toBe("value[1]");
  });

  it("canonicalJsonSha256 equals sha256 of the canonical form", () => {
    expect(canonicalJsonSha256({ b: 1, a: 2 })).toBe(sha256Hex('{"a":2,"b":1}'));
  });
});

describe("buildManifestTree", () => {
  const entry = (path: string) => ({ path, sha256: sha256Hex(path), bytes: path.length });

  it("sorts entries and is stable across input order", () => {
    const forward = buildManifestTree([entry("b.txt"), entry("a.txt"), entry("c/d.txt")]);
    const reverse = buildManifestTree([entry("c/d.txt"), entry("a.txt"), entry("b.txt")]);
    expect(forward.entries.map((item) => item.path)).toEqual(["a.txt", "b.txt", "c/d.txt"]);
    expect(forward.treeSha256).toBe(reverse.treeSha256);
  });

  it("rejects a duplicate path", () => {
    const error = expectEvalError(() => buildManifestTree([entry("a.txt"), entry("a.txt")]), "evidence-invalid");
    expect(error.message).toContain("duplicate path");
  });

  it("distinguishes different content", () => {
    const left = buildManifestTree([entry("a.txt")]);
    const right = buildManifestTree([{ path: "a.txt", sha256: sha256Hex("other"), bytes: 5 }]);
    expect(left.treeSha256).not.toBe(right.treeSha256);
  });
});

// ---------------------------------------------------------------------------
// Limit resolution
// ---------------------------------------------------------------------------

describe("resolveLimits", () => {
  it("falls back to safe defaults with default provenance", () => {
    const resolved = resolveLimits({ cli: {}, caseLimits: {}, suiteLimits: {}, runtimeProfileId: "default" });
    expect(resolved.limits).toEqual(SAFE_DEFAULT_LIMITS);
    for (const key of LIMIT_KEYS) expect(resolved.provenance[key]).toBe("default");
  });

  it("resolves CLI > case > suite > default and records provenance per layer", () => {
    const resolved = resolveLimits({
      cli: { wallClockMs: 1 },
      caseLimits: { wallClockMs: 2, maxToolSteps: 3 },
      suiteLimits: { wallClockMs: 4, maxToolSteps: 5, cpus: 6 },
      runtimeProfileId: "default",
    });
    expect(resolved.limits.wallClockMs).toBe(1);
    expect(resolved.provenance.wallClockMs).toBe("cli");
    expect(resolved.limits.maxToolSteps).toBe(3);
    expect(resolved.provenance.maxToolSteps).toBe("case");
    expect(resolved.limits.cpus).toBe(6);
    expect(resolved.provenance.cpus).toBe("suite");
    expect(resolved.limits.pids).toBe(SAFE_DEFAULT_LIMITS.pids);
    expect(resolved.provenance.pids).toBe("default");
  });

  it("rejects an unknown runtime profile", () => {
    const error = expectEvalError(
      () =>
        resolveLimits({
          cli: {},
          caseLimits: {},
          suiteLimits: {},
          runtimeProfileId: "stylus" as unknown as RuntimeProfileId,
        }),
      "input-invalid",
    );
    expect(error.message).toContain("unknown runtime profile");
  });

  it.each([0, -1, 2.5, Number.MAX_SAFE_INTEGER + 2])("rejects an invalid resolved limit %p", (value) => {
    expectEvalError(
      () => resolveLimits({ cli: { cpus: value }, caseLimits: {}, suiteLimits: {}, runtimeProfileId: "default" }),
      "limit-invalid",
    );
  });
});

// ---------------------------------------------------------------------------
// Parity
// ---------------------------------------------------------------------------

const limits: Limits = SAFE_DEFAULT_LIMITS;

function makeParity(overrides: Partial<ParityBinding> = {}): ParityBinding {
  return {
    promptSha256: sha256Hex("prompt"),
    fixtureTreeSha256: sha256Hex("fixture"),
    outputPath: "config.json",
    oracleSha256: sha256Hex("oracle"),
    validatorSha256: sha256Hex("validator"),
    validatorClosureSha256: sha256Hex("validator-closure"),
    allowedTools: ["read", "write"],
    harnessId: "fake",
    sandboxId: "fake",
    validatorRunnerId: "in-process",
    runtimeProfileId: "default",
    imageDigest: "sha256:abc",
    target: { provider: "google", model: "m", thinking: "off" },
    limits,
    networkPolicySha256: sha256Hex("net"),
    guestPolicySha256: sha256Hex("guest"),
    workspaceRoot: "/work",
    executionPolicySha256: sha256Hex("exec"),
    caseId: "network-config-01",
    caseVersion: 4,
    skillSnapshotTreeSha256: sha256Hex("skill"),
    skillToolBundleSha256: sha256Hex("bundle"),
    candidateMode: "file",
    ...overrides,
  };
}

/** Independently constructed plans, so parity is compared rather than shared. */
function plans(
  baselineParity: ParityBinding,
  treatmentParity: ParityBinding,
): readonly [ConditionPlan, ConditionPlan] {
  return [
    { conditionId: "baseline", skillPaths: [], parity: baselineParity },
    { conditionId: "treatment", skillPaths: ["/opt/skill"], parity: treatmentParity },
  ];
}

const divergentValues: Readonly<Record<keyof ParityBinding, unknown>> = {
  promptSha256: sha256Hex("other-prompt"),
  fixtureTreeSha256: sha256Hex("other-fixture"),
  outputPath: "other.json",
  oracleSha256: sha256Hex("other-oracle"),
  validatorSha256: sha256Hex("other-validator"),
  validatorClosureSha256: sha256Hex("other-validator-closure"),
  allowedTools: ["read"],
  harnessId: "other",
  sandboxId: "other",
  validatorRunnerId: "other",
  runtimeProfileId: "default",
  imageDigest: "sha256:def",
  target: { provider: "openai", model: "m", thinking: "off" },
  limits: { ...limits, cpus: limits.cpus + 1 },
  networkPolicySha256: sha256Hex("other-net"),
  guestPolicySha256: sha256Hex("other-guest"),
  workspaceRoot: "/other",
  executionPolicySha256: sha256Hex("other-exec"),
  caseId: "other-case",
  caseVersion: 5,
  skillSnapshotTreeSha256: sha256Hex("other-skill"),
  skillToolBundleSha256: sha256Hex("other-bundle"),
  candidateMode: "workspace",
};

describe("assertParity", () => {
  it("accepts two independently constructed identical bindings", () => {
    expect(() => assertParity(plans(makeParity(), makeParity()))).not.toThrow();
  });

  it("aborts when only skillToolBundleSha256 differs between conditions", () => {
    const baseline = makeParity({ skillToolBundleSha256: sha256Hex("bundle-a") });
    const treatment = makeParity({ skillToolBundleSha256: sha256Hex("bundle-b") });
    const error = expectEvalError(() => assertParity(plans(baseline, treatment)), "parity-violation");
    expect(error.message).toContain("skillToolBundleSha256");
    expect(error.at).toBe("parity.skillToolBundleSha256");
  });

  const divergable = PARITY_FIELDS.filter((field) => field !== "runtimeProfileId");

  it.each(divergable)("rejects divergence at %s and names the field", (field) => {
    const error = expectEvalError(
      () => assertParity(plans(makeParity(), makeParity({ [field]: divergentValues[field] } as Partial<ParityBinding>))),
      "parity-violation",
    );
    expect(error.message).toContain(field);
    expect(error.at).toBe(`parity.${field}`);
  });

  it("rejects a binding with a missing parity field", () => {
    const { caseId: _drop, ...incomplete } = makeParity();
    const error = expectEvalError(
      () => assertParity(plans(incomplete as unknown as ParityBinding, makeParity())),
      "parity-violation",
    );
    expect(error.message).toContain("missing field(s): caseId");
  });

  it("rejects a binding with an extra parity field", () => {
    const extended = { ...makeParity(), sneakyFlag: true } as unknown as ParityBinding;
    const error = expectEvalError(() => assertParity(plans(extended, makeParity())), "parity-violation");
    expect(error.message).toContain("unchecked field(s): sneakyFlag");
  });

  it("rejects a baseline that carries a skill path", () => {
    const parity = makeParity();
    const error = expectEvalError(
      () =>
        assertParity([
          { conditionId: "baseline", skillPaths: ["/opt/skill"], parity },
          { conditionId: "treatment", skillPaths: ["/opt/skill"], parity: makeParity() },
        ]),
      "parity-violation",
    );
    expect(error.message).toContain("baseline must receive zero skill paths");
  });

  it.each([[[] as readonly string[]], [["/a", "/b"] as readonly string[]]])(
    "rejects a treatment with %p skill paths",
    (skillPaths) => {
      const error = expectEvalError(
        () =>
          assertParity([
            { conditionId: "baseline", skillPaths: [], parity: makeParity() },
            { conditionId: "treatment", skillPaths, parity: makeParity() },
          ]),
        "parity-violation",
      );
      expect(error.message).toContain("treatment must receive exactly one skill path");
    },
  );

  it("rejects a swapped condition order", () => {
    const parity = makeParity();
    expectEvalError(
      () =>
        assertParity([
          { conditionId: "treatment", skillPaths: [], parity },
          { conditionId: "baseline", skillPaths: ["/opt/skill"], parity },
        ] as unknown as readonly [ConditionPlan, ConditionPlan]),
      "parity-violation",
    );
  });
});

describe("buildConditionPlans", () => {
  it("gives baseline zero and treatment exactly one skill path", () => {
    const [baseline, treatment] = buildConditionPlans(makeParity(), "/opt/skills/arbitrum-docs");
    expect(baseline.skillPaths).toEqual([]);
    expect(treatment.skillPaths).toEqual(["/opt/skills/arbitrum-docs"]);
  });

  it("rejects a relative or traversing guest skill path", () => {
    expectEvalError(() => buildConditionPlans(makeParity(), "opt/skill"), "path-unsafe");
    expectEvalError(() => buildConditionPlans(makeParity(), "/opt/../skill"), "path-unsafe");
  });

  it("rejects an empty image digest", () => {
    expectEvalError(() => buildConditionPlans(makeParity({ imageDigest: "" }), "/opt/skill"), "parity-violation");
  });
});

describe("buildRunPlan and schedule", () => {
  const base = {
    runId: "20240101T000000Z-abcdef01",
    mode: "fake" as const,
    suiteId: "arbitrum-docs",
    caseSelector: "chain-info/network-config-01",
    caseId: "network-config-01",
    caseVersion: 4,
    repetitions: 2,
    armOrder: ["baseline", "treatment"] as const,
    skillGuestPath: "/opt/skill",
    resourceNonce: "abc123",
    createdAt: "1970-01-01T00:00:00.000Z",
    source: { revision: "deadbeef", dirty: false },
    evaluatorBuild: "test",
    parity: makeParity(),
  };

  it("produces a deterministic plan hash and a sequential schedule", () => {
    const first = buildRunPlan(base);
    const second = buildRunPlan(base);
    expect(first.planSha256).toBe(second.planSha256);
    expect(first.schedule.map((step) => step.order)).toEqual([1, 2, 3, 4]);
    expect(first.schedule.map((step) => step.conditionId)).toEqual([
      "baseline",
      "treatment",
      "baseline",
      "treatment",
    ]);
  });

  it("rejects a bad repetition count and a bad arm order", () => {
    expectEvalError(() => buildRunPlan({ ...base, repetitions: 0 }), "input-invalid");
    expectEvalError(
      () => buildRunPlan({ ...base, armOrder: ["baseline", "baseline"] as never }),
      "input-invalid",
    );
  });

  it("buildSchedule pairs repetitions", () => {
    const steps = buildSchedule({ runId: "r", repetitions: 1, armOrder: ["baseline", "treatment"], resourceNonce: "abcd" });
    expect(steps).toHaveLength(2);
    expect(steps[0]?.pairId).toBe(pairIdFor("r", 1));
  });

  it("rejects an unusable resource nonce", () => {
    expectEvalError(() => assertResourceNonce("XYZ", "resourceNonce"), "input-invalid");
    expectEvalError(() => assertResourceNonce("ab", "resourceNonce"), "input-invalid");
    expect(assertResourceNonce("abcd", "resourceNonce")).toBe("abcd");
  });

  it("derives bounded lowercase resource names", () => {
    const name = resourceNameFor("guest", { runId: base.runId, resourceNonce: "abc123" }, 1, "treatment");
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("runIdFor rejects a bad nonce", () => {
    expect(runIdFor(new Date(0), "abcdef01")).toBe("19700101T000000Z-abcdef01");
    expectEvalError(() => runIdFor(new Date(0), "zz"), "input-invalid");
  });
});

// ---------------------------------------------------------------------------
// Delta validity
// ---------------------------------------------------------------------------

function grade(conditionId: "baseline" | "treatment", score: number | null, gradeable = true): ConditionGrade {
  return {
    conditionId,
    gradeable,
    validation:
      score === null
        ? { status: "infrastructure-failure", score: null, fullPass: null, checks: [{ id: "x", passed: false, message: "" }] }
        : { status: "graded", score, fullPass: score === 1, checks: [{ id: "x", passed: score === 1, message: "" }] },
  };
}

describe("computePairDelta", () => {
  it("returns a numeric delta only when both arms are graded", () => {
    const result = computePairDelta(grade("baseline", 0.25), grade("treatment", 0.75));
    expect(result).toEqual({ gradeable: true, delta: 0.5, reason: "both conditions graded" });
  });

  it("returns a null delta when the baseline is an infrastructure outcome", () => {
    const result = computePairDelta(grade("baseline", null), grade("treatment", 1));
    expect(result.gradeable).toBe(false);
    expect(result.delta).toBeNull();
    expect(result.reason).toContain("baseline");
  });

  it("returns a null delta when the treatment is an infrastructure outcome", () => {
    const result = computePairDelta(grade("baseline", 1), grade("treatment", null));
    expect(result.delta).toBeNull();
    expect(result.reason).toContain("treatment");
  });

  it("returns a null delta when a condition is flagged ungradeable despite a score", () => {
    const result = computePairDelta(grade("baseline", 1, false), grade("treatment", 1));
    expect(result.delta).toBeNull();
  });

  it("returns a null delta when a validation record is missing entirely", () => {
    const result = computePairDelta(
      { conditionId: "baseline", gradeable: true, validation: null },
      grade("treatment", 1),
    );
    expect(result.delta).toBeNull();
  });

  it("names both arms when neither is gradeable", () => {
    const result = computePairDelta(grade("baseline", null), grade("treatment", null));
    expect(result.reason).toContain("baseline, treatment");
  });
});
