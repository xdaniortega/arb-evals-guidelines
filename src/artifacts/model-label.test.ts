import { describe, expect, it } from "vitest";
import { formatModelLabel } from "./model-label.ts";

describe("formatModelLabel", () => {
  it("renders known provider models readably", () => {
    expect(formatModelLabel({ provider: "google", model: "gemini-3.8-flash" })).toBe("Google Gemini 3.8 Flash");
    expect(formatModelLabel({ provider: "google", model: "gemini-4.0-pro" })).toBe("Google Gemini 4.0 Pro");
    expect(formatModelLabel({ provider: "anthropic", model: "claude-sonnet-4-5" })).toBe("Anthropic Claude Sonnet 4.5");
    expect(formatModelLabel({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" })).toBe("Anthropic Claude Sonnet 4.5 20250929");
    expect(formatModelLabel({ provider: "openai", model: "gpt-5" })).toBe("OpenAI GPT 5");
  });

  it("does not merge date stamps or leading-zero tokens into versions", () => {
    expect(formatModelLabel({ provider: "google", model: "gemini-2.5-flash-preview-05-20" })).toBe("Google Gemini 2.5 Flash Preview 05 20");
    expect(formatModelLabel({ provider: "openai", model: "gpt-4o-2024-08-06" })).toBe("OpenAI GPT 4o 2024 08 06");
    expect(formatModelLabel({ provider: "anthropic", model: "claude-3-5-sonnet" })).toBe("Anthropic Claude 3.5 Sonnet");
  });

  it("keeps the exact identity of unknown providers and unrecognized model IDs, and never invents Gemini", () => {
    expect(formatModelLabel({ provider: "acme", model: "turbo-1" })).toBe("acme/turbo-1");
    expect(formatModelLabel({ provider: "google", model: "Weird_Model:1" })).toBe("google/Weird_Model:1");
    expect(formatModelLabel({ provider: "openai", model: "x" })).toBe("OpenAI X");
  });

  it("stays unavailable when the model is not recorded", () => {
    expect(formatModelLabel(undefined)).toBe("n/a");
    expect(formatModelLabel(null)).toBe("n/a");
    expect(formatModelLabel({ provider: "google", model: "" })).toBe("n/a");
    expect(formatModelLabel({ model: "gemini-3.8-flash" })).toBe("gemini-3.8-flash");
  });
});
