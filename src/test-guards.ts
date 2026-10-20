/**
 * Shared test guards for zero-paid-call test execution.
 *
 * Implements the zero-paid-call guard contract:
 * - Tests must NEVER load real `.env`, user agent homes, or developer credential files.
 * - Test child processes receive an allowlisted environment and temporary homes.
 * - Fail-fast guard against reaching real model completion transport fails BEFORE networking.
 * - Sockets reject listen errors promptly with named SocketFixtureError and clean up resources.
 */

import type { Server } from "node:net";
import {
  BLOCKED_PROVIDER_HOSTS,
  installCompletionTransportBlocker,
  RealCompletionTransportBlockedError,
} from "./transport-blocker.ts";

export { BLOCKED_PROVIDER_HOSTS, RealCompletionTransportBlockedError };

export const TEST_GUARDS_URL = new URL("./test-guards.ts", import.meta.url).href;
export const TEST_GUARDS_PRELOAD_FLAG = `--experimental-strip-types --import ${TEST_GUARDS_URL}`;

export class SocketFixtureError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "SocketFixtureError";
  }
}

/**
 * Starts a socket server with prompt error rejection.
 * Rejects with SocketFixtureError if listen fails instead of hanging.
 */
export async function startSocketServer(server: Server, socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onError = (err: unknown): void => {
      if (settled) return;
      settled = true;
      server.off("listening", onListening);
      reject(
        new SocketFixtureError(
          `Socket fixture failed to bind at ${socketPath}: ${err instanceof Error ? err.message : String(err)}`,
          err,
        ),
      );
    };
    const onListening = (): void => {
      if (settled) return;
      settled = true;
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(socketPath);
    } catch (err) {
      onError(err);
    }
  });
}

/**
 * Builds an allowlisted environment for test subprocesses.
 * Strips developer credentials and redirects user agent homes to a temporary directory.
 */
export function buildAllowlistedEnv(
  tempDir: string,
  extraEnv: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const safePath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const {
    NODE_OPTIONS: userNodeOptions,
    EVAL_TEST_GUARD: _ignoredUserGuard,
    ...restExtraEnv
  } = extraEnv;
  let nodeOptions: string;
  if (userNodeOptions) {
    if (userNodeOptions.includes(TEST_GUARDS_PRELOAD_FLAG)) {
      nodeOptions = userNodeOptions;
    } else {
      nodeOptions = `${userNodeOptions} ${TEST_GUARDS_PRELOAD_FLAG}`;
    }
  } else {
    nodeOptions = TEST_GUARDS_PRELOAD_FLAG;
  }

  return {
    PATH: safePath,
    NODE_PATH: process.env.NODE_PATH,
    HOME: tempDir,
    USERPROFILE: tempDir,
    TMPDIR: tempDir,
    TEMP: tempDir,
    TMP: tempDir,
    NODE_ENV: "test",
    VITEST: "true",
    ...restExtraEnv,
    EVAL_TEST_GUARD: "1",
    NODE_OPTIONS: nodeOptions,
  };
}

const SENSITIVE_ENV_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

let guardsInstalled = false;

export function installTestGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;

  // 1. Scrub ambient sensitive keys from process.env in tests
  for (const key of SENSITIVE_ENV_KEYS) {
    if (key in process.env) {
      delete process.env[key];
    }
  }

  // Shared with the image-resident scripted runtime to prevent policy divergence.
  installCompletionTransportBlocker();
}

// Automatically install guards when loaded under test or preload
if (process.env.VITEST === "true" || process.env.NODE_ENV === "test" || process.env.EVAL_TEST_GUARD === "1") {
  installTestGuards();
}
