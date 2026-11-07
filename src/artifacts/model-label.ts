/**
 * Deterministic, host-side readable label for a frozen provider/model identity.
 *
 * Presentation only: it never consults a model catalog and never alters evidence. A known
 * provider with a recognizably shaped model ID becomes e.g. `Google Gemini 3.8 Flash`;
 * anything else keeps its exact `provider/model` identity rather than being guessed at.
 */

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  google: "Google",
  openai: "OpenAI",
};

const ACRONYMS: Readonly<Record<string, string>> = { gpt: "GPT" };

/** Lowercase dash-separated segments of letters/digits/dots, e.g. `gemini-3.8-flash`. */
const MODEL_ID_SHAPE = /^[a-z][a-z0-9]*(?:-[a-z0-9.]+)*$/;

function titleToken(token: string): string {
  if (/^[a-z]+$/.test(token)) return ACRONYMS[token] ?? `${token.charAt(0).toUpperCase()}${token.slice(1)}`;
  return token;
}

/** Readable model name, or `null` when the ID is not recognized (caller keeps the exact identity). */
function readableModelName(model: string): string | null {
  if (!MODEL_ID_SHAPE.test(model)) return null;
  const tokens = model.split("-");
  const merged: string[] = [];
  // Only the first purely numeric token run is a version (`claude-3-5-sonnet` is 3.5); later
  // numbers (date stamps such as `-05-20` or `-2024-08-06`) and leading-zero tokens stay separate.
  const isVersionPart = (t: string | undefined): t is string => t !== undefined && /^(?:0|[1-9]\d?)$/.test(t);
  let versionClosed = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!versionClosed && /^\d[\d.]*$/.test(token)) {
      versionClosed = true;
      if (isVersionPart(token) && isVersionPart(tokens[i + 1])) {
        merged.push(`${token}.${tokens[i + 1]}`);
        i += 1;
        continue;
      }
    }
    merged.push(token);
  }
  return merged.map(titleToken).join(" ");
}

/** `google` + `gemini-3.8-flash` → `Google Gemini 3.8 Flash`; unknown IDs → `provider/model`; missing → `n/a`. */
export function formatModelLabel(target: { readonly provider?: string; readonly model?: string } | null | undefined): string {
  if (target === null || target === undefined || !target.model) return "n/a";
  const provider = target.provider;
  if (!provider) return target.model;
  const providerLabel = PROVIDER_LABELS[provider];
  const name = providerLabel === undefined ? null : readableModelName(target.model);
  return providerLabel !== undefined && name !== null ? `${providerLabel} ${name}` : `${provider}/${target.model}`;
}
