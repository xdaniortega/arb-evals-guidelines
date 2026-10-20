/** Crash-recoverable, sanitized Pi-native session prefixes.
 *
 * Scratch captures are deliberately outside a run's immutable evidence tree. Each
 * completed native record is sanitized, canonically encoded, appended, and fsynced
 * before the SDK append call returns. The runner promotes a read-only snapshot into
 * session.json only after cleanup, and removes scratch only after receipt success.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "../core/experiment.ts";
import type { GuardedSecret, SecretRedaction } from "../core/secret-scan.ts";
import { redactSecrets, scanForSecrets } from "../core/secret-scan.ts";
import { EvalError, EVIDENCE_SCHEMA_VERSION } from "../core/types.ts";
import { sanitizeNativeSessionEntries, type NativeSessionEntry } from "../harnesses/pi/export-viewer.ts";

export const NATIVE_PREFIX_MAX_RECORD_BYTES = 1024 * 1024;
export const NATIVE_PREFIX_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const NATIVE_PREFIX_MAX_RECORDS = 10_000;

const NATIVE_ENTRY_TYPES = new Set([
  "session",
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "custom",
  "session_info",
  "custom_message",
  "label",
  "branch_summary",
]);

export interface NativeSessionEntryRecorder {
  /** Synchronous by design: success means the sanitized record and guest redaction provenance have been fsynced. */
  record(entry: NativeSessionEntry, guestRedactions?: { readonly count: number; readonly entries: readonly SecretRedaction[] }): void;
}

export interface NativePrefixSnapshot {
  readonly entries: readonly NativeSessionEntry[];
  readonly redactions: { readonly count: number; readonly entries: readonly SecretRedaction[] };
  readonly finished: boolean;
  readonly completed: boolean;
  readonly incompleteReason: string | null;
}

export interface NativeSessionCapture extends NativeSessionEntryRecorder {
  readonly path: string;
  snapshot(): NativePrefixSnapshot;
  finish(completed: boolean, incompleteReason: string | null): NativePrefixSnapshot;
  failure(): EvalError | null;
  removeAfterSeal(): void;
}

type RecordEnvelope = {
  schemaVersion: number;
  kind: "record";
  sequence: number;
  record: NativeSessionEntry;
  redactions: { count: number; entries: SecretRedaction[] };
};
type FinishEnvelope = {
  schemaVersion: number;
  kind: "finish";
  sequence: number;
  completed: boolean;
  incompleteReason: string | null;
};
type Envelope = RecordEnvelope | FinishEnvelope;

function evidenceInvalid(message: string, at: string, cause?: unknown): EvalError {
  return new EvalError("evidence-invalid", message, { at, ...(cause === undefined ? {} : { cause }) });
}

function validateNativeRecord(entry: unknown, at: string, entries: readonly NativeSessionEntry[]): NativeSessionEntry {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw evidenceInvalid(`${at} must be a native session object`, at);
  }
  const record = entry as NativeSessionEntry;
  if (typeof record.type !== "string" || !NATIVE_ENTRY_TYPES.has(record.type)) {
    throw evidenceInvalid(`${at} has an unknown Pi 0.85.0 entry type`, at);
  }
  if (record.type === "session") {
    if (entries.length !== 0 || typeof record.id !== "string" || record.id === "") {
      throw evidenceInvalid(`${at} must be the single initial native header`, at);
    }
    return record;
  }
  if (entries.length === 0 || entries[0]?.type !== "session") {
    throw evidenceInvalid(`${at} appears before the native session header`, at);
  }
  if (typeof record.id !== "string" || record.id === "") {
    throw evidenceInvalid(`${at}.id must be a non-empty string`, at);
  }
  if (entries.some((item) => item.id === record.id)) {
    throw evidenceInvalid(`${at}.id is duplicated`, at);
  }
  if (record.parentId !== null &&
      (typeof record.parentId !== "string" || !entries.some((item) => item.id === record.parentId))) {
    throw evidenceInvalid(`${at}.parentId must reference an earlier native entry or null`, at);
  }
  return record;
}

/** Read only complete, bounded JSONL records from one verified regular-file handle. */
export function readNativeSessionPrefix(path: string): NativePrefixSnapshot {
  let fd: number | null = null;
  let bytes: Buffer;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw evidenceInvalid("native prefix must be a singly-linked regular file", path);
    }
    if (stat.size > NATIVE_PREFIX_MAX_TOTAL_BYTES) {
      throw evidenceInvalid(`native prefix exceeds ${NATIVE_PREFIX_MAX_TOTAL_BYTES} bytes`, path);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= NATIVE_PREFIX_MAX_TOTAL_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, NATIVE_PREFIX_MAX_TOTAL_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    bytes = Buffer.concat(chunks, total);
  } catch (error: unknown) {
    if (error instanceof EvalError) throw error;
    throw evidenceInvalid("native prefix is not readable", path, error);
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* retain the original validation error */ }
    }
  }
  if (bytes.byteLength > NATIVE_PREFIX_MAX_TOTAL_BYTES) {
    throw evidenceInvalid(`native prefix exceeds ${NATIVE_PREFIX_MAX_TOTAL_BYTES} bytes`, path);
  }

  const text = bytes.toString("utf8");
  const entries: NativeSessionEntry[] = [];
  const redactions: SecretRedaction[] = [];
  let redactionCount = 0;
  let finished = false;
  let completed = false;
  let incompleteReason: string | null = "native capture was interrupted before it finished";
  let lineStart = 0;
  let lineNumber = 0;

  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    if (newline === -1) break; // An interrupted final record is not promoted.
    lineNumber += 1;
    if (lineNumber > NATIVE_PREFIX_MAX_RECORDS + 1) {
      throw evidenceInvalid(`native prefix exceeds ${NATIVE_PREFIX_MAX_RECORDS} records`, path);
    }
    const line = text.slice(lineStart, newline);
    lineStart = newline + 1;
    if (line.length === 0) throw evidenceInvalid(`native prefix line ${lineNumber} must be an envelope`, path);
    if (Buffer.byteLength(line) + 1 > NATIVE_PREFIX_MAX_RECORD_BYTES) {
      throw evidenceInvalid(`native prefix line ${lineNumber} exceeds the record bound`, path);
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error: unknown) {
      throw evidenceInvalid(`native prefix line ${lineNumber} is malformed JSON`, path, error);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw evidenceInvalid(`native prefix line ${lineNumber} must be an envelope`, path);
    }
    const envelope = value as Partial<Envelope>;
    if (envelope.schemaVersion !== EVIDENCE_SCHEMA_VERSION || envelope.sequence !== lineNumber) {
      throw evidenceInvalid(`native prefix line ${lineNumber} has invalid schema or sequence`, path);
    }
    if (finished) throw evidenceInvalid("native prefix contains records after its finish marker", path);
    if (envelope.kind === "record") {
      if (entries.length >= NATIVE_PREFIX_MAX_RECORDS) {
        throw evidenceInvalid(`native prefix exceeds ${NATIVE_PREFIX_MAX_RECORDS} records`, path);
      }
      const native = validateNativeRecord(envelope.record, `native prefix line ${lineNumber}.record`, entries);
      const metadata = envelope.redactions;
      if (!metadata || !Number.isSafeInteger(metadata.count) || metadata.count < 0 || !Array.isArray(metadata.entries)) {
        throw evidenceInvalid(`native prefix line ${lineNumber} has invalid redaction metadata`, path);
      }
      entries.push(native);
      redactionCount += metadata.count;
      redactions.push(...metadata.entries as SecretRedaction[]);
    } else if (envelope.kind === "finish") {
      if (typeof envelope.completed !== "boolean" ||
          !(envelope.incompleteReason === null || typeof envelope.incompleteReason === "string")) {
        throw evidenceInvalid(`native prefix line ${lineNumber} has invalid finish metadata`, path);
      }
      finished = true;
      completed = envelope.completed;
      incompleteReason = envelope.completed ? null : (envelope.incompleteReason ?? "native capture ended before completion");
    } else {
      throw evidenceInvalid(`native prefix line ${lineNumber} has unknown envelope kind`, path);
    }
  }
  if (finished && lineStart < text.length) {
    throw evidenceInvalid("native prefix has torn content after its finish marker", path);
  }
  return {
    entries: structuredClone(entries),
    redactions: { count: redactionCount, entries: structuredClone(redactions) },
    finished,
    completed,
    incompleteReason,
  };
}

export function createNativeSessionCapture(options: {
  readonly path: string;
  readonly guardedSecrets?: readonly GuardedSecret[];
  readonly captureReasoning?: boolean;
}): NativeSessionCapture {
  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(options.path, "ax", 0o600);
  } catch (error: unknown) {
    throw evidenceInvalid("native prefix scratch path is not creatable", options.path, error);
  }
  try {
    fchmodSync(fd, 0o600);
  } catch (error: unknown) {
    try { closeSync(fd); } catch { /* retain the permission failure */ }
    throw evidenceInvalid("native prefix scratch path is not creatable", options.path, error);
  }
  const secrets = options.guardedSecrets ?? [];
  let sequence = 0;
  let bytes = 0;
  let records = 0;
  const capturedEntries: NativeSessionEntry[] = [];
  let closed = false;
  let latched: EvalError | null = null;

  const closeCapture = (): void => {
    if (closed) return;
    closed = true;
    try { closeSync(fd); } catch { /* terminal capture failure remains authoritative */ }
  };

  const latch = (error: unknown): EvalError => {
    const safe = error instanceof EvalError
      ? error
      : evidenceInvalid("native prefix durable append failed", options.path, error);
    latched ??= safe;
    closeCapture();
    return latched;
  };

  const appendEnvelope = (envelope: Envelope): void => {
    const encodedEnvelope = canonicalJson(envelope, "native prefix envelope");
    const hits = scanForSecrets({ path: options.path, content: encodedEnvelope }, secrets);
    if (hits.length > 0) {
      throw new EvalError(
        "secret-quarantine",
        `native prefix envelope verification failed; secret needle survived sanitization (${hits[0]?.label ?? "unknown"}, ${hits[0]?.encoding ?? "raw"})`,
        { at: options.path },
      );
    }
    const line = `${encodedEnvelope}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (lineBytes > NATIVE_PREFIX_MAX_RECORD_BYTES) {
      throw evidenceInvalid(`native prefix record exceeds ${NATIVE_PREFIX_MAX_RECORD_BYTES} bytes`, options.path);
    }
    if (bytes + lineBytes > NATIVE_PREFIX_MAX_TOTAL_BYTES) {
      throw evidenceInvalid(`native prefix exceeds ${NATIVE_PREFIX_MAX_TOTAL_BYTES} bytes`, options.path);
    }
    try {
      const encoded = Buffer.from(line, "utf8");
      let offset = 0;
      while (offset < encoded.byteLength) {
        const written = writeSync(fd, encoded, offset, encoded.byteLength - offset);
        if (written <= 0) throw new Error("zero-byte native prefix write");
        offset += written;
      }
      fsyncSync(fd);
    } catch (error: unknown) {
      // A complete-looking line is not promotable unless its fsync succeeded. Restore
      // the last verified byte boundary best-effort before the terminal close.
      try {
        ftruncateSync(fd, bytes);
        fsyncSync(fd);
      } catch {
        // The original append failure remains authoritative; the reader still rejects
        // or omits any malformed suffix without deleting recovery evidence.
      }
      throw evidenceInvalid("native prefix durable append failed", options.path, error);
    }
    sequence += 1;
    bytes += lineBytes;
  };

  return {
    path: options.path,
    record(entry: NativeSessionEntry, guestRedactions = { count: 0, entries: [] }): void {
      if (latched) throw latched;
      if (closed) throw latch(evidenceInvalid("native prefix is already finished", options.path));
      try {
        if (records >= NATIVE_PREFIX_MAX_RECORDS) {
          throw evidenceInvalid(`native prefix exceeds ${NATIVE_PREFIX_MAX_RECORDS} records`, options.path);
        }
        if (!Number.isSafeInteger(guestRedactions.count) || guestRedactions.count < 0 || !Array.isArray(guestRedactions.entries) ||
            guestRedactions.entries.reduce((sum, item) => sum + (Number.isSafeInteger(item?.count) && item.count > 0 ? item.count : 0), 0) !== guestRedactions.count ||
            guestRedactions.entries.some((item) => typeof item?.path !== "string" || typeof item?.label !== "string" ||
              !["raw", "json-escaped", "percent-encoded", "base64", "base64url"].includes(item?.encoding) ||
              !Number.isSafeInteger(item?.count) || item.count <= 0)) {
          throw evidenceInvalid("native prefix record has invalid guest redaction provenance", options.path);
        }
        const sanitized = sanitizeNativeSessionEntries([entry], secrets, {
          captureReasoning: options.captureReasoning,
        });
        validateNativeRecord(sanitized.entries[0], "native prefix record", capturedEntries);
        const envelope: RecordEnvelope = {
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
          kind: "record",
          sequence: sequence + 1,
          record: sanitized.entries[0]!,
          redactions: {
            count: guestRedactions.count + sanitized.count,
            entries: [...guestRedactions.entries, ...sanitized.redactions],
          },
        };
        appendEnvelope(envelope);
        capturedEntries.push(sanitized.entries[0]!);
        records += 1;
      } catch (error: unknown) {
        throw latch(error);
      }
    },
    snapshot(): NativePrefixSnapshot {
      return readNativeSessionPrefix(options.path);
    },
    finish(completed: boolean, incompleteReason: string | null): NativePrefixSnapshot {
      if (latched) {
        closeCapture();
        return readNativeSessionPrefix(options.path);
      }
      if (!closed) {
        try {
          const safeReason = completed
            ? null
            : redactSecrets(incompleteReason ?? "native capture ended before completion", secrets, `${options.path}:finish`).text;
          appendEnvelope({
            schemaVersion: EVIDENCE_SCHEMA_VERSION,
            kind: "finish",
            sequence: sequence + 1,
            completed,
            incompleteReason: safeReason,
          });
          closeCapture();
        } catch (error: unknown) {
          throw latch(error);
        }
      }
      return readNativeSessionPrefix(options.path);
    },
    failure(): EvalError | null {
      return latched;
    },
    removeAfterSeal(): void {
      closeCapture();
      unlinkSync(options.path);
    },
  };
}
