/**
 * Pure experiment semantics: path safety, canonical serialization, hashing, limit
 * resolution, the fixed condition tuple, parity enforcement, scheduling, and delta
 * validity. No filesystem, process, container, provider, or case-specific behavior.
 */
import { createHash } from "node:crypto";
import { CONDITION_IDS, EvalError, LIMIT_KEYS, RUNTIME_PROFILES, SAFE_DEFAULT_LIMITS, SCHEMA_VERSION, } from "./types.mjs";
// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------
/**
 * A path segment must start with an alphanumeric character, which deliberately
 * excludes dotfiles (`.git`, `.gitignore`, `.env`, `.DS_Store`, editor state) from
 * every frozen input.
 *
 * This is a policy decision, not an oversight. Frozen inputs are staged verbatim into
 * a guest and hashed into the evidence chain, so the set of files that can enter must
 * be conservative and boring: dotfiles are where credentials, VCS metadata, tool
 * caches, and host-specific configuration live, they are easy to add accidentally, and
 * none of them is ever task-relevant fixture or skill content. Excluding them at the
 * pattern keeps a stray `.env` in a skill directory from being copied into the
 * treatment guest, and keeps fixture hashes stable across machines that sprinkle
 * `.DS_Store` around. Rejection is loud (`path-unsafe`) rather than a silent skip so a
 * case author learns immediately that the file will never be measured.
 */
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MAX_RELATIVE_PATH_LENGTH = 200;
/**
 * Accepts only a bounded, relative, forward-slash path built from conservative
 * segments. Absolute paths, traversal, empty segments, and shell- or Windows-hostile
 * spellings are rejected before any path is joined to a root.
 */
export function assertSafeRelativePath(candidate, at) {
    if (typeof candidate !== "string" || candidate === "") {
        throw new EvalError("path-unsafe", `${at} must be a non-empty relative path`, { at });
    }
    if (candidate.length > MAX_RELATIVE_PATH_LENGTH) {
        throw new EvalError("path-unsafe", `${at} exceeds ${MAX_RELATIVE_PATH_LENGTH} characters`, { at });
    }
    if (candidate.includes("\0") || candidate.includes("\\")) {
        throw new EvalError("path-unsafe", `${at} contains a forbidden character`, { at });
    }
    if (candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate)) {
        throw new EvalError("path-unsafe", `${at} must not be absolute`, { at });
    }
    if (candidate.endsWith("/")) {
        throw new EvalError("path-unsafe", `${at} must not end with a separator`, { at });
    }
    const segments = candidate.split("/");
    for (const segment of segments) {
        if (segment === "" || segment === "." || segment === "..") {
            throw new EvalError("path-unsafe", `${at} contains an empty or traversing segment`, { at });
        }
        if (!PATH_SEGMENT_PATTERN.test(segment)) {
            throw new EvalError("path-unsafe", `${at} contains an unsupported segment: ${segment}`, { at });
        }
    }
    return segments.join("/");
}
/** A case selector is a relative directory path such as `chain-info/network-config-01`. */
export function assertSafeSelector(candidate, at) {
    return assertSafeRelativePath(candidate, at);
}
/**
 * Deterministic JSON with sorted object keys.
 *
 * Accepts only values that round-trip exactly: `null`, booleans, finite numbers,
 * strings, arrays, and plain objects (prototype `Object.prototype` or `null`).
 * Everything else is rejected as `evidence-invalid`, naming the offending path:
 *
 * - `undefined` is rejected **everywhere it is reachable**, including as an object
 *   property value. Dropping such keys silently would let two structurally different
 *   records hash identically, so callers must be explicit and write `null`.
 * - Non-finite numbers, functions, symbols, and bigints are rejected.
 * - Non-plain objects (`Date`, `Map`, `Set`, `RegExp`, `Buffer`, class instances) are
 *   rejected, because their own enumerable keys are usually empty and they would
 *   serialize to a misleading `{}`.
 * - Any value carrying a `toJSON` method is rejected, because the canonical form must
 *   be decided here rather than by the value itself.
 */
export function canonicalJson(value, at = "value") {
    return serializeCanonical(value, at);
}
function serializeCanonical(value, at) {
    if (value === null)
        return "null";
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new EvalError("evidence-invalid", `${at} must be a finite number`, { at });
        }
        return JSON.stringify(value);
    }
    if (typeof value === "string")
        return JSON.stringify(value);
    if (typeof value === "object") {
        assertNoToJson(value, at);
        if (Array.isArray(value)) {
            return `[${value.map((entry, index) => serializeCanonical(entry, `${at}[${index}]`)).join(",")}]`;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new EvalError("evidence-invalid", `${at} must be a plain object; ${describeConstructor(value)} cannot be canonically serialized`, { at });
        }
        const record = value;
        const keys = Object.keys(record).sort();
        const body = keys
            .map((key) => `${JSON.stringify(key)}:${serializeCanonical(record[key], `${at}.${key}`)}`)
            .join(",");
        return `{${body}}`;
    }
    if (value === undefined) {
        throw new EvalError("evidence-invalid", `${at} must not be undefined; use null`, { at });
    }
    throw new EvalError("evidence-invalid", `${at} is not serializable as canonical JSON`, { at });
}
function assertNoToJson(value, at) {
    if (typeof value.toJSON === "function") {
        throw new EvalError("evidence-invalid", `${at} exposes toJSON(); canonical form must be decided by the caller`, { at });
    }
}
function describeConstructor(value) {
    const name = value.constructor?.name;
    return typeof name === "string" && name !== "" ? name : "a non-plain object";
}
export function sha256Hex(data) {
    return createHash("sha256").update(data).digest("hex");
}
export function canonicalJsonSha256(value) {
    return sha256Hex(canonicalJson(value));
}
/** Content hash over a sorted file tree. Duplicate paths are an evidence defect. */
export function buildManifestTree(entries, schemaVersion = SCHEMA_VERSION) {
    const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    for (let index = 1; index < sorted.length; index += 1) {
        if (sorted[index]?.path === sorted[index - 1]?.path) {
            throw new EvalError("evidence-invalid", `manifest contains a duplicate path: ${sorted[index]?.path}`);
        }
    }
    return {
        schemaVersion,
        entries: sorted,
        treeSha256: canonicalJsonSha256({ schemaVersion, entries: sorted }),
    };
}
/**
 * @notice Resolves execution resource limits and records their provenance by layering cascading configuration tiers.
 * @param input Cascading limit sources including CLI flags, case settings, suite defaults, and runtime profiles.
 * @returns Complete limits configuration alongside the provenance tier recorded for each resolved limit key.
 * @dev Precedence order is strictly CLI > case > suite > profile > safe default, resolved once and then frozen. Each resolved value must be a positive safe integer.
 */
export function resolveLimits(input) {
    const catalog = input.profileCatalog ?? RUNTIME_PROFILES;
    const profile = catalog[input.runtimeProfileId];
    if (profile === undefined) {
        throw new EvalError("input-invalid", `unknown runtime profile: ${input.runtimeProfileId}`);
    }
    const limits = {};
    const provenance = {};
    for (const key of LIMIT_KEYS) {
        const layers = [
            ["cli", input.cli[key]],
            ["case", input.caseLimits[key]],
            ["suite", input.suiteLimits[key]],
            ["profile", profile.limits[key]],
            ["default", SAFE_DEFAULT_LIMITS[key]],
        ];
        const chosen = layers.find(([, value]) => value !== undefined);
        if (chosen === undefined || chosen[1] === undefined) {
            throw new EvalError("limit-invalid", `limit ${key} did not resolve`, { at: key });
        }
        if (!Number.isSafeInteger(chosen[1]) || chosen[1] <= 0) {
            throw new EvalError("limit-invalid", `limit ${key} must be a positive safe integer`, { at: key });
        }
        limits[key] = chosen[1];
        provenance[key] = chosen[0];
    }
    return {
        limits: limits,
        provenance: provenance,
    };
}
/**
 * Every key of ParityBinding, enumerated explicitly so parity enforcement is total.
 *
 * assertParity asserts that each condition's binding has exactly this key set. Adding a
 * field to ParityBinding without adding it here is a compile error (the array is typed
 * as covering every key), and adding it here without populating it is a runtime parity
 * violation. A new field therefore cannot silently escape comparison.
 */
export const PARITY_FIELDS = [
    "promptSha256",
    "fixtureTreeSha256",
    "outputPath",
    "oracleSha256",
    "validatorSha256",
    "validatorClosureSha256",
    "allowedTools",
    "harnessId",
    "sandboxId",
    "validatorRunnerId",
    "runtimeProfileId",
    "imageDigest",
    "target",
    "limits",
    "networkPolicySha256",
    "guestPolicySha256",
    "workspaceRoot",
    "executionPolicySha256",
    "caseId",
    "caseVersion",
    "skillSnapshotTreeSha256",
    "skillToolBundleSha256",
    "candidateMode",
];
const _parityFieldsAreExhaustive = [];
void _parityFieldsAreExhaustive;
/**
 * The fixed two-item condition tuple. Baseline gets zero skill paths; treatment gets
 * exactly one. Nothing else may differ.
 */
export function buildConditionPlans(parity, skillGuestPath) {
    const guestPath = requireAbsoluteGuestPath(skillGuestPath, "skillGuestPath");
    if (typeof parity.imageDigest !== "string" || parity.imageDigest === "") {
        throw new EvalError("parity-violation", "parity.imageDigest must be a non-empty string: both arms must run from one inspected image digest", { at: "parity.imageDigest" });
    }
    return [
        { conditionId: "baseline", skillPaths: [], parity },
        { conditionId: "treatment", skillPaths: [guestPath], parity },
    ];
}
export function requireAbsoluteGuestPath(candidate, at) {
    if (!candidate.startsWith("/") || candidate.includes("..") || candidate.includes("\0")) {
        throw new EvalError("path-unsafe", `${at} must be a plain absolute guest path`, { at });
    }
    return candidate;
}
export function buildRunPlan(input) {
    if (!Number.isSafeInteger(input.repetitions) || input.repetitions <= 0) {
        throw new EvalError("input-invalid", "repetitions must be a positive safe integer", { at: "repetitions" });
    }
    if (input.armOrder.length !== CONDITION_IDS.length || new Set(input.armOrder).size !== CONDITION_IDS.length) {
        throw new EvalError("input-invalid", "armOrder must contain each condition exactly once", { at: "armOrder" });
    }
    for (const conditionId of input.armOrder) {
        if (!CONDITION_IDS.includes(conditionId)) {
            throw new EvalError("input-invalid", `armOrder contains an unknown condition: ${conditionId}`, { at: "armOrder" });
        }
    }
    assertResourceNonce(input.resourceNonce, "resourceNonce");
    const conditions = buildConditionPlans(input.parity, input.skillGuestPath);
    assertParity(conditions);
    if (conditions[1].skillPaths[0] !== input.skillGuestPath) {
        throw new EvalError("parity-violation", "the treatment skill path must be exactly the plan's skillGuestPath", { at: "skillGuestPath" });
    }
    const schedule = buildSchedule(input);
    const plan = {
        ...input,
        schemaVersion: SCHEMA_VERSION,
        conditions,
        schedule,
        planSha256: "",
    };
    const { planSha256: _ignored, ...hashable } = plan;
    return { ...plan, planSha256: canonicalJsonSha256(hashable) };
}
/**
 * @notice Enforces identical configuration between baseline and treatment condition plans except for evaluated skill presence.
 * @param conditions Ordered pair of baseline and treatment condition plans.
 * @dev The two bindings are compared field by field across PARITY_FIELDS rather than by hashing the complete object, allowing errors to pinpoint the exact divergent field when condition plans are independently constructed. Baseline must have zero skill paths and treatment exactly one.
 */
export function assertParity(conditions) {
    const [baseline, treatment] = conditions;
    if (baseline.conditionId !== "baseline" || treatment.conditionId !== "treatment") {
        throw new EvalError("parity-violation", "conditions must be exactly [baseline, treatment] in order");
    }
    assertParityKeySet(baseline);
    assertParityKeySet(treatment);
    for (const field of PARITY_FIELDS) {
        const left = canonicalJson(baseline.parity[field], `baseline.parity.${field}`);
        const right = canonicalJson(treatment.parity[field], `treatment.parity.${field}`);
        if (left !== right) {
            throw new EvalError("parity-violation", `baseline and treatment parity bindings differ at ${field}`, { at: `parity.${field}` });
        }
    }
    if (baseline.skillPaths.length !== 0) {
        throw new EvalError("parity-violation", "baseline must receive zero skill paths");
    }
    if (treatment.skillPaths.length !== 1) {
        throw new EvalError("parity-violation", "treatment must receive exactly one skill path");
    }
}
/** A binding with a missing or extra field is a parity violation, not a type error. */
function assertParityKeySet(condition) {
    const present = new Set(Object.keys(condition.parity));
    const missing = PARITY_FIELDS.filter((field) => !present.has(field));
    const extra = [...present].filter((key) => !PARITY_FIELDS.includes(key)).sort();
    if (missing.length > 0) {
        throw new EvalError("parity-violation", `${condition.conditionId} parity binding is missing field(s): ${missing.join(", ")}`, { at: `${condition.conditionId}.parity` });
    }
    if (extra.length > 0) {
        throw new EvalError("parity-violation", `${condition.conditionId} parity binding has unchecked field(s): ${extra.join(", ")}`, { at: `${condition.conditionId}.parity` });
    }
}
export function buildSchedule(input) {
    const steps = [];
    let order = 0;
    for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
        const pairId = pairIdFor(input.runId, repetition);
        for (const conditionId of input.armOrder) {
            order += 1;
            steps.push({
                order,
                repetition,
                pairId,
                conditionId,
                guestName: resourceNameFor("guest", input, repetition, conditionId),
                networkName: resourceNameFor("net", input, repetition, conditionId),
            });
        }
    }
    return steps;
}
export function pairIdFor(runId, repetition) {
    return `${runId}-r${String(repetition).padStart(3, "0")}`;
}
/**
 * A resource nonce is validated at the boundary with the same lowercase-hex rule as a
 * run nonce, and bounded so the derived name cannot overflow the 63-character limit.
 *
 * Upper bound: `eval-<kind>-<runId>-rNNN-<conditionId>-<nonce>` where runId contributes
 * at most 24 characters after normalization and `treatment` is the longest condition id,
 * leaving 12 characters of headroom for the nonce.
 */
const RESOURCE_NONCE_PATTERN = /^[0-9a-f]{4,12}$/;
export function assertResourceNonce(candidate, at) {
    if (typeof candidate !== "string" || !RESOURCE_NONCE_PATTERN.test(candidate)) {
        throw new EvalError("input-invalid", `${at} must be 4-12 lowercase hex characters`, { at });
    }
    return candidate;
}
/** Exact, journalable, bounded resource names. Never scanned for by pattern. */
export function resourceNameFor(kind, input, repetition, conditionId) {
    const name = [
        "eval",
        kind,
        input.runId.toLowerCase().replace(/[^a-z0-9]/g, ""),
        `r${String(repetition).padStart(3, "0")}`,
        conditionId,
        assertResourceNonce(input.resourceNonce, "resourceNonce"),
    ].join("-");
    // Defence in depth: the nonce is already validated, so a failure here means the runId
    // or repetition contributed something unusable.
    if (name.length > 63 || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        throw new EvalError("input-invalid", `derived resource name is not usable: ${name}`);
    }
    return name;
}
export function runIdFor(now, nonce) {
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    if (!/^[0-9a-f]{8,16}$/.test(nonce)) {
        throw new EvalError("input-invalid", "run nonce must be 8-16 lowercase hex characters");
    }
    return `${stamp}-${nonce}`;
}
/**
 * @notice Computes comparative score differentials between baseline and treatment evaluation arm outcomes.
 * @param baseline Validation grade and gradeability status for the baseline arm.
 * @param treatment Validation grade and gradeability status for the treatment arm.
 * @returns Score delta representing treatment minus baseline when both arms are graded, or null with a diagnostic reason.
 * @dev A delta is calculated only when both arms are gradeable and report valid numerical scores; otherwise delta is null.
 */
export function computePairDelta(baseline, treatment) {
    const ungradeable = [baseline, treatment].filter((grade) => !grade.gradeable || grade.validation === null || grade.validation.status !== "graded" ||
        typeof grade.validation.score !== "number");
    if (ungradeable.length > 0) {
        return {
            gradeable: false,
            delta: null,
            reason: `not gradeable: ${ungradeable.map((grade) => grade.conditionId).join(", ")}`,
        };
    }
    const baselineScore = baseline.validation?.score ?? 0;
    const treatmentScore = treatment.validation?.score ?? 0;
    return { gradeable: true, delta: treatmentScore - baselineScore, reason: "both conditions graded" };
}
