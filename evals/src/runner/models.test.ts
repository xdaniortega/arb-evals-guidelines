import { describe, expect, it, vi } from "vitest";
import { EvalError } from "../core/types.ts";
import {
  DISALLOWED_GOOGLE_MODEL_ALIASES,
  FROZEN_MODEL_ID,
  FROZEN_PROVIDER_ID,
  FROZEN_THINKING_LEVEL,
  PINNED_PI_ANTHROPIC_MODELS,
  PINNED_PI_GOOGLE_MODELS,
  resolveTargetConfiguration,
  validateTargetConfiguration,
  validateTargetModel,
  validateTargetThinking,
} from "./models.ts";

describe("models and freezing policy", () => {
  it("infers the exact catalog provider and defaults to low thinking", () => {
    for (const [model, provider] of [["gemini-3.8-flash", "google"], ["claude-opus-4-8", "anthropic"], ["claude-opus-5", "anthropic"]]) {
      expect(resolveTargetConfiguration({ model: model! })).toEqual({ provider, model, thinking: "low" });
      expect(resolveTargetConfiguration({ model: model!, provider })).toEqual(resolveTargetConfiguration({ model: model! }));
    }
  });

  it("refuses unknown models, contradictory providers, and unsupported thinking without substitution", () => {
    expect(() => resolveTargetConfiguration({ model: "gemini-unknown-9.9" })).toThrow("not in the supported pinned Pi catalog");
    expect(() => resolveTargetConfiguration({ model: "gemini-3.8-flash", provider: "anthropic" })).toThrow("Anthropic catalog");
    expect(() => resolveTargetConfiguration({ model: "claude-opus-5", provider: "google" })).toThrow("Google catalog");
    expect(() => resolveTargetConfiguration({ model: "gemini-3.8-flash", thinking: "minimal" })).toThrow("unsupported");
  });

  it("requires explicit provider disambiguation when an exact model appears in both catalogs", () => {
    const duplicate = vi.spyOn(PINNED_PI_ANTHROPIC_MODELS, "includes").mockReturnValue(true);
    try {
      expect(() => resolveTargetConfiguration({ model: "gemini-3.8-flash" })).toThrow("matches multiple providers");
      expect(resolveTargetConfiguration({ model: "gemini-3.8-flash", provider: "google" }).provider).toBe("google");
    } finally { duplicate.mockRestore(); }
  });

  it("freezes exactly one stable Gemini model", () => {
    expect(FROZEN_MODEL_ID).toBe("gemini-3.8-flash");
    expect(FROZEN_PROVIDER_ID).toBe("google");
    // `low`, not `off`/`minimal`: Pi coerces `off` -> `minimal`, and Google then rejects
    // MINIMAL for this model with 400 INVALID_ARGUMENT. `low` is the cheapest level the
    // provider actually accepts. See the rationale block in models.ts.
    expect(FROZEN_THINKING_LEVEL).toBe("low");
    expect(PINNED_PI_GOOGLE_MODELS).toContain(FROZEN_MODEL_ID);
    expect(FROZEN_MODEL_ID.includes("-preview")).toBe(false);
    expect(DISALLOWED_GOOGLE_MODEL_ALIASES).not.toContain(FROZEN_MODEL_ID);
  });

  it("accepts valid stable models from the pinned Pi catalog", () => {
    expect(() => validateTargetModel("google", "gemini-3.8-flash")).not.toThrow();
    expect(() => validateTargetModel("google", "gemini-2.5-flash")).not.toThrow();
    expect(() => validateTargetModel("google", "gemini-2.5-pro")).not.toThrow();
    expect(() => validateTargetModel("anthropic", "claude-sonnet-4-5")).not.toThrow();
    expect(() => validateTargetModel("anthropic", "claude-opus-4-6")).not.toThrow();
  });

  it("refuses moving alias models with input-invalid and no fallback", () => {
    for (const alias of DISALLOWED_GOOGLE_MODEL_ALIASES) {
      expect(() => validateTargetModel("google", alias)).toThrow(EvalError);
    }
  });

  it("refuses preview models with input-invalid and no fallback", () => {
    const previewModels = PINNED_PI_GOOGLE_MODELS.filter((m) => m.includes("-preview"));
    expect(previewModels.length).toBeGreaterThan(0);
    for (const preview of previewModels) {
      expect(() => validateTargetModel("google", preview)).toThrow(EvalError);
    }
  });

  it("refuses unknown models with input-invalid", () => {
    expect(() => validateTargetModel("google", "gemini-unknown-9.9")).toThrow(EvalError);
    expect(() => validateTargetModel("anthropic", "claude-unknown-9.9")).toThrow(EvalError);
    expect(() => validateTargetModel("unsupported-provider", "some-model")).toThrow(EvalError);
  });

  it("validates thinking level constraints per model", () => {
    // gemini-3.8-flash forbids off and minimal
    expect(() => validateTargetThinking("google", "gemini-3.8-flash", "off")).toThrow(EvalError);
    expect(() => validateTargetThinking("google", "gemini-3.8-flash", "minimal")).toThrow(EvalError);
    expect(() => validateTargetThinking("google", "gemini-3.8-flash", "low")).not.toThrow();
    expect(() => validateTargetThinking("google", "gemini-3.8-flash", "medium")).not.toThrow();

    // claude-sonnet-4-5 supports off..high, forbids max
    expect(() => validateTargetThinking("anthropic", "claude-sonnet-4-5", "low")).not.toThrow();
    expect(() => validateTargetThinking("anthropic", "claude-sonnet-4-5", "max")).toThrow(EvalError);

    // invalid thinking string
    expect(() => validateTargetThinking("google", "gemini-2.5-flash", "invalid-level")).toThrow(EvalError);
  });

  it("validates full target configuration with no catalog fallback", () => {
    expect(() =>
      validateTargetConfiguration({
        provider: "google",
        model: "gemini-3.8-flash",
        thinking: "low",
      }),
    ).not.toThrow();

    expect(() =>
      validateTargetConfiguration({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        thinking: "high",
      }),
    ).not.toThrow();

    expect(() =>
      validateTargetConfiguration({
        provider: "openai",
        model: "gpt-4o",
        thinking: "low",
      }),
    ).toThrow(EvalError);
  });
});
