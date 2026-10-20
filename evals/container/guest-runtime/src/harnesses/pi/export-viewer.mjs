/**
 * Native session sanitization and pinned HTML export.
 *
 * Implements the evidence and native-session contract:
 * - Sanitization changes COPIES ONLY, never the live messages used for the next model turn.
 * - Injected reasoning, thinking blocks and signatures are stripped from the copy.
 * - Secret markers/canaries are redacted from the copy using core secret-scan rules.
 * - Pinned HTML export operates on the sanitized inspection copy.
 * - Viewer creation changes no canonical input bytes and performs no model request.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { EvalError } from "../../core/types.mjs";
import { redactSecretBytes, redactSecrets, scanForSecrets } from "../../core/secret-scan.mjs";
/**
 * Recursively redacts secret values and removes private reasoning/signatures
 * across all fields, nested objects, and arrays.
 */
function deepSanitizeValue(val, secrets, at = "", collector) {
    if (typeof val === "string") {
        if (secrets.length === 0)
            return val;
        const res = redactSecrets(val, secrets, at);
        if (res.count > 0 && collector) {
            collector.push(...res.redactions);
        }
        return res.text;
    }
    if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
        if (secrets.length === 0)
            return val;
        const res = redactSecretBytes(val, secrets, at);
        if (res.count > 0 && collector) {
            collector.push(...res.redactions);
        }
        return res.bytes;
    }
    if (Array.isArray(val)) {
        const result = [];
        for (let i = 0; i < val.length; i++) {
            const item = val[i];
            // Strip thinking content blocks
            if (item && typeof item === "object" && item.type === "thinking") {
                continue;
            }
            result.push(deepSanitizeValue(item, secrets, `${at}[${i}]`, collector));
        }
        return result;
    }
    if (val && typeof val === "object") {
        const record = { ...val };
        // Strip signatures and reasoning fields
        delete record.thinkingSignature;
        delete record.signature;
        delete record.reasoning;
        for (const [key, value] of Object.entries(record)) {
            if (key === "thinking" || key === "thinkingSignature" || value === undefined) {
                delete record[key];
                continue;
            }
            const sanitizedChild = deepSanitizeValue(value, secrets, `${at}.${key}`, collector);
            if (sanitizedChild === undefined) {
                delete record[key];
            }
            else {
                record[key] = sanitizedChild;
            }
        }
        return record;
    }
    return val;
}
/**
 * Sanitizes native session entries by deep-copying each entry, stripping private reasoning
 * and signatures, and redacting secret markers across all covered encodings including
 * nested tool arguments, tool results, and metadata.
 *
 * GUARANTEE: Does NOT mutate the input entries array or any child objects within it.
 * Unverifiable redactions quarantine and throw EvalError("secret-quarantine", ...).
 */
export function sanitizeNativeSessionEntries(entries, secrets = []) {
    // Deep clone so live session objects remain completely untouched
    const cloned = structuredClone(entries);
    const sanitizedList = [];
    const redactionCollector = [];
    for (const entry of cloned) {
        const pathPrefix = `session:${entry.id ?? entry.type ?? "entry"}`;
        const sanitized = deepSanitizeValue(entry, secrets, pathPrefix, redactionCollector);
        // Host re-scan verification: real scanner check
        if (secrets.length > 0) {
            const serialized = JSON.stringify(sanitized);
            const hits = scanForSecrets({ path: pathPrefix, content: serialized }, secrets);
            if (hits.length > 0) {
                throw new EvalError("secret-quarantine", `unverifiable secret redaction in native session entry ${entry.id ?? entry.type}: secret needle survived sanitization (${hits[0]?.label ?? "unknown"}, ${hits[0]?.encoding ?? "raw"})`, { at: pathPrefix });
            }
        }
        sanitizedList.push(sanitized);
    }
    const totalCount = redactionCollector.reduce((sum, r) => sum + r.count, 0);
    const result = Object.assign([...sanitizedList], {
        entries: sanitizedList,
        count: totalCount,
        redactions: redactionCollector,
    });
    return result;
}
/**
 * Creates a sanitized JSONL copy from an existing session file.
 */
export function createSanitizedSessionCopy(inputSessionFile, outputSanitizedFile, secrets = []) {
    const content = readFileSync(inputSessionFile, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const entries = lines.map((l) => JSON.parse(l));
    const sanitized = sanitizeNativeSessionEntries(entries, secrets);
    const outputLines = sanitized.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(outputSanitizedFile, outputLines, "utf8");
}
let cachedExportFromFile;
async function getPinnedExportFromFile() {
    if (cachedExportFromFile) {
        return cachedExportFromFile;
    }
    const pkgDir = getPackageDir();
    const exportHtmlPath = join(pkgDir, "dist", "core", "export-html", "index.js");
    const mod = await import(pathToFileURL(exportHtmlPath).href);
    cachedExportFromFile = mod.exportFromFile;
    return cachedExportFromFile;
}
/**
 * Exports a session file (typically a sanitized inspection copy) to HTML using the pinned exporter.
 */
export async function exportSessionFileToHtml(sessionFilePath, outputHtmlPath) {
    const exportFromFile = await getPinnedExportFromFile();
    return await exportFromFile(sessionFilePath, outputHtmlPath ? { outputPath: outputHtmlPath } : undefined);
}
/**
 * Verifies that exported HTML contains NO disallowed secrets, NO reasoning, and NO signatures.
 */
export function verifyExportedHtml(htmlPath, options = {}) {
    const html = readFileSync(htmlPath, "utf8");
    const violations = [];
    // Extract embedded session data
    const match = html.match(/<script id="session-data"[^>]*>([\s\S]*?)<\/script>/);
    let decodedSession;
    let sessionJsonString = "";
    if (match && match[1]) {
        try {
            sessionJsonString = Buffer.from(match[1].trim(), "base64").toString("utf8");
            decodedSession = JSON.parse(sessionJsonString);
        }
        catch (e) {
            violations.push(`Failed to decode embedded session data: ${e}`);
        }
    }
    else {
        violations.push("No session-data script block found in exported HTML");
    }
    // Check for disallowed secret values in both the raw HTML and the decoded payload
    for (const secret of options.disallowedSecrets ?? []) {
        if (html.includes(secret)) {
            violations.push(`Raw HTML contains disallowed secret: '${secret}'`);
        }
        if (sessionJsonString.includes(secret)) {
            violations.push(`Embedded session JSON contains disallowed secret: '${secret}'`);
        }
    }
    // Check for disallowed reasoning tokens
    for (const token of options.disallowedReasoningTokens ?? []) {
        if (html.includes(token)) {
            violations.push(`Raw HTML contains disallowed reasoning token: '${token}'`);
        }
        if (sessionJsonString.includes(token)) {
            violations.push(`Embedded session JSON contains disallowed reasoning token: '${token}'`);
        }
    }
    return {
        valid: violations.length === 0,
        violations,
        decodedSessionJson: decodedSession,
    };
}
