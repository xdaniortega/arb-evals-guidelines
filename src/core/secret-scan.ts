/**
 * Secret echo detection for exported guest output.
 *
 * This is a security boundary: guest-side sanitizing is not trusted, so the host
 * re-scans every promoted byte before it becomes evidence. Detection covers the raw
 * value plus the encodings a model or tool is most likely to emit.
 */

import { EvalError } from "./types.ts";

export type SecretEncoding = "raw" | "json-escaped" | "percent-encoded" | "base64" | "base64url";

export interface SecretHit {
  /** Label of the matched secret, never the secret value. */
  readonly label: string;
  readonly encoding: SecretEncoding;
  readonly path: string;
}

export interface GuardedSecret {
  readonly label: string;
  readonly value: string;
}

const MIN_GUARDED_LENGTH = 8;

function jsonEscaped(value: string): string {
  const encoded = JSON.stringify(value);
  return encoded.slice(1, -1);
}

function percentEncoded(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Base64 is a 3-byte-to-4-character code, so the encoding of a secret depends on its
 * byte offset within the surrounding blob. A secret encoded at the start of its own
 * buffer produces a completely different substring than the same secret sitting at
 * offset 1 or 2 inside a larger base64-encoded payload, which is the common
 * exfiltration shape.
 *
 * We therefore emit all three alignments. For alignment k we prepend k filler bytes,
 * encode, then strip the leading characters that mix filler with secret bytes and the
 * trailing characters that mix secret bytes with padding or with whatever followed.
 * What remains is the stable middle substring that appears verbatim regardless of the
 * surrounding content.
 */
function base64Alignments(value: string, variant: "base64" | "base64url"): readonly string[] {
  const secretBytes = Buffer.from(value, "utf8");
  const encoding = variant === "base64" ? "base64" : "base64url";
  const needles: string[] = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const padded = Buffer.concat([Buffer.alloc(offset, 0x41), secretBytes]);
    const encoded = Buffer.from(padded).toString(encoding).replace(/=+$/, "");
    // Drop the leading quartet(s) that encode any filler byte, and the trailing quartet
    // that may encode fewer than three secret bytes.
    const leadingChars = offset === 0 ? 0 : 4;
    const usableBytes = padded.byteLength - (offset === 0 ? 0 : 3);
    const trailingPartial = usableBytes % 3 === 0 ? 0 : 4;
    const stable = encoded.slice(leadingChars, trailingPartial === 0 ? undefined : -trailingPartial);
    if (stable !== "") needles.push(stable);
  }
  return needles;
}

/**
 * All searchable spellings of a guarded secret, longest first.
 *
 * A secret shorter than MIN_GUARDED_LENGTH is a thrown error rather than an empty
 * needle list. Returning `[]` would fail open on exactly the case that most needs
 * guarding: a truncated or misconfigured credential would silently be reported clean.
 */
export function secretNeedles(secret: GuardedSecret): ReadonlyArray<{ encoding: SecretEncoding; needle: string }> {
  if (secret.value.length < MIN_GUARDED_LENGTH) {
    throw new EvalError(
      "secret-quarantine",
      `guarded secret ${secret.label} is shorter than ${MIN_GUARDED_LENGTH} characters and cannot be scanned for safely`,
      { at: `secret ${secret.label}` },
    );
  }
  const candidates: Array<{ encoding: SecretEncoding; needle: string }> = [
    { encoding: "raw", needle: secret.value },
    { encoding: "json-escaped", needle: jsonEscaped(secret.value) },
    { encoding: "percent-encoded", needle: percentEncoded(secret.value) },
    ...base64Alignments(secret.value, "base64").map(
      (needle) => ({ encoding: "base64" as const, needle }),
    ),
    ...base64Alignments(secret.value, "base64url").map(
      (needle) => ({ encoding: "base64url" as const, needle }),
    ),
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (candidate.needle.length < MIN_GUARDED_LENGTH || seen.has(candidate.needle)) return false;
    seen.add(candidate.needle);
    return true;
  });
}

/**
 * @notice Detects guarded secret spellings without returning their values.
 * @param payload Named text or binary content to scan.
 * @param secrets Credentials whose encoded forms must be detected.
 * @returns Distinct label and encoding matches with their artifact paths.
 */
export function scanForSecrets(
  payload: { readonly path: string; readonly content: string | Uint8Array },
  secrets: readonly GuardedSecret[],
): readonly SecretHit[] {
  if (secrets.length === 0) return [];
  const content = typeof payload.content === "string" ? payload.content : Buffer.from(payload.content);
  const hits: SecretHit[] = [];
  for (const secret of secrets) {
    for (const { encoding, needle } of secretNeedles(secret)) {
      // Binary output is searched as bytes: decoding it as UTF-8 would alter invalid
      // sequences, while matching a Unicode string against latin1 would miss its UTF-8 bytes.
      const found = typeof content === "string" ? content.includes(needle) : content.includes(Buffer.from(needle, "utf8"));
      if (found) hits.push({ label: secret.label, encoding, path: payload.path });
    }
  }
  return hits;
}

export interface SecretRedaction {
  readonly path: string;
  readonly label: string;
  readonly encoding: SecretEncoding;
  readonly count: number;
}

export function secretPlaceholder(label: string): string {
  return `[REDACTED:${label}]`;
}

export function scanManyForSecrets(
  payloads: ReadonlyArray<{ readonly path: string; readonly content: string | Uint8Array }>,
  secrets: readonly GuardedSecret[],
): readonly SecretHit[] {
  return payloads.flatMap((payload) => scanForSecrets(payload, secrets));
}

export interface SecretPatternHit {
  readonly pattern: string; // e.g. "openai-key" - the pattern NAME, never matched text
  readonly path: string;
}

const SECRET_PATTERNS: ReadonlyArray<{ readonly name: string; readonly regex: RegExp }> = [
  { name: "openai-key", regex: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "aws-access-key-id", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "slack-token", regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "pem-private-key", regex: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: "bearer-token", regex: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  { name: "url-credentials", regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/ },
];

/**
 * Scans a payload for high-confidence secret patterns.
 *
 * Emits at most one hit per pattern name per payload without exposing matched text.
 * Binary content is decoded as UTF-8 for pattern matching.
 */
export function scanForSecretPatterns(
  payload: { readonly path: string; readonly content: string | Uint8Array },
): readonly SecretPatternHit[] {
  // Binary content: decoded with Buffer.toString("utf8") for pattern matching (unlike the
  // value-driven path which matches exact byte needles; pattern matching operates on
  // character-level regular expressions defined over text characters rather than raw byte sequences).
  const text = typeof payload.content === "string"
    ? payload.content
    : Buffer.isBuffer(payload.content)
      ? payload.content.toString("utf8")
      : Buffer.from(payload.content).toString("utf8");

  const hits: SecretPatternHit[] = [];
  for (const { name, regex } of SECRET_PATTERNS) {
    if (regex.test(text)) {
      hits.push({ pattern: name, path: payload.path });
    }
  }
  return hits;
}

/**
 * @notice Redacts high-confidence secret pattern matches with non-reversible labeled placeholders.
 * @param text Text payload to sanitize.
 * @param path Optional origin or file path label recorded on emitted redactions.
 * @returns Sanitized text along with total match count and detailed redaction records.
 */
export function redactSecretPatterns(
  text: string,
  path = "",
): { readonly text: string; readonly count: number; readonly redactions: readonly SecretRedaction[] } {
  if (text === "") {
    return { text, count: 0, redactions: [] };
  }
  let current = text;
  let totalCount = 0;
  const redactions: SecretRedaction[] = [];

  for (const { name, regex } of SECRET_PATTERNS) {
    const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
    const globalRegex = new RegExp(regex.source, flags);
    let matchCount = 0;
    const replaced = current.replace(globalRegex, () => {
      matchCount += 1;
      return secretPlaceholder(name);
    });
    if (matchCount > 0) {
      current = replaced;
      redactions.push({
        path,
        label: name,
        encoding: "raw",
        count: matchCount,
      });
      totalCount += matchCount;
    }
  }

  return { text: current, count: totalCount, redactions };
}

export interface RedactSecretsResult {
  readonly text: string;
  readonly count: number;
  readonly redactions: readonly SecretRedaction[];
}

/**
 * @notice Sanitizes sensitive text by replacing multi-encoding secret occurrences with non-reversible labeled placeholders.
 * @param text Text payload to sanitize.
 * @param secrets Guarded secrets whose needles and encodings should be redacted.
 * @param path Optional origin or file path label recorded on emitted redactions.
 * @returns Sanitized text along with total match count and detailed redaction records.
 * @dev Needles across all secrets and supported encodings (raw, JSON-escaped, percent-encoded, and base64/base64url across alignments) are replaced longest-first to prevent shorter substrings from corrupting longer encoded matches.
 */
export function redactSecrets(
  text: string,
  secrets: readonly GuardedSecret[],
  path = "",
): RedactSecretsResult {
  return redactEncodedSecrets(text, secrets, path, (value) => value);
}

function redactEncodedSecrets(
  text: string,
  secrets: readonly GuardedSecret[],
  path: string,
  encode: (value: string) => string,
): RedactSecretsResult {
  if (secrets.length === 0 || text === "") {
    return { text, count: 0, redactions: [] };
  }
  const needles = secrets
    .flatMap((secret) =>
      secretNeedles(secret).map((entry) => ({
        label: secret.label,
        encoding: entry.encoding,
        needle: encode(entry.needle),
        placeholder: encode(secretPlaceholder(secret.label)),
      })),
    )
    .sort((a, b) => b.needle.length - a.needle.length || a.needle.localeCompare(b.needle));

  let current = text;
  const redactions: SecretRedaction[] = [];
  let totalCount = 0;

  for (const item of needles) {
    if (current.includes(item.needle)) {
      let occurrences = 0;
      let pos = 0;
      while ((pos = current.indexOf(item.needle, pos)) !== -1) {
        occurrences += 1;
        pos += item.needle.length;
      }
      if (occurrences > 0) {
        current = current.replaceAll(item.needle, item.placeholder);
        redactions.push({
          path,
          label: item.label,
          encoding: item.encoding,
          count: occurrences,
        });
        totalCount += occurrences;
      }
    }
  }

  return { text: current, count: totalCount, redactions };
}

export interface RedactSecretBytesResult {
  readonly bytes: Uint8Array;
  readonly count: number;
  readonly redactions: readonly SecretRedaction[];
}

/**
 * @notice Redacts guarded secret spellings while preserving unrelated output bytes.
 * @param bytes Binary payload, including potentially invalid UTF-8.
 * @param secrets Credentials whose encoded forms must be replaced.
 * @param path Artifact location recorded with each redaction.
 * @returns Redacted bytes and redaction metadata.
 * @dev Payload and UTF-8 needles share a lossless latin1 byte view.
 */
export function redactSecretBytes(
  bytes: Uint8Array,
  secrets: readonly GuardedSecret[],
  path = "",
): RedactSecretBytesResult {
  if (secrets.length === 0 || bytes.byteLength === 0) {
    return { bytes, count: 0, redactions: [] };
  }
  const latin1 = Buffer.from(bytes).toString("latin1");
  const result = redactEncodedSecrets(latin1, secrets, path, (value) => Buffer.from(value, "utf8").toString("latin1"));
  if (result.count === 0) {
    return { bytes, count: 0, redactions: [] };
  }
  const redactedBytes = new Uint8Array(Buffer.from(result.text, "latin1"));
  return { bytes: redactedBytes, count: result.count, redactions: result.redactions };
}
