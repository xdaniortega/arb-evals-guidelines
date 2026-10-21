import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { EvalError } from "../core/types.ts";
import {
  assertGitIgnored,
  deriveGuardedSecrets,
  getProviderCredential,
  loadGuardedCredentials,
  parseDotEnv,
} from "./credentials.ts";
import { redactSecretBytes, scanForSecrets } from "../core/secret-scan.ts";
import { createEvidenceStore } from "../artifacts/store.ts";

describe("credentials and isolated .env parser", () => {
  it("parses valid .env strings in isolation without mutating process.env", () => {
    const originalEnv = { ...process.env };
    const content = `
# Comment line
GEMINI_API_KEY=test-gemini-key
ANTHROPIC_API_KEY="test-anthropic-key"
OPENAI_API_KEY='test-openai-key'

EMPTY_VAR=
`;
    const parsed = parseDotEnv(content);
    expect(parsed.GEMINI_API_KEY).toBe("test-gemini-key");
    expect(parsed.ANTHROPIC_API_KEY).toBe("test-anthropic-key");
    expect(parsed.OPENAI_API_KEY).toBe("test-openai-key");
    expect(parsed.EMPTY_VAR).toBe("");

    // Verify process.env was NEVER mutated
    expect(process.env.GEMINI_API_KEY).toBe(originalEnv.GEMINI_API_KEY);
    expect(process.env.ANTHROPIC_API_KEY).toBe(originalEnv.ANTHROPIC_API_KEY);
    expect(process.env.OPENAI_API_KEY).toBe(originalEnv.OPENAI_API_KEY);
  });

  it("rejects malformed .env lines and invalid variable names", () => {
    expect(() => parseDotEnv("INVALID_LINE_NO_EQUALS")).toThrow(EvalError);
    expect(() => parseDotEnv("lowercase_var=value")).toThrow(EvalError);
    expect(() => parseDotEnv("VAR-WITH-DASH=value")).toThrow(EvalError);
  });

  it("retrieves provider credentials without fallback or substitution", () => {
    const creds = {
      GEMINI_API_KEY: "gk-123",
      ANTHROPIC_API_KEY: "",
    };
    expect(getProviderCredential("google", creds)).toBe("gk-123");
    expect(getProviderCredential("anthropic", creds)).toBeNull();
    expect(getProviderCredential("openai", creds)).toBeNull();
  });

  it("returns null when provider credential is blank or whitespace", () => {
    expect(getProviderCredential("google", { GEMINI_API_KEY: "   " })).toBeNull();
    expect(getProviderCredential("google", { GEMINI_API_KEY: "" })).toBeNull();
    expect(getProviderCredential("google", {})).toBeNull();
  });

  it("registers trimmed credential as a guarded secret when surrounding whitespace is quoted and detects it in auth payload", () => {
    const rawDotEnv = 'GEMINI_API_KEY="  synthetic-key-123  "\n';
    const parsed = parseDotEnv(rawDotEnv);

    // Auth retrieves the trimmed form
    const authedCredential = getProviderCredential("google", parsed);
    expect(authedCredential).toBe("synthetic-key-123");

    // Guarded secrets must include the raw value AND the exact trimmed value used for auth
    const guardedSecrets = deriveGuardedSecrets(parsed);
    expect(guardedSecrets).toEqual([
      { label: "GEMINI_API_KEY", value: "  synthetic-key-123  " },
      { label: "GEMINI_API_KEY", value: "synthetic-key-123" },
    ]);

    // scanForSecrets detects the trimmed value inside payload containing only trimmed form
    const authHeaderPayload = `Authorization: Bearer ${authedCredential}`;
    const hits = scanForSecrets({ path: "request-headers.txt", content: authHeaderPayload }, guardedSecrets);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.label === "GEMINI_API_KEY")).toBe(true);
  });

  it("deduplicates identical secret values and ignores empty credentials in deriveGuardedSecrets", () => {
    const creds = {
      KEY_A: "synthetic-token-abc",
      KEY_B: "synthetic-token-abc",
      KEY_C: "  synthetic-token-abc  ",
      EMPTY_KEY: "",
      BLANK_KEY: "   ",
    };
    const guardedSecrets = deriveGuardedSecrets(creds);
    expect(guardedSecrets).toEqual([
      { label: "KEY_A", value: "synthetic-token-abc" },
      { label: "KEY_C", value: "  synthetic-token-abc  " },
    ]);
  });

  it.each([
    ["provider credential", "GEMINI_API_KEY", "abc1234"],
    ["quoted-padding provider credential", "ANTHROPIC_API_KEY", "   abc   "],
    ["short OpenAI credential", "OPENAI_API_KEY", "sk-12"],
  ])("rejects a short %s during credential loading", async (_kind, key, value) => {
    const repoRoot = process.cwd();
    const testEnvPath = join(repoRoot, `.env.test-${randomBytes(4).toString("hex")}`);
    await writeFile(testEnvPath, `GEMINI_API_KEY=synthetic-valid-provider-key\n${key}="${value}"\n`);
    try {
      const error = await loadGuardedCredentials(testEnvPath, repoRoot).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(EvalError);
      expect(error).toMatchObject({ code: "secret-quarantine", at: `secret ${key}` });
      expect((error as Error).message).toContain(key);
      expect((error as Error).message).toContain("shorter than 8 characters");
      expect((error as Error).message).not.toContain(value.trim());
    } finally {
      await rm(testEnvPath, { force: true });
    }
  });

  it.each([
    ["unquoted config value", "LOG_LEVEL", "debug"],
    ["short Unicode config value", "EXTRA_TOKEN", "密钥🔑"],
  ])("loads successfully when a short non-credential %s coexists with a valid provider key", async (_kind, key, value) => {
    const repoRoot = process.cwd();
    const testEnvPath = join(repoRoot, `.env.test-${randomBytes(4).toString("hex")}`);
    await writeFile(testEnvPath, `GEMINI_API_KEY=synthetic-valid-provider-key\n${key}="${value}"\n`);
    try {
      const loaded = await loadGuardedCredentials(testEnvPath, repoRoot);
      // Both keys are parsed and returned.
      expect(loaded.credentials.GEMINI_API_KEY).toBe("synthetic-valid-provider-key");
      expect(loaded.credentials[key]).toBe(value);
      // The valid provider credential is still guarded.
      expect(loaded.guardedSecrets.some((secret) => secret.value === "synthetic-valid-provider-key")).toBe(true);
      // The short non-credential value must NOT be registered as a guarded secret.
      expect(loaded.guardedSecrets.some((secret) => secret.value === value)).toBe(false);
      expect(loaded.guardedSecrets.some((secret) => secret.value === value.trim())).toBe(false);
    } finally {
      await rm(testEnvPath, { force: true });
    }
  });

  it("accepts the scanner's exact minimum length while ignoring blank optional entries", () => {
    const secrets = deriveGuardedSecrets({ KEY: "12345678", EMPTY: "", BLANK: "   " });
    expect(secrets).toEqual([{ label: "KEY", value: "12345678" }]);
    expect(scanForSecrets({ path: "test.txt", content: "12345678" }, secrets).length).toBeGreaterThan(0);
  });

  it.each([
    ["unquoted", "   synthetic-workspace-key-0123456789   "],
    ["double-quoted", '"   synthetic-workspace-key-0123456789   "'],
    ["single-quoted", "'   synthetic-workspace-key-0123456789   '"],
    ["non-ASCII quoted", '"   synthetic-clé-密钥-🔑-0123456789   "'],
  ])("redacts %s credentials before workspace evidence and rejects an unsanitized export", async (_name, spelling) => {
    const parsed = parseDotEnv(`ANTHROPIC_API_KEY=${spelling}\n`);
    const credential = getProviderCredential("anthropic", parsed)!;
    const guardedSecrets = deriveGuardedSecrets(parsed);
    const workspaceBytes = Buffer.from(`answer\n${credential}\n`, "utf8");
    const sanitized = redactSecretBytes(workspaceBytes, guardedSecrets, "workspace:answer.txt");
    expect(sanitized.count).toBeGreaterThan(0);
    expect(Buffer.from(sanitized.bytes).toString("utf8")).toBe("answer\n[REDACTED:ANTHROPIC_API_KEY]\n");
    expect(scanForSecrets({ path: "answer.txt", content: sanitized.bytes }, guardedSecrets)).toEqual([]);

    const root = await mkdtemp(join(tmpdir(), "eval-credential-evidence-"));
    try {
      const store = await createEvidenceStore({ runDir: root, guardedSecrets });
      const workspaceRecord = (bytes: Uint8Array) => ({
        files: [{ path: "answer.txt", base64: Buffer.from(bytes).toString("base64") }],
      });
      await store.writeRecord("workspace.json", workspaceRecord(sanitized.bytes));
      const retained = JSON.parse(await readFile(join(root, "workspace.json"), "utf8"));
      const retainedBytes = Buffer.from(retained.files[0].base64, "base64");
      expect(retainedBytes.toString("utf8")).not.toContain(credential);
      expect(retainedBytes.toString("utf8")).toContain("[REDACTED:ANTHROPIC_API_KEY]");

      // The final store scan must still reject raw base64 when an earlier sanitizer is bypassed.
      await expect(store.writeRecord("unsanitized-workspace.json", workspaceRecord(workspaceBytes)))
        .rejects.toMatchObject({ code: "secret-quarantine" });
      const quarantined = await readFile(join(root, "unsanitized-workspace.json"), "utf8");
      expect(JSON.parse(quarantined).quarantined).toBe(true);
      expect(quarantined).not.toContain(credential);
      expect(quarantined).not.toContain(workspaceBytes.toString("base64"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("throws credential-missing if credential file does not exist", async () => {
    // Under a git-ignored path (.env.*), but non-existent file
    const fakePath = join(process.cwd(), ".env.nonexistent");
    await expect(loadGuardedCredentials(fakePath, process.cwd())).rejects.toMatchObject({
      code: "credential-missing",
    });
  });

  it("refuses to read a file that is not git-ignored", async () => {
    const tempDir = join(tmpdir(), `eval-test-cred-${randomBytes(4).toString("hex")}`);
    await mkdir(tempDir, { recursive: true });
    try {
      const unignoredFile = join(tempDir, "unignored.env");
      await writeFile(unignoredFile, "GEMINI_API_KEY=leak\n", "utf8");

      expect(() => assertGitIgnored(unignoredFile, process.cwd())).toThrow(EvalError);
      await expect(loadGuardedCredentials(unignoredFile, process.cwd())).rejects.toThrow(EvalError);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects symlinked and nonregular credential paths", async () => {
    const repoRoot = process.cwd();
    const fixture = join(repoRoot, `.env.symlink-${randomBytes(4).toString("hex")}`);
    const directory = join(repoRoot, `.env.directory-${randomBytes(4).toString("hex")}`);
    const target = join(tmpdir(), `eval-cred-target-${randomBytes(4).toString("hex")}`);
    await writeFile(target, "GEMINI_API_KEY=should-not-read\n", "utf8");
    await symlink(target, fixture);
    await mkdir(directory);
    try {
      await expect(loadGuardedCredentials(fixture, repoRoot)).rejects.toMatchObject({ code: "credential-missing" });
      await expect(loadGuardedCredentials(directory, repoRoot)).rejects.toMatchObject({ code: "credential-missing" });
    } finally {
      await rm(fixture, { force: true });
      await rm(directory, { recursive: true, force: true });
      await rm(target, { force: true });
    }
  });

  it("accepts confirmed git-ignored test .env and registers guarded secrets", async () => {
    const repoRoot = process.cwd();
    // Use an ignored test fixture path (matches .env.* in .gitignore)
    const testEnvPath = join(repoRoot, `.env.test-${randomBytes(4).toString("hex")}`);
    await writeFile(testEnvPath, "GEMINI_API_KEY=test-fixture-key-xyz123\n", "utf8");
    try {
      const loaded = await loadGuardedCredentials(testEnvPath, repoRoot);

      expect(loaded.credentials).toBeDefined();
      expect(loaded.credentials.GEMINI_API_KEY).toBe("test-fixture-key-xyz123");
      expect(Array.isArray(loaded.guardedSecrets)).toBe(true);
      for (const secret of loaded.guardedSecrets) {
        expect(secret.label).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(typeof secret.value).toBe("string");
        expect(secret.value.length).toBeGreaterThan(0);
      }
    } finally {
      await rm(testEnvPath, { force: true });
    }
  });

  it("registers the trimmed auth value through loadGuardedCredentials for a quoted-whitespace credential", async () => {
    const repoRoot = process.cwd();
    const testEnvPath = join(repoRoot, `.env.test-${randomBytes(4).toString("hex")}`);
    await writeFile(testEnvPath, 'GEMINI_API_KEY="  synthetic-key-123  "\n', "utf8");
    try {
      const loaded = await loadGuardedCredentials(testEnvPath, repoRoot);
      const authed = getProviderCredential("google", loaded.credentials);
      expect(authed).toBe("synthetic-key-123");
      // The exact bytes used for auth must be present in the guarded set.
      expect(loaded.guardedSecrets.some((secret) => secret.value === "synthetic-key-123")).toBe(true);
    } finally {
      await rm(testEnvPath, { force: true });
    }
  });

  it("strictly forbids loading real .env during tests", async () => {
    const repoRoot = process.cwd();
    const realEnvPath = join(repoRoot, ".env");
    await expect(loadGuardedCredentials(realEnvPath, repoRoot)).rejects.toThrow(
      /Tests must NEVER load the real \.env file/,
    );
  });
});
