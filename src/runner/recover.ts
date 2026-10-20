/**
 * Exact-run-identifier recovery.
 *
 * A run can die between journaling an intent and observing the effect, or between
 * creating a guest and destroying it. Recovery exists so the leftover can be found and
 * removed WITHOUT ever guessing: it replays the run's own journal and acts only on the
 * exact identities that journal names. It never lists, greps, prefixes, or label-matches
 * live resources, because such a scan is capable of destroying something this run never
 * created.
 *
 * Two prohibitions shape the output. Recovery MUST NOT edit or delete prior evidence, so
 * it appends under `recovery/<recovery-id>/` — a directory the sealed manifest and
 * `verifyRun` deliberately exclude, with its own manifest and receipt so the appended
 * record is itself verifiable. And recovery MUST NOT re-run a task: it has no harness, no
 * validator, and no way to produce a score.
 */

import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeRelativePath, buildManifestTree, canonicalJson, sha256Hex } from "../core/experiment.ts";
import { EVAL_CASES_DIR, listCaseDirectories } from "./case-loader.ts";
import type { ManifestEntry } from "../core/experiment.ts";
import { EvalError, SCHEMA_VERSION, toStructuredFailure } from "../core/types.ts";
import type { StructuredFailure } from "../core/types.ts";
import type { DestroyOutcome, ResourceKind, Sandbox } from "../sandboxes/sandbox.ts";
import { RECOVERY_DIR, journaledIdentities, readRunJournal, writeSealedFile } from "../artifacts/store.ts";

export interface RecoveredResource {
  readonly kind: ResourceKind;
  readonly name: string;
  readonly presenceBefore: "present" | "absent" | "unknown";
  readonly action: "destroyed" | "already-absent" | "preserved-shared-image" | "failed";
  readonly verifiedAbsent: boolean;
  readonly failure: StructuredFailure | null;
}

export interface RecoveryResult {
  readonly runId: string;
  readonly runDir: string;
  readonly recoveryId: string;
  readonly recoveryDir: string;
  readonly journalPath: string;
  readonly resources: readonly RecoveredResource[];
  readonly ok: boolean;
  readonly receiptPath: string;
}

/**
 * @notice Locates one retained run across canonical and historical evidence namespaces.
 * @param evalsRoot Root of the evals evidence tree.
 * @param runId Exact run identifier supplied by the operator.
 * @returns The exact run directory path when the identifier is unique.
 * @dev Rejects duplicate identifiers instead of guessing which evidence should be recovered.
 */
export async function findRunDirectory(evalsRoot: string, runId: string): Promise<string> {
  const safeRunId = assertSafeRelativePath(runId, "--run");
  const matches: string[] = [];
  const candidates: string[] = (await listCaseDirectories(evalsRoot)).map((entry) => join(entry.dir, "runs"));
  // Legacy namespaces: <root>/<namespace>/runs, never inside eval-cases.
  const legacy = await readdir(evalsRoot, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => {
    throw new EvalError("input-invalid", `evidence namespace root is not readable: ${evalsRoot}`, { at: "--run", cause });
  });
  for (const entry of legacy) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === EVAL_CASES_DIR) continue;
    candidates.push(join(evalsRoot, entry.name, "runs"));
  }
  for (const runsDir of candidates) {
    const runsStats = await lstat(runsDir).catch(() => null);
    if (runsStats === null || !runsStats.isDirectory() || runsStats.isSymbolicLink()) continue;
    const candidate = join(runsDir, safeRunId);
    const found = await lstat(candidate).then((stats) => stats.isDirectory() && !stats.isSymbolicLink()).catch(() => false);
    if (found) matches.push(candidate);
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new EvalError("input-invalid", `run id ${safeRunId} is ambiguous across namespaces`, { at: "--run" });
  throw new EvalError("input-invalid", `no run directory exists for run id ${safeRunId}`, { at: "--run" });
}

export interface RecoverOptions {
  readonly evalsRoot: string;
  readonly runId: string;
  readonly sandbox: Sandbox;
  readonly stateDir?: string;
  /** Explicit run directory, for tests that seal outside the repository. */
  readonly runDir?: string;
  /** Identifier of this recovery attempt. Must be unique within the run. */
  readonly recoveryId: string;
  readonly attemptedAt: string;
  readonly signal?: AbortSignal;
  readonly deadlineAtMs?: number;
}

/**
 * @notice Audits and tears down orphaned sandbox containers and networks from interrupted runs to restore clean host state.
 * @param options Recovery parameters specifying run ID, sandbox driver, state directory, and cancellation signal.
 * @returns Audit report detailing inspected resources, teardown actions taken, and remaining presence verification.
 * @dev Resource teardown strictly processes guest containers before networks, while shared base container images are intentionally preserved.
 */
export async function recoverRun(options: RecoverOptions): Promise<RecoveryResult> {
  const runId = assertSafeRelativePath(options.runId, "--run");
  const recoveryId = assertSafeRelativePath(options.recoveryId, "recoveryId");
  const stateDir = options.stateDir ?? join(options.evalsRoot, ".state");
  let runDir = options.runDir;
  if (runDir === undefined) {
    try { runDir = await findRunDirectory(options.evalsRoot, runId); }
    catch (error) {
      if (!(error instanceof EvalError) || !error.message.startsWith("no run directory exists")) throw error;
      runDir = join(stateDir, "unsealed", runId);
    }
  }

  const entries = await readRunJournal(stateDir, runId);
  const identities = journaledIdentities(entries);
  const recoveryRoot = join(runDir, RECOVERY_DIR);
  const existingRecoveryRoot = await lstat(recoveryRoot).catch(() => null);
  if (existingRecoveryRoot !== null && (!existingRecoveryRoot.isDirectory() || existingRecoveryRoot.isSymbolicLink())) throw new EvalError("path-unsafe", "recovery root must be a real directory", { at: recoveryRoot });
  if (existingRecoveryRoot === null) await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
  const recoveryDir = join(recoveryRoot, recoveryId);
  await mkdir(recoveryDir, { recursive: false, mode: 0o700 }).catch((cause: unknown) => {
    throw new EvalError("evidence-invalid", `recovery destination already exists or cannot be reserved: ${recoveryDir}`, { at: recoveryDir, cause });
  });

  const resources: RecoveredResource[] = [];
  const ordered = [...identities].sort((a, b) => ({ guest: 0, network: 1, image: 2 }[a.kind] - { guest: 0, network: 1, image: 2 }[b.kind]));
  for (const identity of ordered) {
    if (options.signal?.aborted || (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs)) {
      resources.push({ kind: identity.kind, name: identity.name, presenceBefore: "unknown", action: "failed", verifiedAbsent: false, failure: { code: "interrupted", failureClass: "infrastructure", message: "recovery deadline/cancellation reached before this exact identity was inspected", at: identity.name } });
      continue;
    }
    if (identity.kind === "image") {
      resources.push({ kind: identity.kind, name: identity.name, presenceBefore: "unknown", action: "preserved-shared-image", verifiedAbsent: false, failure: null });
      continue;
    }
    let presenceBefore: "present" | "absent" | "unknown" = "unknown";
    try { presenceBefore = await options.sandbox.inspectResource(identity.kind, identity.name, options.signal); } catch { presenceBefore = "unknown"; }
    if (presenceBefore === "unknown") {
      resources.push({ kind: identity.kind, name: identity.name, presenceBefore, action: "failed", verifiedAbsent: false, failure: { code: "cleanup-failed", failureClass: "infrastructure", message: `presence of ${identity.kind} ${identity.name} could not be established; no destructive action was taken`, at: identity.name } });
      continue;
    }
    if (presenceBefore === "absent") {
      resources.push({
        kind: identity.kind,
        name: identity.name,
        presenceBefore,
        action: "already-absent",
        verifiedAbsent: true,
        failure: null,
      });
      continue;
    }
    const ownership = options.sandbox.inspectResourceOwnership === undefined
      ? { status: "unknown" as const, reason: "sandbox cannot inspect exact-object ownership metadata" }
      : await options.sandbox.inspectResourceOwnership(identity.kind, identity.name, { "eval-run": runId }, options.signal)
          .catch(() => ({ status: "unknown" as const, reason: "exact-object ownership inspection failed" }));
    if (ownership.status !== "owned") {
      resources.push({ kind: identity.kind, name: identity.name, presenceBefore, action: "failed", verifiedAbsent: false, failure: {
        code: "cleanup-failed", failureClass: "infrastructure",
        message: `${identity.kind} ${identity.name} ownership is ${ownership.status}; no destructive action was taken (${ownership.reason ?? "required eval-run label did not match"})`, at: identity.name,
      } });
      continue;
    }
    let outcome: DestroyOutcome;
    try {
      outcome = await options.sandbox.destroyResource(identity.kind, identity.name, options.signal);
    } catch (error: unknown) {
      outcome = { status: "failed", verified: false, failure: toStructuredFailure(error, "cleanup-failed") };
    }
    const presenceAfter = await options.sandbox
      .inspectResource(identity.kind, identity.name, options.signal)
      .catch(() => "present" as const);
    const verified = presenceAfter === "absent";
    resources.push({
      kind: identity.kind,
      name: identity.name,
      presenceBefore,
      action: outcome.status === "failed" || !verified ? "failed" : "destroyed",
      verifiedAbsent: verified,
      failure:
        outcome.failure ??
        (verified
          ? null
          : {
              code: "cleanup-failed",
              failureClass: "infrastructure",
              message: `${identity.kind} ${identity.name} is still present after recovery`,
              at: identity.name,
            }),
    });
  }

  const ok = resources.every((resource) => resource.action !== "failed");

  const record = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    recoveryId,
    attemptedAt: options.attemptedAt,
    sandboxId: options.sandbox.id,
    sandboxTestDouble: options.sandbox.testDouble,
    journalPath: join(stateDir, `${runId}.journal.jsonl`),
    journaledIdentityCount: identities.length,
    // Recovery never re-executes a task and never produces a score.
    taskReExecuted: false,
    priorEvidenceModified: false,
    resources: resources.map((resource) => ({ ...resource })),
    ok,
  };
  const recordBody = `${canonicalJson(record, "recovery.json")}\n`;
  const recordSha256 = await writeSealedFile(
    join(recoveryDir, "recovery.json"),
    recordBody,
    `${RECOVERY_DIR}/${recoveryId}/recovery.json`,
  );

  const manifestEntries: readonly ManifestEntry[] = [
    { path: "recovery.json", sha256: recordSha256, bytes: Buffer.byteLength(recordBody) },
  ];
  const tree = buildManifestTree(manifestEntries);
  const manifestBody = `${canonicalJson(tree, "recovery manifest.json")}\n`;
  await writeSealedFile(
    join(recoveryDir, "manifest.json"),
    manifestBody,
    `${RECOVERY_DIR}/${recoveryId}/manifest.json`,
  );

  const receipt = {
    schemaVersion: SCHEMA_VERSION,
    kind: "recovery",
    runId,
    recoveryId,
    attemptedAt: options.attemptedAt,
    ok,
    manifest: { treeSha256: tree.treeSha256, fileSha256: sha256Hex(manifestBody) },
    // Stated in the artifact itself so a reader never has to trust the code path.
    guarantees: [
      "prior evidence was neither edited nor deleted",
      "no task was re-executed",
      "only journaled exact identities were inspected or destroyed",
    ],
  };
  const receiptPath = join(recoveryDir, "receipt.json");
  await writeSealedFile(
    receiptPath,
    `${canonicalJson(receipt, "recovery receipt.json")}\n`,
    `${RECOVERY_DIR}/${recoveryId}/receipt.json`,
  );

  return {
    runId,
    runDir,
    recoveryId,
    recoveryDir,
    journalPath: record.journalPath,
    resources,
    ok,
    receiptPath,
  };
}

export function formatRecoveryResult(result: RecoveryResult): string {
  const lines: string[] = [];
  lines.push(`run       ${result.runId}`);
  lines.push(`runDir    ${result.runDir}`);
  lines.push(`recovery  ${result.recoveryId}  ${result.ok ? "OK" : "FAILED"}`);
  lines.push(`journal   ${result.journalPath}`);
  if (result.resources.length === 0) {
    lines.push("resources (none journaled)");
  }
  for (const resource of result.resources) {
    lines.push(
      `  ${resource.kind.padEnd(7)} ${resource.name}  before=${resource.presenceBefore}  action=${resource.action}  verifiedAbsent=${resource.verifiedAbsent}`,
    );
  }
  lines.push(`receipt   ${result.receiptPath}`);
  return lines.join("\n");
}
