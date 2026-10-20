/**
 * Secret echo detection.
 *
 * Guest-side sanitizing is untrusted, so these tests prove the host scanner catches the
 * encodings a model or tool actually emits, at every base64 alignment and inside binary
 * content, and that it fails LOUD rather than open on an unscannable secret. Every
 * value here is invented for the test; no real credential appears in this repository.
 */

import { describe, expect, it } from "vitest";
import { EvalError } from "./types.ts";
import {
  redactSecretBytes,
  redactSecrets,
  scanForSecrets,
  scanManyForSecrets,
  secretNeedles,
  secretPlaceholder,
} from "./secret-scan.ts";
import type { GuardedSecret } from "./secret-scan.ts";

/**
 * Invented, never a real credential.
 *
 * The embedded `?~>>` makes the base64 encoding contain `+` and `/` at every alignment,
 * so the base64 and base64url spellings are genuinely distinct needles rather than the
 * same string twice.
 */
const SECRET: GuardedSecret = { label: "FAKE_TEST_KEY", value: "sk-test-NOTREAL?~>>0123456789abcdef" };
const SECRET_WITH_SPECIALS: GuardedSecret = { label: "FAKE_SPECIAL", value: 'ab"cd\\ef gh/ij+kl=mn?~>>' };
const UTF8_SECRET: GuardedSecret = { label: "FAKE_UTF8_KEY", value: 'clé-密钥-🔑-"\\?~>>0123456789' };

function encodings(hits: readonly { encoding: string }[]): readonly string[] {
  return [...new Set(hits.map((hit) => hit.encoding))].sort();
}

describe("secretNeedles", () => {
  it("throws rather than failing open on a too-short secret", () => {
    let caught: unknown;
    try {
      secretNeedles({ label: "SHORT", value: "abc" });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EvalError);
    expect((caught as EvalError).code).toBe("secret-quarantine");
  });

  it("emits raw, json-escaped, percent-encoded, base64, and base64url spellings", () => {
    expect(encodings(secretNeedles(SECRET_WITH_SPECIALS))).toEqual([
      "base64",
      "base64url",
      "json-escaped",
      "percent-encoded",
      "raw",
    ]);
  });

  it("emits three distinct base64 alignments", () => {
    const base64 = secretNeedles(SECRET).filter((needle) => needle.encoding === "base64");
    expect(base64).toHaveLength(3);
    expect(new Set(base64.map((needle) => needle.needle)).size).toBe(3);
  });

  it("deduplicates a base64url needle that is byte-identical to its base64 form", () => {
    // A secret whose base64 encoding contains no `+` or `/` has identical base64 and
    // base64url spellings; emitting both would only duplicate work.
    const plain: GuardedSecret = { label: "FAKE_PLAIN", value: "sk-test-NOTREAL-abcdefgh" };
    expect(encodings(secretNeedles(plain))).not.toContain("base64url");
  });

  it("never emits a needle shorter than the guard length", () => {
    for (const needle of secretNeedles(SECRET)) expect(needle.needle.length).toBeGreaterThanOrEqual(8);
  });
});

describe("scanForSecrets", () => {
  it.each([
    ["raw", UTF8_SECRET.value],
    ["json-escaped", JSON.stringify({ key: UTF8_SECRET.value })],
    ["percent-encoded", encodeURIComponent(UTF8_SECRET.value)],
  ])("detects a non-ASCII secret's %s spelling in both text and UTF-8 bytes", (encoding, content) => {
    for (const payload of [content, Buffer.from(content, "utf8")]) {
      expect(encodings(scanForSecrets({ path: "utf8.txt", content: payload }, [UTF8_SECRET]))).toContain(encoding);
    }
  });

  it("returns nothing when there is no secret to guard", () => {
    expect(scanForSecrets({ path: "a", content: SECRET.value }, [])).toEqual([]);
  });

  it("detects a raw spelling", () => {
    const hits = scanForSecrets({ path: "out.txt", content: `key=${SECRET.value}\n` }, [SECRET]);
    expect(encodings(hits)).toContain("raw");
    expect(hits[0]?.path).toBe("out.txt");
  });

  it("detects a JSON-escaped spelling", () => {
    const payload = JSON.stringify({ key: SECRET_WITH_SPECIALS.value });
    const hits = scanForSecrets({ path: "out.json", content: payload }, [SECRET_WITH_SPECIALS]);
    expect(encodings(hits)).toContain("json-escaped");
  });

  it("detects a percent-encoded spelling", () => {
    const payload = `https://x.example/?k=${encodeURIComponent(SECRET_WITH_SPECIALS.value)}`;
    const hits = scanForSecrets({ path: "out.txt", content: payload }, [SECRET_WITH_SPECIALS]);
    expect(encodings(hits)).toContain("percent-encoded");
  });

  it.each([0, 1, 2])("detects a base64 spelling at byte alignment %i inside a larger blob", (offset) => {
    const blob = Buffer.concat([
      Buffer.alloc(offset, 0x5a),
      Buffer.from(SECRET.value, "utf8"),
      Buffer.from("trailing padding bytes", "utf8"),
    ]);
    const payload = `prefix ${blob.toString("base64")} suffix`;
    const hits = scanForSecrets({ path: "out.txt", content: payload }, [SECRET]);
    expect(encodings(hits)).toContain("base64");
  });

  it.each([0, 1, 2])("detects a base64url spelling at byte alignment %i", (offset) => {
    const blob = Buffer.concat([
      Buffer.alloc(offset, 0x5a),
      Buffer.from(SECRET.value, "utf8"),
      Buffer.from("tail", "utf8"),
    ]);
    const payload = `prefix.${blob.toString("base64url")}.suffix`;
    const hits = scanForSecrets({ path: "out.txt", content: payload }, [SECRET]);
    expect(encodings(hits)).toContain("base64url");
  });

  it("detects a secret embedded in invalid-UTF-8 binary content", () => {
    const binary = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x80, 0x81]),
      Buffer.from(SECRET.value, "utf8"),
      Buffer.from([0xc3, 0x28, 0x00]),
    ]);
    // A utf8 decode would replace the invalid bytes and could destroy the match.
    expect(binary.toString("utf8")).toContain("\uFFFD");
    const hits = scanForSecrets({ path: "out.bin", content: binary }, [SECRET]);
    expect(encodings(hits)).toContain("raw");
  });

  it("reports nothing for clean content", () => {
    expect(scanForSecrets({ path: "clean.txt", content: "nothing to see here" }, [SECRET])).toEqual([]);
  });

  it("never includes the secret value in a hit", () => {
    const hits = scanForSecrets({ path: "out.txt", content: SECRET.value }, [SECRET]);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(JSON.stringify(hit)).not.toContain(SECRET.value);
      expect(Object.keys(hit).sort()).toEqual(["encoding", "label", "path"]);
      expect(hit.label).toBe("FAKE_TEST_KEY");
    }
  });

  it("propagates the too-short failure instead of scanning nothing", () => {
    expect(() => scanForSecrets({ path: "a", content: "abc" }, [{ label: "S", value: "abc" }])).toThrow(EvalError);
  });
});

describe("scanManyForSecrets", () => {
  it("attributes each hit to its payload path", () => {
    const hits = scanManyForSecrets(
      [
        { path: "a.txt", content: "clean" },
        { path: "b.txt", content: SECRET.value },
      ],
      [SECRET],
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(hits.map((hit) => hit.path))).toEqual(new Set(["b.txt"]));
  });
});

describe("redaction", () => {
  it("redacts UTF-8 secret bytes without changing surrounding binary or unrelated Unicode text", () => {
    const prefix = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x81]), Buffer.from("visible café | ", "utf8")]);
    const suffix = Buffer.concat([Buffer.from(" | visible 終", "utf8"), Buffer.from([0xc3, 0x28, 0x80])]);
    const bytes = Buffer.concat([prefix, Buffer.from(UTF8_SECRET.value, "utf8"), suffix]);
    expect(encodings(scanForSecrets({ path: "file.bin", content: bytes }, [UTF8_SECRET]))).toContain("raw");

    const result = redactSecretBytes(bytes, [UTF8_SECRET], "file.bin");
    expect(result.count).toBe(1);
    expect(Buffer.from(result.bytes)).toEqual(Buffer.concat([
      prefix, Buffer.from(secretPlaceholder(UTF8_SECRET.label), "utf8"), suffix,
    ]));
    expect(scanForSecrets({ path: "file.bin", content: result.bytes }, [UTF8_SECRET])).toEqual([]);
  });

  it("keeps UTF-8 JSON valid and produces the same redaction for text and bytes", () => {
    const original = JSON.stringify({ note: "naïve € 終", key: UTF8_SECRET.value });
    const text = redactSecrets(original, [UTF8_SECRET], "output.json");
    const bytes = redactSecretBytes(Buffer.from(original, "utf8"), [UTF8_SECRET], "output.json");
    expect(bytes.count).toBe(1);
    expect(Buffer.from(bytes.bytes).toString("utf8")).toBe(text.text);
    expect(JSON.parse(text.text)).toEqual({ note: "naïve € 終", key: secretPlaceholder(UTF8_SECRET.label) });
    expect(scanForSecrets({ path: "output.json", content: bytes.bytes }, [UTF8_SECRET])).toEqual([]);
  });

  it.each([0, 1, 2])("detects and redacts non-ASCII secrets in encoded JSON at byte alignment %i", (offset) => {
    const blob = Buffer.concat([Buffer.alloc(offset, 0x5a), Buffer.from(UTF8_SECRET.value, "utf8"), Buffer.from("tail")]);
    for (const encoding of ["base64", "base64url"] as const) {
      const original = JSON.stringify({ data: blob.toString(encoding), note: "unrelated café" });
      const binary = Buffer.from(original, "utf8");
      expect(scanForSecrets({ path: "workspace.json", content: original }, [UTF8_SECRET]).length).toBeGreaterThan(0);
      expect(scanForSecrets({ path: "workspace.json", content: binary }, [UTF8_SECRET]).length).toBeGreaterThan(0);
      const result = redactSecretBytes(binary, [UTF8_SECRET], "workspace.json");
      expect(result.count).toBeGreaterThan(0);
      expect(scanForSecrets({ path: "workspace.json", content: result.bytes }, [UTF8_SECRET])).toEqual([]);
      expect(JSON.parse(Buffer.from(result.bytes).toString("utf8")).note).toBe("unrelated café");
    }
  });

  it("preserves clean binary output exactly and emits Unicode labels as UTF-8", () => {
    const clean = Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x00, 0x81]);
    const cleanResult = redactSecretBytes(clean, [UTF8_SECRET]);
    expect(cleanResult.bytes).toBe(clean);
    const labeled = { ...UTF8_SECRET, label: "CLÉ_密钥" };
    const result = redactSecretBytes(Buffer.from(labeled.value, "utf8"), [labeled]);
    expect(Buffer.from(result.bytes)).toEqual(Buffer.from(secretPlaceholder(labeled.label), "utf8"));
  });

  it("generates stable non-reversible placeholder naming variable", () => {
    expect(secretPlaceholder("GEMINI_API_KEY")).toBe("[REDACTED:GEMINI_API_KEY]");
  });

  it("redacts raw, json-escaped, and percent-encoded occurrences", () => {
    const raw = `key=${SECRET.value}`;
    const json = JSON.stringify({ key: SECRET_WITH_SPECIALS.value });
    const url = `https://example.com/?k=${encodeURIComponent(SECRET_WITH_SPECIALS.value)}`;
    const text = `${raw}\n${json}\n${url}`;

    const result = redactSecrets(text, [SECRET, SECRET_WITH_SPECIALS], "test.log");
    expect(result.count).toBeGreaterThanOrEqual(3);
    expect(result.text).not.toContain(SECRET.value);
    expect(result.text).not.toContain(SECRET_WITH_SPECIALS.value);
    expect(result.text).toContain("[REDACTED:FAKE_TEST_KEY]");
    expect(result.text).toContain("[REDACTED:FAKE_SPECIAL]");

    // Verify zero hits survive rescan
    const surviving = scanForSecrets({ path: "test.log", content: result.text }, [
      SECRET,
      SECRET_WITH_SPECIALS,
    ]);
    expect(surviving).toEqual([]);
  });

  it.each([0, 1, 2])("redacts base64 occurrences at alignment %i", (offset) => {
    const blob = Buffer.concat([
      Buffer.alloc(offset, 0x5a),
      Buffer.from(SECRET.value, "utf8"),
      Buffer.from("trailing padding bytes", "utf8"),
    ]);
    const payload = `data: ${blob.toString("base64")} end`;

    const result = redactSecrets(payload, [SECRET], "base64.txt");
    expect(result.count).toBeGreaterThan(0);
    expect(result.text).toContain("[REDACTED:FAKE_TEST_KEY]");

    // Rescan confirms zero hits
    const surviving = scanForSecrets({ path: "base64.txt", content: result.text }, [SECRET]);
    expect(surviving).toEqual([]);
  });

  it.each([0, 1, 2])("redacts base64url occurrences at alignment %i", (offset) => {
    const blob = Buffer.concat([
      Buffer.alloc(offset, 0x5a),
      Buffer.from(SECRET.value, "utf8"),
      Buffer.from("tail", "utf8"),
    ]);
    const payload = `jwt.${blob.toString("base64url")}.sig`;

    const result = redactSecrets(payload, [SECRET], "jwt.txt");
    expect(result.count).toBeGreaterThan(0);
    expect(result.text).toContain("[REDACTED:FAKE_TEST_KEY]");

    const surviving = scanForSecrets({ path: "jwt.txt", content: result.text }, [SECRET]);
    expect(surviving).toEqual([]);
  });

  it("redacts raw bytes preserving non-needle bytes", () => {
    const prefix = Buffer.from([0xff, 0xfe, 0x00, 0x81]);
    const secret = Buffer.from(SECRET.value, "utf8");
    const suffix = Buffer.from([0x7f, 0x80, 0xaa]);
    const bytes = Buffer.concat([prefix, secret, suffix]);

    const result = redactSecretBytes(bytes, [SECRET], "file.bin");
    expect(result.count).toBe(1);
    expect(result.redactions[0]?.path).toBe("file.bin");
    expect(result.redactions[0]?.label).toBe("FAKE_TEST_KEY");

    const surviving = scanForSecrets({ path: "file.bin", content: result.bytes }, [SECRET]);
    expect(surviving).toEqual([]);

    // Check prefix and suffix preserved
    const resultBuf = Buffer.from(result.bytes);
    expect(resultBuf.subarray(0, prefix.length)).toEqual(prefix);
    expect(resultBuf.subarray(resultBuf.length - suffix.length)).toEqual(suffix);
  });
});
