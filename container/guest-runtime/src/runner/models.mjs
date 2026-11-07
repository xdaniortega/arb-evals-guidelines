/**
 * Model registry and freezing policy for reproducible evaluations.
 *
 * WHY this exists: evaluation results are only comparable if the underlying model is
 * pinned to an exact, immutable identity. Moving aliases (e.g., `gemini-flash-latest`)
 * silently drift over time, and preview models may be deprecated or altered without notice.
 *
 * We freeze `gemini-3.8-flash`: an exact, stable, non-preview, non-alias model present in
 * the pinned Pi 1.5.0 catalog.
 *
 * WHY the thinking level is `low`, which is neither the cheapest nor the obvious choice:
 *
 * Pi's catalog advertises off/minimal/low/medium/high/xhigh/max for this model, but two
 * separate layers disagree with that, and both were found empirically:
 *
 *   1. Pi silently COERCES `off`. Launching with `--thinking off` and reading `get_state`
 *      back returns `minimal`:
 *        requested='off'     -> get_state.thinkingLevel = "minimal"
 *        requested='minimal' -> get_state.thinkingLevel = "minimal"
 *      Freezing `off` would make every sealed receipt assert a target the runtime never
 *      applied. Arm-to-arm parity would still hold (both arms coerce identically), so this
 *      is an evidence-truthfulness bug rather than a parity bug — and the pre-prompt
 *      attestation correctly refused to proceed rather than record the falsehood.
 *
 *   2. Google then REJECTS the coerced value. The API returns:
 *        400 INVALID_ARGUMENT — "Thinking level MINIMAL is not supported for this model."
 *      So `off` and `minimal` are both unusable here, despite being advertised.
 *
 * `low` and `medium` were both verified to return a real completion. We freeze `low` as
 * the cheapest level the provider actually accepts. Revisit if Pi stops coercing `off` or
 * Google starts accepting MINIMAL.
 */
import { EvalError } from "../core/types.mjs";
export const FROZEN_MODEL_ID = "gemini-3.8-flash";
export const FROZEN_PROVIDER_ID = "google";
export const FROZEN_THINKING_LEVEL = "low";
export const FROZEN_TARGET = {
    provider: FROZEN_PROVIDER_ID,
    model: FROZEN_MODEL_ID,
    thinking: FROZEN_THINKING_LEVEL,
};
/**
 * Full catalog of Google models in pinned Pi 1.5.0.
 */
export const PINNED_PI_GOOGLE_MODELS = [
    "deep-research-max-preview-04-2026",
    "deep-research-preview-04-2026",
    "gemini-2.5-computer-use-preview-10-2025",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-preview",
    "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview-customtools",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    "gemini-4-argon",
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    "gemini-pro-latest",
    "gemini-robotics-er-2-preview",
    "gemma-4-26b-a4b-it",
    "gemma-4-31b-it",
];
export const DISALLOWED_GOOGLE_MODEL_ALIASES = [
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    "gemini-pro-latest",
];
/**
 * Full catalog of Anthropic models in pinned Pi 1.5.0.
 */
export const PINNED_PI_ANTHROPIC_MODELS = [
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-haiku-5-5",
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "claude-sonnet-5-5",
];
export const VALID_THINKING_LEVELS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];
/** Resolve an exact catalog model without credentials, prefix heuristics, or fallback. */
export function resolveTargetConfiguration(input) {
    const matches = [];
    if (PINNED_PI_GOOGLE_MODELS.includes(input.model))
        matches.push("google");
    if (PINNED_PI_ANTHROPIC_MODELS.includes(input.model))
        matches.push("anthropic");
    let provider;
    if (input.provider != null) {
        validateTargetModel(input.provider, input.model);
        provider = input.provider;
    }
    else {
        if (matches.length === 0)
            throw new EvalError("input-invalid", `model '${input.model}' is not in the supported pinned Pi catalog`, { at: "target.model" });
        if (matches.length !== 1)
            throw new EvalError("input-invalid", `model '${input.model}' matches multiple providers; specify --provider ${matches.join("|")}`, { at: "target.provider" });
        provider = matches[0];
    }
    const target = { provider, model: input.model, thinking: (input.thinking ?? FROZEN_THINKING_LEVEL) };
    validateTargetConfiguration(target);
    return target;
}
/**
 * Validates a target model against the pinned Pi catalog.
 *
 * Refuses:
 * - Unknown models not present in the pinned catalog
 * - Moving aliases that destroy reproducibility
 * - Preview models that lack stability guarantees
 *
 * Never falls back or substitutes a model.
 */
export function validateTargetModel(provider, model) {
    if (provider === "google") {
        if (!PINNED_PI_GOOGLE_MODELS.includes(model)) {
            throw new EvalError("input-invalid", `model '${model}' is not in the pinned Pi 1.5.0 Google catalog`, { at: "target.model" });
        }
        if (DISALLOWED_GOOGLE_MODEL_ALIASES.includes(model)) {
            throw new EvalError("input-invalid", `moving alias '${model}' is disallowed because aliases destroy reproducibility; use exact model '${FROZEN_MODEL_ID}'`, { at: "target.model" });
        }
        if (model.includes("-preview")) {
            throw new EvalError("input-invalid", `preview model '${model}' is disallowed for measured evaluations; use stable model '${FROZEN_MODEL_ID}'`, { at: "target.model" });
        }
    }
    else if (provider === "anthropic") {
        if (!PINNED_PI_ANTHROPIC_MODELS.includes(model)) {
            throw new EvalError("input-invalid", `model '${model}' is not in the pinned Pi 1.5.0 Anthropic catalog`, { at: "target.model" });
        }
        if (model.includes("-preview")) {
            throw new EvalError("input-invalid", `preview model '${model}' is disallowed for measured evaluations`, { at: "target.model" });
        }
    }
    else {
        throw new EvalError("input-invalid", `unsupported provider '${provider}'; only direct providers (google, anthropic) are supported`, { at: "target.provider" });
    }
}
/**
 * Validates thinking level for a specific provider and model.
 *
 * Enforces provider and model constraints before dispatch:
 * - Invalid thinking level names are rejected.
 * - gemini-3.8-flash rejects 'off' and 'minimal' (Google rejects minimal, Pi coerces off -> minimal).
 * - Models with specific effort constraints reject unsupported levels.
 */
export function validateTargetThinking(provider, model, thinking) {
    if (!VALID_THINKING_LEVELS.includes(thinking)) {
        throw new EvalError("input-invalid", `invalid thinking level '${thinking}'; must be one of: ${VALID_THINKING_LEVELS.join(", ")}`, { at: "target.thinking" });
    }
    if (provider === "google" && model === "gemini-3.8-flash") {
        if (thinking === "off" || thinking === "minimal") {
            throw new EvalError("input-invalid", `thinking level '${thinking}' is unsupported for Google '${model}' (coerced or rejected by provider); supported: low, medium, high, xhigh, max`, { at: "target.thinking" });
        }
    }
    if (provider === "anthropic" && model === "claude-sonnet-4-5") {
        const sonnetLevels = ["off", "minimal", "low", "medium", "high"];
        if (!sonnetLevels.includes(thinking)) {
            throw new EvalError("input-invalid", `thinking level '${thinking}' is unsupported for Anthropic '${model}'; supported: ${sonnetLevels.join(", ")}`, { at: "target.thinking" });
        }
    }
}
/**
 * Validates full target configuration before any prompt or session dispatch.
 * No catalog fallback or model substitution.
 */
export function validateTargetConfiguration(target) {
    validateTargetModel(target.provider, target.model);
    validateTargetThinking(target.provider, target.model, target.thinking);
}
