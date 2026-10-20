/**
 * Secret echo detection for exported guest output.
 *
 * This is a security boundary: guest-side sanitizing is not trusted, so the host
 * re-scans every promoted byte before it becomes evidence. Detection covers the raw
 * value plus the encodings a model or tool is most likely to emit.
 */
import { EvalError } from "./types.mjs";
const MIN_GUARDED_LENGTH = 8;
function jsonEscaped(value) {
    const encoded = JSON.stringify(value);
    return encoded.slice(1, -1);
}
function percentEncoded(value) {
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
function base64Alignments(value, variant) {
    const secretBytes = Buffer.from(value, "utf8");
    const encoding = variant === "base64" ? "base64" : "base64url";
    const needles = [];
    for (let offset = 0; offset < 3; offset += 1) {
        const padded = Buffer.concat([Buffer.alloc(offset, 0x41), secretBytes]);
        const encoded = Buffer.from(padded).toString(encoding).replace(/=+$/, "");
        // Drop the leading quartet(s) that encode any filler byte, and the trailing quartet
        // that may encode fewer than three secret bytes.
        const leadingChars = offset === 0 ? 0 : 4;
        const usableBytes = padded.byteLength - (offset === 0 ? 0 : 3);
        const trailingPartial = usableBytes % 3 === 0 ? 0 : 4;
        const stable = encoded.slice(leadingChars, trailingPartial === 0 ? undefined : -trailingPartial);
        if (stable !== "")
            needles.push(stable);
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
export function secretNeedles(secret) {
    if (secret.value.length < MIN_GUARDED_LENGTH) {
        throw new EvalError("secret-quarantine", `guarded secret ${secret.label} is shorter than ${MIN_GUARDED_LENGTH} characters and cannot be scanned for safely`, { at: `secret ${secret.label}` });
    }
    const candidates = [
        { encoding: "raw", needle: secret.value },
        { encoding: "json-escaped", needle: jsonEscaped(secret.value) },
        { encoding: "percent-encoded", needle: percentEncoded(secret.value) },
        ...base64Alignments(secret.value, "base64").map((needle) => ({ encoding: "base64", needle })),
        ...base64Alignments(secret.value, "base64url").map((needle) => ({ encoding: "base64url", needle })),
    ];
    const seen = new Set();
    return candidates.filter((candidate) => {
        if (candidate.needle.length < MIN_GUARDED_LENGTH || seen.has(candidate.needle))
            return false;
        seen.add(candidate.needle);
        return true;
    });
}
/** Scans one payload. Returns every distinct (label, encoding) hit, never the value. */
export function scanForSecrets(payload, secrets) {
    if (secrets.length === 0)
        return [];
    // latin1 maps every byte 1:1 onto a code unit. utf8 would replace invalid byte
    // sequences with U+FFFD and could destroy a match sitting inside binary output.
    const text = typeof payload.content === "string"
        ? payload.content
        : Buffer.from(payload.content).toString("latin1");
    const hits = [];
    for (const secret of secrets) {
        for (const { encoding, needle } of secretNeedles(secret)) {
            if (text.includes(needle))
                hits.push({ label: secret.label, encoding, path: payload.path });
        }
    }
    return hits;
}
export function secretPlaceholder(label) {
    return `[REDACTED:${label}]`;
}
export function scanManyForSecrets(payloads, secrets) {
    return payloads.flatMap((payload) => scanForSecrets(payload, secrets));
}
/**
 * @notice Sanitizes sensitive text by replacing multi-encoding secret occurrences with non-reversible labeled placeholders.
 * @param text Text payload to sanitize.
 * @param secrets Guarded secrets whose needles and encodings should be redacted.
 * @param path Optional origin or file path label recorded on emitted redactions.
 * @returns Sanitized text along with total match count and detailed redaction records.
 * @dev Needles across all secrets and supported encodings (raw, JSON-escaped, percent-encoded, and base64/base64url across alignments) are replaced longest-first to prevent shorter substrings from corrupting longer encoded matches.
 */
export function redactSecrets(text, secrets, path = "") {
    if (secrets.length === 0 || text === "") {
        return { text, count: 0, redactions: [] };
    }
    const needles = secrets
        .flatMap((secret) => secretNeedles(secret).map((entry) => ({
        label: secret.label,
        encoding: entry.encoding,
        needle: entry.needle,
        placeholder: secretPlaceholder(secret.label),
    })))
        .sort((a, b) => b.needle.length - a.needle.length || a.needle.localeCompare(b.needle));
    let current = text;
    const redactions = [];
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
/**
 * Replaces guarded secret occurrences in raw bytes using a 1:1 latin1 mapping.
 * Non-needle bytes are preserved bit-for-bit.
 */
export function redactSecretBytes(bytes, secrets, path = "") {
    if (secrets.length === 0 || bytes.byteLength === 0) {
        return { bytes, count: 0, redactions: [] };
    }
    const latin1 = Buffer.from(bytes).toString("latin1");
    const result = redactSecrets(latin1, secrets, path);
    if (result.count === 0) {
        return { bytes, count: 0, redactions: [] };
    }
    const redactedBytes = new Uint8Array(Buffer.from(result.text, "latin1"));
    return { bytes: redactedBytes, count: result.count, redactions: result.redactions };
}
