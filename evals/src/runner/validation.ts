/**
 * Candidate projection and validator dispatch.
 *
 * The raw exported workspace and the projected candidate the validator actually scored
 * are kept separate. The validator is a deterministic pure function of (candidate,
 * fixture, output path, oracle) and is identical for both arms of a pair.
 */

import { pathToFileURL } from "node:url";
import {
  CANDIDATE_MODES,
  EvalError,
  WORKSPACE_OUTPUT_MARKER,
  assertNotAborted,
  decodeValidationOutcome,
  toStructuredFailure,
} from "../core/types.ts";
import type {
  CandidateMode,
  CaseValidatorModule,
  SnapshotValidationInput,
  StructuredFailure,
  ValidationOutcome,
} from "../core/types.ts";
import { assertSafeRelativePath } from "../core/experiment.ts";
import type { FrozenFile } from "./case-loader.ts";

export { CANDIDATE_MODES, WORKSPACE_OUTPUT_MARKER };
export type { CandidateMode };

export interface ExportedFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly base64: string;
}

export interface SkippedFile {
  readonly path: string;
  readonly reason: "not-requested" | "too-large" | "unsafe-path" | "workspace-budget-exhausted";
}

export interface CandidateProjection {
  /** Base64 file map handed to the validator; never a live filesystem path. */
  readonly candidateFiles: Readonly<Record<string, string>>;
  readonly includedPaths: readonly string[];
  readonly skipped: readonly SkippedFile[];
}

/**
 * Projects the bounded candidate the validator will actually score.
 *
 * A missing output is not an error here: the validator grades its absence.
 *
 * A duplicate exported path IS an error. Letting the last entry win would allow a guest
 * to choose which bytes get graded purely through export ordering, and it would be
 * inconsistent with buildManifestTree, which already treats a duplicate path as an
 * evidence defect.
 *
 * Files are processed in sorted path order in BOTH modes, so the aggregate budget in
 * workspace mode consumes the same files for the same input regardless of the order the
 * sandbox happened to walk the tree. A nondeterministic candidate would make the same
 * exported bytes score differently across runs.
 */
export function projectCandidate(input: {
  readonly exportedFiles: readonly ExportedFile[];
  readonly outputPath: string;
  readonly maxFileBytes: number;
  readonly mode: CandidateMode;
  /** Aggregate cap on included bytes. Required in workspace mode. */
  readonly maxTotalBytes?: number;
}): CandidateProjection {
  if (input.mode === "file" && input.outputPath === WORKSPACE_OUTPUT_MARKER) {
    throw new EvalError(
      "input-invalid",
      `outputPath cannot be ${WORKSPACE_OUTPUT_MARKER} in file candidateMode`,
      { at: "case.json#outputPath" },
    );
  }
  const outputPath = input.outputPath === WORKSPACE_OUTPUT_MARKER
    ? WORKSPACE_OUTPUT_MARKER
    : assertSafeRelativePath(input.outputPath, "case.json#outputPath");
  const candidateFiles: Record<string, string> = {};
  const includedPaths: string[] = [];
  const skipped: SkippedFile[] = [];

  const seenPaths = new Set<string>();
  const eligible: Array<{ path: string; file: ExportedFile }> = [];

  for (const file of input.exportedFiles) {
    let safePath: string;
    try {
      safePath = assertSafeRelativePath(file.path, "exported file path");
    } catch {
      skipped.push({ path: file.path, reason: "unsafe-path" });
      continue;
    }
    if (seenPaths.has(safePath)) {
      throw new EvalError(
        "evidence-invalid",
        `exported tree contains a duplicate path: ${safePath}`,
        { at: "exported file path" },
      );
    }
    seenPaths.add(safePath);
    if (input.mode === "file" && safePath !== outputPath) {
      skipped.push({ path: safePath, reason: "not-requested" });
      continue;
    }
    eligible.push({ path: safePath, file });
  }

  eligible.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const maxTotalBytes = input.maxTotalBytes ?? Number.POSITIVE_INFINITY;
  let totalBytes = 0;
  for (const entry of eligible) {
    if (entry.file.bytes > input.maxFileBytes) {
      skipped.push({ path: entry.path, reason: "too-large" });
      continue;
    }
    if (input.mode === "workspace" && totalBytes + entry.file.bytes > maxTotalBytes) {
      skipped.push({ path: entry.path, reason: "workspace-budget-exhausted" });
      continue;
    }
    totalBytes += entry.file.bytes;
    candidateFiles[entry.path] = entry.file.base64;
    includedPaths.push(entry.path);
  }

  return { candidateFiles, includedPaths, skipped };
}

export function fixtureFileMap(files: readonly FrozenFile[]): Readonly<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const file of files) map[file.path] = file.base64;
  return map;
}

export interface ValidatorBundleFile {
  readonly path: string;
  readonly base64: string;
}

export interface ValidatorRequest {
  readonly validatorPath: string;
  readonly input: SnapshotValidationInput;
  /** Frozen validator source bytes as utf8 string, when available. */
  readonly validatorSource?: string;
  /** Entry path relative to validator root / bundle (e.g. "validator.ts"). */
  readonly validatorEntryPath?: string;
  /** Frozen validator bundle files containing entry file and all dependencies. */
  readonly validatorBundle?: readonly ValidatorBundleFile[];
  /**
   * Cooperative cancellation. Implementations MUST check it on entry and fail with
   * EvalError `interrupted` when aborted, so validation can be bounded by the run's
   * wall clock and by a signal.
   */
  readonly signal?: AbortSignal;
  /**
   * Hard upper bound on the whole validator run, in milliseconds.
   *
   * Derived by the runner from the already-resolved wall-clock limit; never a constant
   * invented here. Omitted only by callers that have no resolved limits (unit tests).
   * Exceeding it is a `validator-infrastructure` outcome with `score: null`, never a
   * task failure.
   */
  readonly deadlineMs?: number;
  /** Absolute cleanup deadline supplied by the invocation; standalone runners use a finite cap. */
  readonly cleanupDeadlineAtMs?: number;
}

export interface ValidatorRun {
  readonly runnerId: string;
  readonly testDouble: boolean;
  readonly outcome: ValidationOutcome;
  readonly failure: StructuredFailure | null;
  readonly durationMs: number;
}

export interface ValidatorRunner {
  readonly id: string;
  /** True when the runner does not provide contract-grade isolation. */
  readonly testDouble: boolean;
  run(request: ValidatorRequest): Promise<ValidatorRun>;
}

function infrastructureOutcome(failure: StructuredFailure): ValidationOutcome {
  return {
    status: "infrastructure-failure",
    score: null,
    fullPass: null,
    checks: [{ id: "validator-infrastructure", passed: false, message: failure.message.slice(0, 1_000) }],
  };
}

/**
 * Races a validator against its deadline and against cooperative cancellation.
 *
 * A deadline can only pre-empt a validator that yields; a validator that blocks the loop
 * synchronously is still caught after the fact by the elapsed-time check in the caller.
 * The losing promise is explicitly silenced so a late rejection is never unhandled.
 */
async function withValidatorDeadline<T>(
  work: Promise<T>,
  deadlineMs: number | null,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (deadlineMs === null && signal === undefined) return work;
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  const bound = new Promise<never>((_resolve, reject) => {
    if (deadlineMs !== null) {
      timer = setTimeout(() => {
        reject(
          new EvalError(
            "validator-infrastructure",
            `the validator exceeded its bounded deadline of ${deadlineMs}ms and was abandoned`,
            { at: "validator run" },
          ),
        );
      }, deadlineMs);
      if (typeof timer.unref === "function") timer.unref();
    }
    if (signal !== undefined) {
      onAbort = (): void => {
        reject(new EvalError("interrupted", "the validator run was aborted", { at: "validator run" }));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([work, bound]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (onAbort !== null) signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Host, in-process validator runner.
 *
 * The validator is owner-authored trusted code and receives only immutable base64
 * strings, so no guest-authored code executes and the candidate cannot be mutated.
 * It is still a test double: it does not prove network and credential isolation, so it
 * is only usable in `fake` mode.
 *
 * The run is bounded: a pathological validator produces a `validator-infrastructure`
 * outcome with `score: null` rather than hanging the run or scoring a task failure.
 */
export function createInProcessValidatorRunner(): ValidatorRunner {
  return {
    id: "in-process",
    testDouble: true,
    async run(request: ValidatorRequest): Promise<ValidatorRun> {
      const startedAt = Date.now();
      const deadlineMs =
        typeof request.deadlineMs === "number" && Number.isFinite(request.deadlineMs) && request.deadlineMs > 0
          ? request.deadlineMs
          : null;
      try {
        assertNotAborted(request.signal, "validator run");
        const outcome = await withValidatorDeadline(
          (async (): Promise<ValidationOutcome> => {
            const loaded = (await import(pathToFileURL(request.validatorPath).href)) as Partial<CaseValidatorModule>;
            if (typeof loaded.validateSnapshot !== "function") {
              throw new EvalError(
                "validator-infrastructure",
                `validator ${request.validatorPath} does not export validateSnapshot()`,
              );
            }
            return decodeValidationOutcome(loaded.validateSnapshot(request.input), "validator outcome");
          })(),
          deadlineMs,
          request.signal,
        );
        // A validator that blocked the event loop cannot be pre-empted; it is still
        // refused after the fact rather than allowed to contribute a score.
        const elapsedMs = Date.now() - startedAt;
        if (deadlineMs !== null && elapsedMs > deadlineMs) {
          throw new EvalError(
            "validator-infrastructure",
            `the validator took ${elapsedMs}ms, exceeding its bounded deadline of ${deadlineMs}ms`,
            { at: "validator run" },
          );
        }
        return {
          runnerId: "in-process",
          testDouble: true,
          outcome,
          failure: null,
          durationMs: Date.now() - startedAt,
        };
      } catch (error: unknown) {
        const failure = toStructuredFailure(error, "validator-infrastructure");
        return {
          runnerId: "in-process",
          testDouble: true,
          outcome: infrastructureOutcome(failure),
          failure,
          durationMs: Date.now() - startedAt,
        };
      }
    },
  };
}
