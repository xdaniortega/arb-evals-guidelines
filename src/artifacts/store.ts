/**
 * Journals of external effects and write-once evidence sealing.
 *
 * This module owns "what is written and what is immutable". Two separate concerns live
 * here because they share one invariant — nothing about a run may be silently changed
 * after the fact:
 *
 * - The **journal** exists for crash and signal recovery. Every external effect (image
 *   build, network create, guest create, destruction, verification) is appended with its
 *   exact intended identity BEFORE it is attempted and with the observed identity after.
 *   Cleanup and recovery therefore never need to scan by name, label, or prefix: they
 *   replay exact identities. A broad scan would be capable of destroying a resource this
 *   run never created, which is why it is forbidden rather than merely discouraged.
 * - The **evidence store** is write-once. A second write to a sealed path is an
 *   `evidence-invalid` failure, not an overwrite, so a report can never be produced from
 *   evidence that was quietly repaired. Records are canonical JSON, hashed into a sorted
 *   file tree manifest, and the manifest hash is referenced by the receipt, giving the
 *   chain receipt -> manifest -> pair -> condition -> artifacts.
 *
 * Two things deliberately sit OUTSIDE the hash chain: `views/`, which is regenerable and
 * not authoritative, and `recovery/`, which is appended later by an exact-ID recovery and
 * must not appear to have mutated the sealed run.
 *
 * Every promoted artifact is scanned for guarded secrets before it reaches disk. On a hit
 * only a redacted failure record is retained at that path and the write fails with
 * `secret-quarantine`; the offending bytes are never written.
 */

import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertSafeRelativePath,
  buildManifestTree,
  canonicalJson,
  resourceNameFor,
  sha256Hex,
} from "../core/experiment.ts";
import type { ManifestEntry, ManifestTree } from "../core/experiment.ts";
import { EvalError, EVIDENCE_SCHEMA_VERSION, SCHEMA_VERSION } from "../core/types.ts";
import type { ConditionId } from "../core/types.ts";
import { scanForSecrets } from "../core/secret-scan.ts";
import type { GuardedSecret } from "../core/secret-scan.ts";
import type { ResourceKind } from "../sandboxes/sandbox.ts";

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export const JOURNAL_EVENTS = ["intent", "observed"] as const;
export type JournalEvent = (typeof JOURNAL_EVENTS)[number];

export const JOURNAL_ACTIONS = ["create", "destroy", "verify"] as const;
export type JournalAction = (typeof JOURNAL_ACTIONS)[number];

export interface JournalEntry {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly sequence: number;
  readonly event: JournalEvent;
  readonly action: JournalAction;
  readonly kind: ResourceKind;
  /** The exact identity. Never a prefix, pattern, or label selector. */
  readonly name: string;
  readonly nonce: string;
  readonly conditionId: ConditionId | null;
  /** Observed status: created, destroyed, already-absent, failed, present, absent. */
  readonly status: string | null;
}

export interface JournalRecordInput {
  readonly event: JournalEvent;
  readonly action: JournalAction;
  readonly kind: ResourceKind;
  readonly name: string;
  readonly conditionId: ConditionId | null;
  readonly status: string | null;
}

export interface RunJournal {
  readonly path: string;
  record(input: JournalRecordInput): Promise<JournalEntry>;
  entries(): readonly JournalEntry[];
}

export interface RunJournalOptions {
  readonly stateDir: string;
  readonly runId: string;
  readonly nonce: string;
}

/** `.state` is generated, git-ignored, and owner-only. */
export async function ensureStateDir(stateDir: string): Promise<string> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  return stateDir;
}

export function journalPathFor(stateDir: string, runId: string): string {
  return join(stateDir, `${assertSafeRelativePath(runId, "runId")}.journal.jsonl`);
}

/**
 * Append-only, newline-delimited canonical JSON.
 *
 * Each line is flushed with `datasync()` before the call resolves. A journal that is
 * still in a page cache when the process is killed is worthless precisely when it
 * matters, so durability is paid for on every line rather than at close.
 */
export async function createRunJournal(options: RunJournalOptions): Promise<RunJournal> {
  await ensureStateDir(options.stateDir);
  const path = journalPathFor(options.stateDir, options.runId);
  const written: JournalEntry[] = [];
  let sequence = 0;

  return {
    path,
    async record(input: JournalRecordInput): Promise<JournalEntry> {
      sequence += 1;
      const entry: JournalEntry = {
        schemaVersion: SCHEMA_VERSION,
        runId: options.runId,
        sequence,
        event: input.event,
        action: input.action,
        kind: input.kind,
        name: input.name,
        nonce: options.nonce,
        conditionId: input.conditionId,
        status: input.status,
      };
      const handle = await open(path, "a", 0o600);
      try {
        await handle.write(`${canonicalJson(entry, "journal entry")}\n`);
        await handle.datasync();
      } finally {
        await handle.close();
      }
      written.push(entry);
      return entry;
    },
    entries(): readonly JournalEntry[] {
      return [...written];
    },
  };
}

function decodeJournalEntry(value: unknown, at: string): JournalEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EvalError("evidence-invalid", `${at} must be a JSON object`, { at });
  }
  const record = value as Record<string, unknown>;
  const requireStringField = (key: string): string => {
    const found = record[key];
    if (typeof found !== "string" || found === "") {
      throw new EvalError("evidence-invalid", `${at}.${key} must be a non-empty string`, { at });
    }
    return found;
  };
  const event = requireStringField("event");
  const action = requireStringField("action");
  const kind = requireStringField("kind");
  if (!(JOURNAL_EVENTS as readonly string[]).includes(event)) {
    throw new EvalError("evidence-invalid", `${at}.event is unknown: ${event}`, { at });
  }
  if (!(JOURNAL_ACTIONS as readonly string[]).includes(action)) {
    throw new EvalError("evidence-invalid", `${at}.action is unknown: ${action}`, { at });
  }
  if (!["image", "network", "guest"].includes(kind)) {
    throw new EvalError("evidence-invalid", `${at}.kind is unknown: ${kind}`, { at });
  }
  if (!Number.isSafeInteger(record.sequence)) {
    throw new EvalError("evidence-invalid", `${at}.sequence must be an integer`, { at });
  }
  const conditionId = record.conditionId;
  const status = record.status;
  return {
    schemaVersion: Number(record.schemaVersion),
    runId: requireStringField("runId"),
    sequence: record.sequence as number,
    event: event as JournalEvent,
    action: action as JournalAction,
    kind: kind as ResourceKind,
    name: requireStringField("name"),
    nonce: requireStringField("nonce"),
    conditionId: conditionId === null ? null : (conditionId as ConditionId),
    status: status === null || status === undefined ? null : String(status),
  };
}

/**
 * @notice Loads an exact run's journal, rejecting missing or invalid evidence.
 * @param stateDir Root directory for resource journals.
 * @param runId Exact run identity to read.
 * @returns Validated entries in journal order.
 */
export async function readRunJournal(stateDir: string, runId: string): Promise<readonly JournalEntry[]> {
  const path = journalPathFor(stateDir, runId);
  const raw = await readFile(path, "utf8").catch((cause: unknown) => {
    throw new EvalError("evidence-invalid", `no journal exists for run ${runId}: ${path}`, {
      at: "journal",
      cause,
    });
  });
  const entries: JournalEntry[] = [];
  const lines = raw.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (cause: unknown) {
      throw new EvalError("evidence-invalid", `journal line ${index + 1} is not JSON`, { at: "journal", cause });
    }
    const entry = decodeJournalEntry(parsed, `journal line ${index + 1}`);
    if (entry.runId !== runId) throw new EvalError("evidence-invalid", `journal line ${index + 1} belongs to a different run`, { at: "journal" });
    if (entry.sequence !== entries.length + 1) throw new EvalError("evidence-invalid", `journal sequence is not exact at line ${index + 1}`, { at: "journal" });
    if (entry.schemaVersion !== SCHEMA_VERSION) throw new EvalError("evidence-invalid", `journal line ${index + 1} has unsupported schemaVersion`, { at: "journal" });
    if (entries.length > 0 && entry.nonce !== entries[0]!.nonce) throw new EvalError("evidence-invalid", "journal mixes resource ownership nonces", { at: "journal" });
    if (entry.conditionId !== null && entry.conditionId !== "baseline" && entry.conditionId !== "treatment") throw new EvalError("evidence-invalid", `journal line ${index + 1} has invalid condition ownership`, { at: "journal" });
    if (entry.action === "create" && (entry.kind === "guest" || entry.kind === "network")) {
      if (entry.conditionId === null) {
        const componentPattern = entry.kind === "guest" ? /^eval-[vd]guest-[0-9a-f]{8}$/ : /^eval-[vd]net-[0-9a-f]{8}$/;
        if (!componentPattern.test(entry.name)) throw new EvalError("evidence-invalid", `journal line ${index + 1} has a non-derivable component resource name`, { at: "journal" });
      } else {
        const match = /-r([0-9]{3,})-(?:baseline|treatment)-[0-9a-f]{4,12}$/.exec(entry.name);
        const repetition = match === null ? 0 : Number(match[1]);
        const expected = repetition > 0 ? resourceNameFor(entry.kind === "guest" ? "guest" : "net", { runId, resourceNonce: entry.nonce }, repetition, entry.conditionId) : null;
        if (entry.name !== expected) throw new EvalError("evidence-invalid", `journal line ${index + 1} has a resource name not derived from its run, nonce, and condition`, { at: "journal" });
      }
    }
    entries.push(entry);
  }
  if (entries.length === 0) throw new EvalError("evidence-invalid", `journal for run ${runId} is empty`, { at: "journal" });
  return entries;
}

export interface JournaledIdentity {
  readonly kind: ResourceKind;
  readonly name: string;
  readonly conditionId: ConditionId | null;
}

/**
 * The exact identities a run ever intended to create, deduplicated and ordered.
 *
 * Cleanup and recovery consume only this. Intents are used rather than observations
 * because a create that crashed between intent and observation is precisely the leak
 * recovery must be able to reach.
 */
export function journaledIdentities(entries: readonly JournalEntry[]): readonly JournaledIdentity[] {
  const seen = new Map<string, ConditionId | null>();
  const nameKinds = new Map<string, ResourceKind>();
  const identities: JournaledIdentity[] = [];
  for (const entry of entries) {
    if (entry.action !== "create") continue;
    const priorKind = nameKinds.get(entry.name);
    if (priorKind !== undefined && priorKind !== entry.kind) throw new EvalError("evidence-invalid", `journal assigns ${entry.name} to conflicting resource kinds`, { at: "journal" });
    nameKinds.set(entry.name, entry.kind);
    const key = `${entry.kind}:${entry.name}`;
    if (seen.has(key)) {
      if (seen.get(key) !== entry.conditionId) throw new EvalError("evidence-invalid", `journal assigns ${key} to conflicting condition owners`, { at: "journal" });
      continue;
    }
    seen.set(key, entry.conditionId);
    identities.push({ kind: entry.kind, name: entry.name, conditionId: entry.conditionId });
  }
  return identities;
}

// ---------------------------------------------------------------------------
// Evidence store
// ---------------------------------------------------------------------------

export const MANIFEST_FILE = "manifest.json";
export const RECEIPT_FILE = "receipt.json";
export const VIEWS_DIR = "views";
export const RECOVERY_DIR = "recovery";

/**
 * Generated, regenerable run-folder exports. Exact root names only; they are outputs
 * recomputed from sealed evidence, never evidence, and are never read by verification.
 */
export const RUN_EXPORT_FILES = ["EVALS.md", "EVALS-FULL-REPORT.md"] as const;

/** True for exactly the two root-level generated export names. */
export function isRunExportFile(relativePath: string): boolean {
  return (RUN_EXPORT_FILES as readonly string[]).includes(relativePath);
}

/** Paths that are never part of the hash chain the manifest covers. */
export function isChainExcludedPath(relativePath: string): boolean {
  return (
    relativePath === MANIFEST_FILE ||
    isRunExportFile(relativePath) ||
    relativePath === RECEIPT_FILE ||
    relativePath === VIEWS_DIR ||
    relativePath === RECOVERY_DIR ||
    relativePath.startsWith(`${VIEWS_DIR}/`) ||
    relativePath.startsWith(`${RECOVERY_DIR}/`)
  );
}

export interface SealedManifest {
  readonly tree: ManifestTree;
  /** SHA-256 of the manifest.json bytes, so the receipt binds the file, not just the tree. */
  readonly fileSha256: string;
}

export interface EvidenceStore {
  readonly runDir: string;
  /** Writes one immutable canonical-JSON artifact and returns its manifest entry. */
  writeRecord(relativePath: string, value: unknown): Promise<ManifestEntry>;
  /** Writes one immutable raw file (text or binary bytes) and returns its manifest entry. */
  writeFile(relativePath: string, content: string | Uint8Array): Promise<ManifestEntry>;
  /** Writes a regenerable view. Views are excluded from the manifest and the chain. */
  writeView(relativePath: string, text: string): Promise<void>;
  sealManifest(): Promise<SealedManifest>;
  sealReceipt(value: unknown): Promise<{ readonly path: string; readonly sha256: string }>;
  entries(): readonly ManifestEntry[];
}

export interface EvidenceStoreOptions {
  readonly runDir: string;
  /** Secrets loaded at the process boundary. The store never reads ambient environment. */
  readonly guardedSecrets?: readonly GuardedSecret[];
}

function isEexist(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "EEXIST";
}

function assertEvidencePath(relativePath: string): string {
  return assertSafeRelativePath(relativePath, "evidence path");
}

/**
 * Write-once file creation, shared by the evidence store and by exact-ID recovery.
 *
 * `flag: "wx"` is the whole point: it refuses rather than truncates, so a sealed path
 * can never be quietly replaced by a later process.
 */
export async function writeSealedFile(absolutePath: string, body: string | Uint8Array, at: string): Promise<string> {
  await mkdir(dirname(absolutePath), { recursive: true, mode: 0o755 });
  await writeFile(absolutePath, body, { mode: 0o444, flag: "wx" }).catch((cause: unknown) => {
    if (isEexist(cause)) {
      throw new EvalError("evidence-invalid", `sealed evidence is write-once; ${at} already exists`, {
        at,
        cause,
      });
    }
    throw new EvalError("evidence-invalid", `evidence path is not writable: ${at}`, { at, cause });
  });
  return sha256Hex(body);
}

export async function createEvidenceStore(options: EvidenceStoreOptions): Promise<EvidenceStore> {
  await mkdir(options.runDir, { recursive: true, mode: 0o755 });
  const guardedSecrets = options.guardedSecrets ?? [];
  const entries: ManifestEntry[] = [];
  const writtenPaths = new Set<string>();
  let manifestSealed = false;
  let receiptSealed = false;

  /**
   * Write-once at two levels: an in-process set catches a repeated write inside one run,
   * and `flag: "wx"` catches a path that already exists on disk from an earlier process.
   * Neither truncates.
   */
  const writeOnce = async (relativePath: string, body: string | Uint8Array): Promise<void> => {
    if (writtenPaths.has(relativePath)) {
      throw new EvalError(
        "evidence-invalid",
        `sealed evidence is write-once; ${relativePath} was already written`,
        { at: relativePath },
      );
    }
    await writeSealedFile(join(options.runDir, relativePath), body, relativePath);
    writtenPaths.add(relativePath);
  };

  return {
    runDir: options.runDir,

    async writeRecord(relativePath: string, value: unknown): Promise<ManifestEntry> {
      const path = assertEvidencePath(relativePath);
      if (isChainExcludedPath(path)) {
        throw new EvalError(
          "evidence-invalid",
          `${path} is reserved and cannot be written as a chained record`,
          { at: path },
        );
      }
      if (manifestSealed) {
        throw new EvalError("evidence-invalid", `manifest is already sealed; cannot write ${path}`, { at: path });
      }
      const body = `${canonicalJson(value, path)}\n`;

      // The host re-scan before promotion. Guest-side sanitizing is not trusted, and a
      // record that echoes a credential must never reach disk in any form.
      const hits = scanForSecrets({ path, content: body }, guardedSecrets);
      if (hits.length > 0) {
        const redacted = {
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
          quarantined: true,
          path,
          reason: "a guarded secret was detected in this artifact; the content was discarded",
          hits: hits.map((hit) => ({ label: hit.label, encoding: hit.encoding, path: hit.path })),
        };
        // The redacted record IS evidence, so it is manifested and hashed into the chain
        // like any other artifact. It carries only a label, an encoding, and a path —
        // never a secret value — so covering it is safe, and leaving it unmanifested
        // would put it in an unverified region of the evidence tree.
        const redactedBody = `${canonicalJson(redacted, path)}\n`;
        await writeOnce(path, redactedBody);
        entries.push({
          path,
          sha256: sha256Hex(redactedBody),
          bytes: Buffer.byteLength(redactedBody),
        });
        throw new EvalError(
          "secret-quarantine",
          `artifact ${path} contained a guarded secret (${hits[0]?.label ?? "unknown"}, ${hits[0]?.encoding ?? "raw"}); only a redacted record was retained`,
          { at: path },
        );
      }

      await writeOnce(path, body);
      const entry: ManifestEntry = {
        path,
        sha256: sha256Hex(body),
        bytes: Buffer.byteLength(body),
      };
      entries.push(entry);
      return entry;
    },

    async writeFile(relativePath: string, content: string | Uint8Array): Promise<ManifestEntry> {
      const path = assertEvidencePath(relativePath);
      if (isChainExcludedPath(path)) {
        throw new EvalError(
          "evidence-invalid",
          `${path} is reserved and cannot be written as a chained record`,
          { at: path },
        );
      }
      if (manifestSealed) {
        throw new EvalError("evidence-invalid", `manifest is already sealed; cannot write ${path}`, { at: path });
      }

      const hits = scanForSecrets({ path, content }, guardedSecrets);
      if (hits.length > 0) {
        const redacted = {
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
          quarantined: true,
          path,
          reason: "a guarded secret was detected in this artifact; the content was discarded",
          hits: hits.map((hit) => ({ label: hit.label, encoding: hit.encoding, path: hit.path })),
        };
        const redactedBody = `${canonicalJson(redacted, path)}\n`;
        await writeOnce(path, redactedBody);
        entries.push({
          path,
          sha256: sha256Hex(redactedBody),
          bytes: Buffer.byteLength(redactedBody),
        });
        throw new EvalError(
          "secret-quarantine",
          `artifact ${path} contained a guarded secret (${hits[0]?.label ?? "unknown"}, ${hits[0]?.encoding ?? "raw"}); only a redacted record was retained`,
          { at: path },
        );
      }

      const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
      await writeOnce(path, bytes);
      const entry: ManifestEntry = {
        path,
        sha256: sha256Hex(bytes),
        bytes: bytes.byteLength,
      };
      entries.push(entry);
      return entry;
    },

    async writeView(relativePath: string, text: string): Promise<void> {
      const path = assertEvidencePath(`${VIEWS_DIR}/${relativePath}`);
      const absolute = join(options.runDir, path);
      await mkdir(dirname(absolute), { recursive: true, mode: 0o755 });
      // Views are regenerable and outside the chain, so they may be rewritten.
      await writeFile(absolute, text, { mode: 0o644 });
    },

    async sealManifest(): Promise<SealedManifest> {
      if (manifestSealed) {
        throw new EvalError("evidence-invalid", "manifest.json is write-once and already sealed", {
          at: MANIFEST_FILE,
        });
      }
      const tree = buildManifestTree(entries, EVIDENCE_SCHEMA_VERSION);
      const body = `${canonicalJson(tree, MANIFEST_FILE)}\n`;
      await writeOnce(MANIFEST_FILE, body);
      manifestSealed = true;
      return { tree, fileSha256: sha256Hex(body) };
    },

    async sealReceipt(value: unknown): Promise<{ path: string; sha256: string }> {
      if (!manifestSealed) {
        throw new EvalError(
          "evidence-invalid",
          "receipt.json must reference a sealed manifest; seal the manifest first",
          { at: RECEIPT_FILE },
        );
      }
      if (receiptSealed) {
        throw new EvalError("evidence-invalid", "receipt.json is write-once and already sealed", {
          at: RECEIPT_FILE,
        });
      }
      const body = `${canonicalJson(value, RECEIPT_FILE)}\n`;
      const hits = scanForSecrets({ path: RECEIPT_FILE, content: body }, guardedSecrets);
      if (hits.length > 0) {
        throw new EvalError("secret-quarantine", "receipt contained a guarded secret and was not written", {
          at: RECEIPT_FILE,
        });
      }
      await writeOnce(RECEIPT_FILE, body);
      receiptSealed = true;
      return { path: join(options.runDir, RECEIPT_FILE), sha256: sha256Hex(body) };
    },

    entries(): readonly ManifestEntry[] {
      return [...entries];
    },
  };
}
