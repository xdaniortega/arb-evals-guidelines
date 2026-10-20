/**
 * Isolated credential loading and Git-ignore enforcement.
 *
 * WHY this exists: evaluating against real providers requires credentials, but a credential
 * must never reach ambient process.env, repository commits, build arguments, container
 * images, argument vectors, logs, hashes, views, or sealed evidence. This module enforces the
 * mandatory credential gate:
 * 1. Prove the file is git-ignored via `git check-ignore -v <path>` before reading.
 * 2. Parse the file in strict isolation without mutating `process.env`.
 * 3. Register every loaded secret value as a GuardedSecret so the host secret rescan
 *    covers all promoted artifacts.
 * 4. Never use credential presence to select a provider or model.
 */

import { execFileSync } from "node:child_process";
import { open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { EvalError } from "../core/types.ts";
import type { GuardedSecret } from "../core/secret-scan.ts";
import { PROVIDER_CREDENTIAL_VARIABLES, type ProviderId } from "../core/types.ts";

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Enforces that a credential file is verified to be ignored by Git.
 *
 * Fails closed: if Git fails, is unavailable, or the file is not ignored, an EvalError
 * with code `secret-quarantine` is thrown.
 */
export function assertGitIgnored(filePath: string, repoRoot: string): void {
  try {
    const absPath = isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath);
    const relPath = relative(repoRoot, absPath);
    execFileSync("git", ["check-ignore", "-v", relPath], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch {
    throw new EvalError(
      "secret-quarantine",
      `credential file is not confirmed git-ignored: ${filePath}; refusing to read credentials`,
      { at: filePath },
    );
  }
}

/**
 * Parses a .env format string in isolation.
 *
 * Rules:
 * - Empty lines and comment lines (#...) are ignored.
 * - Format is KEY=VALUE or KEY="VALUE" or KEY='VALUE'.
 * - Keys must match ^[A-Z][A-Z0-9_]*$.
 * - Never merges into process.env.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      throw new EvalError("input-invalid", `malformed .env line ${index + 1}: missing '='`, {
        at: `.env:${index + 1}`,
      });
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let val = trimmed.slice(eqIndex + 1).trim();

    if (!KEY_PATTERN.test(key)) {
      throw new EvalError("input-invalid", `invalid environment variable name on line ${index + 1}: ${key}`, {
        at: `.env:${index + 1}`,
      });
    }

    // Strip matched surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }

    result[key] = val;
  }

  return result;
}

export interface LoadedCredentials {
  readonly credentials: Readonly<Record<string, string>>;
  readonly guardedSecrets: readonly GuardedSecret[];
}

/**
 * @notice Loads isolated credentials only from a Git-ignored regular file.
 * @param envPath Credential file path to open without following a leaf symlink.
 * @param repoRoot Repository root used for ignore verification and path resolution.
 * @returns Parsed credentials and their guarded-secret registrations.
 * @dev Values never enter ambient process.env; the opened descriptor is verified before reading.
 */
export async function loadGuardedCredentials(envPath: string, repoRoot: string): Promise<LoadedCredentials> {
  const absEnvPath = resolve(repoRoot, envPath);
  const realRepoEnvPath = resolve(repoRoot, "evals", ".env");
  if (
    (process.env.VITEST === "true" || process.env.NODE_ENV === "test" || process.env.EVAL_TEST_GUARD === "1") &&
    absEnvPath === realRepoEnvPath
  ) {
    throw new EvalError(
      "secret-quarantine",
      `Tests must NEVER load the real evals/.env file: ${envPath}. Use synthetic test fixtures.`,
      { at: envPath },
    );
  }

  assertGitIgnored(envPath, repoRoot);

  let content: string;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(absEnvPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error("credential path is not a regular file");
    }
    content = await handle.readFile("utf8");
  } catch (error) {
    throw new EvalError(
      "credential-missing",
      `failed to read credential file ${envPath}: ${error instanceof Error ? error.message : String(error)}`,
      { at: envPath },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }

  const parsed = parseDotEnv(content);
  const guardedSecrets: GuardedSecret[] = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (value !== "") {
      guardedSecrets.push({ label: key, value });
    }
  }

  return {
    credentials: Object.freeze(parsed),
    guardedSecrets: Object.freeze(guardedSecrets),
  };
}

/**
 * Retrieves the specific credential for a direct provider from isolated credentials.
 * Does not fall back, substitute, or select across providers.
 */
export function getProviderCredential(
  provider: ProviderId,
  credentials: Readonly<Record<string, string>>,
): string | null {
  const variable = PROVIDER_CREDENTIAL_VARIABLES[provider];
  const value = credentials[variable];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
