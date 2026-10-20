/**
 * Deterministic harness test double.
 *
 * It exercises attestation, prompt dispatch, workspace mutation, normalized evidence,
 * and outcome classification with no provider request, no credential, and no network.
 * The default script changes nothing, so it carries no task answer; tests inject their
 * own scripts. Every run using it is self-labeled as a test double in evidence and is
 * only permitted in `fake` mode.
 */

import { assertNotAborted } from "../core/types.ts";
import type { StructuredFailure } from "../core/types.ts";
import type { Guest } from "../sandboxes/sandbox.ts";
import type {
  Harness,
  HarnessAttestation,
  HarnessOutcome,
  HarnessProbe,
  HarnessRequest,
  HarnessRunResult,
  NormalizedMessage,
  NormalizedToolStep,
  RuntimeIdentity,
} from "./harness.ts";

export const FAKE_HARNESS_ID = "fake";
const FAKE_CLOCK = "1970-01-01T00:00:00.000Z";
const MAX_MESSAGE_CHARS = 4_000;

export interface FakeWorkspaceFile {
  readonly path: string;
  readonly text: string;
}

export interface FakeHarnessResponse {
  readonly outcome: HarnessOutcome;
  /** Files written back into the workspace, replacing any existing content. */
  readonly writes?: readonly FakeWorkspaceFile[];
  readonly assistantText?: string;
  readonly toolSteps?: readonly NormalizedToolStep[];
  readonly providerRequests?: number;
  readonly failures?: readonly StructuredFailure[];
  readonly nativeSessionEntries?: readonly unknown[];
  readonly nativeSessionRedactions?: { readonly count: number; readonly entries: readonly import("../core/secret-scan.ts").SecretRedaction[] };
}

export type FakeHarnessScript = (
  request: HarnessRequest,
  workspace: ReadonlyArray<{ readonly path: string; readonly text: string }>,
) => FakeHarnessResponse | Promise<FakeHarnessResponse>;

/** Deterministic default: observe the workspace and change nothing. */
export const noopFakeScript: FakeHarnessScript = () => ({
  outcome: "completed",
  assistantText: "fake harness: no workspace change",
});

function truncate(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_MESSAGE_CHARS
    ? { text: text.slice(0, MAX_MESSAGE_CHARS), truncated: true }
    : { text, truncated: false };
}

function runtimeIdentity(request: HarnessRequest, version: string): RuntimeIdentity {
  return {
    harnessId: FAKE_HARNESS_ID,
    harnessVersion: version,
    provider: request.target.provider,
    model: request.target.model,
    thinking: request.target.thinking,
    allowedTools: [...request.allowedTools],
    ambientTools: [...request.ambientTools],
    skillPaths: [...request.skillPaths],
    ambientDiscoveryDisabled: true,
    implicitRetryDisabled: true,
    testDouble: true,
  };
}

export function createFakeHarness(
  options: { readonly script?: FakeHarnessScript; readonly version?: string } = {},
): Harness {
  const script = options.script ?? noopFakeScript;
  const version = options.version ?? "0.0.0-fake";

  return {
    id: FAKE_HARNESS_ID,
    testDouble: true,
    async probe(signal?: AbortSignal): Promise<HarnessProbe> {
      assertNotAborted(signal, "fake harness probe");
      return {
        ready: true,
        details: [{ name: "fake-harness", status: "ok", detail: "deterministic in-process test double" }],
      };
    },
    async attest(_guest: Guest, request: HarnessRequest): Promise<HarnessAttestation> {
      assertNotAborted(request.signal, "harness attest");
      return { runtime: runtimeIdentity(request, version), checkedAt: FAKE_CLOCK };
    },
    async run(guest: Guest, request: HarnessRequest): Promise<HarnessRunResult> {
      const isWallClockAbort = (signal?: AbortSignal): boolean => {
        if (!signal?.aborted) return false;
        const msg = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "");
        return msg.includes("wall-clock deadline");
      };

      if (isWallClockAbort(request.signal)) {
        return {
          outcome: "task-limit",
          messages: [],
          toolSteps: [],
          usage: {
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            providerRequests: 0,
            toolSteps: 0,
          },
          timing: { startedAt: FAKE_CLOCK, completedAt: FAKE_CLOCK, durationMs: 0 },
          runtime: runtimeIdentity(request, version),
          failures: [],
        };
      }

      assertNotAborted(request.signal, "harness run");
      const before = await guest.exportFiles({
        root: request.workspaceRoot,
        maxFiles: request.limits.maxExportedFiles,
        maxFileBytes: request.limits.maxExportedFileBytes,
        maxTotalBytes: request.limits.maxWorkspaceBytes,
        signal: request.signal,
      });
      const workspace = before.files.map((file) => ({
        path: file.path,
        text: Buffer.from(file.base64, "base64").toString("utf8"),
      }));

      const response = await script(request, workspace);

      if (isWallClockAbort(request.signal)) {
        return {
          outcome: "task-limit",
          messages: [],
          toolSteps: [],
          usage: {
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            providerRequests: 0,
            toolSteps: 0,
          },
          timing: { startedAt: FAKE_CLOCK, completedAt: FAKE_CLOCK, durationMs: 0 },
          runtime: runtimeIdentity(request, version),
          failures: [],
        };
      }

      for (const write of response.writes ?? []) {
        if (isWallClockAbort(request.signal)) {
          break;
        }
        assertNotAborted(request.signal, "harness run");
        await guest.stage({
          destDir: request.workspaceRoot,
          files: [{ path: write.path, base64: Buffer.from(write.text, "utf8").toString("base64"), mode: 0o644 }],
          readOnly: false,
          signal: request.signal,
        });
      }

      const prompt = truncate(request.prompt);
      const assistant = truncate(response.assistantText ?? "");
      const messages: NormalizedMessage[] = [
        { index: 0, role: "user", text: prompt.text, truncated: prompt.truncated },
        { index: 1, role: "assistant", text: assistant.text, truncated: assistant.truncated },
      ];
      const toolSteps = response.toolSteps ?? [];

      return {
        outcome: isWallClockAbort(request.signal) ? "task-limit" : response.outcome,
        messages,
        toolSteps,
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          providerRequests: response.providerRequests ?? 0,
          toolSteps: toolSteps.length,
        },
        timing: { startedAt: FAKE_CLOCK, completedAt: FAKE_CLOCK, durationMs: 0 },
        runtime: runtimeIdentity(request, version),
        failures: response.failures ?? [],
        ...(response.nativeSessionEntries ? { nativeSessionEntries: response.nativeSessionEntries } : {}),
        ...(response.nativeSessionRedactions ? { nativeSessionRedactions: response.nativeSessionRedactions } : {}),
      };
    },
  };
}
