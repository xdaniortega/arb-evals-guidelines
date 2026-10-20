import { describe, expect, it } from "vitest";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { EvalError } from "../core/types.ts";
import { assertGitIgnored, getProviderCredential, loadGuardedCredentials, parseDotEnv } from "./credentials.ts";

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

  it("throws credential-missing if credential file does not exist", async () => {
    // Under a git-ignored path (.env.*), but non-existent file
    const fakePath = join(process.cwd(), "evals", ".env.nonexistent");
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
    const fixture = join(repoRoot, "evals", `.env.symlink-${randomBytes(4).toString("hex")}`);
    const directory = join(repoRoot, "evals", `.env.directory-${randomBytes(4).toString("hex")}`);
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
    const testEnvPath = join(repoRoot, "evals", `.env.test-${randomBytes(4).toString("hex")}`);
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

  it("strictly forbids loading real evals/.env during tests", async () => {
    const repoRoot = process.cwd();
    const realEnvPath = join(repoRoot, "evals", ".env");
    await expect(loadGuardedCredentials(realEnvPath, repoRoot)).rejects.toThrow(
      /Tests must NEVER load the real evals\/\.env file/,
    );
  });
});
