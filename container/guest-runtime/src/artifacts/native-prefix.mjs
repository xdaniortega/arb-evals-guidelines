/** Crash-recoverable, sanitized Pi-native session prefixes.
 *
 * Scratch captures are deliberately outside a run's immutable evidence tree. Each
 * completed native record is sanitized, canonically encoded, appended, and fsynced
 * before the SDK append call returns. The runner promotes a read-only snapshot into
 * session.json only after cleanup, and removes scratch only after receipt success.
 */
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readSync, unlinkSync, writeSync, } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "../core/experiment.mjs";
import { redactSecrets, scanForSecrets } from "../core/secret-scan.mjs";
import { EvalError, EVIDENCE_SCHEMA_VERSION } from "../core/types.mjs";
import { sanitizeNativeSessionEntries } from "../harnesses/pi/export-viewer.mjs";
export const NATIVE_PREFIX_MAX_RECORD_BYTES = 1024 * 1024;
export const NATIVE_PREFIX_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const NATIVE_PREFIX_MAX_RECORDS = 10_000;
const NATIVE_ENTRY_TYPES = new Set([
    "session",
    "message",
    "thinking_level_change",
    "model_change",
    "usage",
    "compaction",
    "custom",
    "session_info",
    "custom_message",
    "context_edit",
    "label",
    "branch_summary",
]);
function evidenceInvalid(message, at, cause) {
    return new EvalError("evidence-invalid", message, { at, ...(cause === undefined ? {} : { cause }) });
}
function validateNativeRecord(entry, at, entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw evidenceInvalid(`${at} must be a native session object`, at);
    }
    const record = entry;
    if (typeof record.type !== "string" || !NATIVE_ENTRY_TYPES.has(record.type)) {
        throw evidenceInvalid(`${at} has an unknown Pi native entry type`, at);
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
export function readNativeSessionPrefix(path) {
    let fd = null;
    let bytes;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) {
            throw evidenceInvalid("native prefix must be a singly-linked regular file", path);
        }
        if (stat.size > NATIVE_PREFIX_MAX_TOTAL_BYTES) {
            throw evidenceInvalid(`native prefix exceeds ${NATIVE_PREFIX_MAX_TOTAL_BYTES} bytes`, path);
        }
        const chunks = [];
        let total = 0;
        while (total <= NATIVE_PREFIX_MAX_TOTAL_BYTES) {
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, NATIVE_PREFIX_MAX_TOTAL_BYTES + 1 - total));
            const count = readSync(fd, chunk, 0, chunk.byteLength, null);
            if (count === 0)
                break;
            chunks.push(chunk.subarray(0, count));
            total += count;
        }
        bytes = Buffer.concat(chunks, total);
    }
    catch (error) {
        if (error instanceof EvalError)
            throw error;
        throw evidenceInvalid("native prefix is not readable", path, error);
    }
    finally {
        if (fd !== null) {
            try {
                closeSync(fd);
            }
            catch { /* retain the original validation error */ }
        }
    }
    if (bytes.byteLength > NATIVE_PREFIX_MAX_TOTAL_BYTES) {
        throw evidenceInvalid(`native prefix exceeds ${NATIVE_PREFIX_MAX_TOTAL_BYTES} bytes`, path);
    }
    const text = bytes.toString("utf8");
    const entries = [];
    const redactions = [];
    let redactionCount = 0;
    let finished = false;
    let completed = false;
    let incompleteReason = "native capture was interrupted before it finished";
    let lineStart = 0;
    let lineNumber = 0;
    while (lineStart < text.length) {
        const newline = text.indexOf("\n", lineStart);
        if (newline === -1)
            break; // An interrupted final record is not promoted.
        lineNumber += 1;
        if (lineNumber > NATIVE_PREFIX_MAX_RECORDS + 1) {
            throw evidenceInvalid(`native prefix exceeds ${NATIVE_PREFIX_MAX_RECORDS} records`, path);
        }
        const line = text.slice(lineStart, newline);
        lineStart = newline + 1;
        if (line.length === 0)
            throw evidenceInvalid(`native prefix line ${lineNumber} must be an envelope`, path);
        if (Buffer.byteLength(line) + 1 > NATIVE_PREFIX_MAX_RECORD_BYTES) {
            throw evidenceInvalid(`native prefix line ${lineNumber} exceeds the record bound`, path);
        }
        let value;
        try {
            value = JSON.parse(line);
        }
        catch (error) {
            throw evidenceInvalid(`native prefix line ${lineNumber} is malformed JSON`, path, error);
        }
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw evidenceInvalid(`native prefix line ${lineNumber} must be an envelope`, path);
        }
        const envelope = value;
        if (envelope.schemaVersion !== EVIDENCE_SCHEMA_VERSION || envelope.sequence !== lineNumber) {
            throw evidenceInvalid(`native prefix line ${lineNumber} has invalid schema or sequence`, path);
        }
        if (finished)
            throw evidenceInvalid("native prefix contains records after its finish marker", path);
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
            redactions.push(...metadata.entries);
        }
        else if (envelope.kind === "finish") {
            if (typeof envelope.completed !== "boolean" ||
                !(envelope.incompleteReason === null || typeof envelope.incompleteReason === "string")) {
                throw evidenceInvalid(`native prefix line ${lineNumber} has invalid finish metadata`, path);
            }
            finished = true;
            completed = envelope.completed;
            incompleteReason = envelope.completed ? null : (envelope.incompleteReason ?? "native capture ended before completion");
        }
        else {
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
export function createNativeSessionCapture(options) {
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    let fd;
    try {
        fd = openSync(options.path, "ax", 0o600);
    }
    catch (error) {
        throw evidenceInvalid("native prefix scratch path is not creatable", options.path, error);
    }
    try {
        fchmodSync(fd, 0o600);
    }
    catch (error) {
        try {
            closeSync(fd);
        }
        catch { /* retain the permission failure */ }
        throw evidenceInvalid("native prefix scratch path is not creatable", options.path, error);
    }
    const secrets = options.guardedSecrets ?? [];
    let sequence = 0;
    let bytes = 0;
    let records = 0;
    const capturedEntries = [];
    let closed = false;
    let latched = null;
    const closeCapture = () => {
        if (closed)
            return;
        closed = true;
        try {
            closeSync(fd);
        }
        catch { /* terminal capture failure remains authoritative */ }
    };
    const latch = (error) => {
        const safe = error instanceof EvalError
            ? error
            : evidenceInvalid("native prefix durable append failed", options.path, error);
        latched ??= safe;
        closeCapture();
        return latched;
    };
    const appendEnvelope = (envelope) => {
        const encodedEnvelope = canonicalJson(envelope, "native prefix envelope");
        const hits = scanForSecrets({ path: options.path, content: encodedEnvelope }, secrets);
        if (hits.length > 0) {
            throw new EvalError("secret-quarantine", `native prefix envelope verification failed; secret needle survived sanitization (${hits[0]?.label ?? "unknown"}, ${hits[0]?.encoding ?? "raw"})`, { at: options.path });
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
                if (written <= 0)
                    throw new Error("zero-byte native prefix write");
                offset += written;
            }
            fsyncSync(fd);
        }
        catch (error) {
            // A complete-looking line is not promotable unless its fsync succeeded. Restore
            // the last verified byte boundary best-effort before the terminal close.
            try {
                ftruncateSync(fd, bytes);
                fsyncSync(fd);
            }
            catch {
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
        record(entry, guestRedactions = { count: 0, entries: [] }) {
            if (latched)
                throw latched;
            if (closed)
                throw latch(evidenceInvalid("native prefix is already finished", options.path));
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
                const envelope = {
                    schemaVersion: EVIDENCE_SCHEMA_VERSION,
                    kind: "record",
                    sequence: sequence + 1,
                    record: sanitized.entries[0],
                    redactions: {
                        count: guestRedactions.count + sanitized.count,
                        entries: [...guestRedactions.entries, ...sanitized.redactions],
                    },
                };
                appendEnvelope(envelope);
                capturedEntries.push(sanitized.entries[0]);
                records += 1;
            }
            catch (error) {
                throw latch(error);
            }
        },
        snapshot() {
            return readNativeSessionPrefix(options.path);
        },
        finish(completed, incompleteReason) {
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
                }
                catch (error) {
                    throw latch(error);
                }
            }
            return readNativeSessionPrefix(options.path);
        },
        failure() {
            return latched;
        },
        removeAfterSeal() {
            closeCapture();
            unlinkSync(options.path);
        },
    };
}
