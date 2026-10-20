/**
 * Verified, strictly read-only views over sealed evidence.
 *
 * Nothing in this module writes, moves, repairs, or regenerates anything. A report that
 * could quietly fix the evidence it is reporting on would be worthless, so verification
 * recomputes every file hash from disk, rebuilds the manifest tree, and compares it to
 * the sealed manifest and to the hash the receipt references. When they disagree it names
 * exactly which files are missing, extra, or altered rather than reporting a bare
 * mismatch, because "the chain is broken" is not actionable and "pairs/<id>/treatment/
 * candidate.json was altered" is.
 *
 * `views/` and `recovery/` are excluded from verification: views are regenerable and not
 * authoritative, and recovery records are appended after sealing and are separately
 * sealed, so counting either as evidence drift would be a false alarm.
 *
 * A delta is only ever surfaced through `computePairDelta`, so a read model cannot invent
 * one for a pair where an arm was not gradeable.
 */

import { link, lstat, mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertSafeRelativePath,
  buildManifestTree,
  canonicalJson,
  canonicalJsonSha256,
  computePairDelta,
  sha256Hex,
} from "../core/experiment.ts";
import type { ConditionGrade, ManifestEntry, PairDelta, Target } from "../core/experiment.ts";
import { EvalError } from "../core/types.ts";
import type { CandidateMode, ConditionId, StructuredFailure, ValidationOutcome } from "../core/types.ts";
import type { NormalizedMessage, NormalizedToolStep } from "../harnesses/harness.ts";
import { MANIFEST_FILE, RECEIPT_FILE, VIEWS_DIR, isChainExcludedPath } from "./store.ts";
import { exportSessionFileToHtml } from "../harnesses/pi/export-viewer.ts";

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifyRunReport {
  readonly ok: boolean;
  readonly runDir: string;
  readonly receiptManifestSha256: string | null;
  readonly sealedTreeSha256: string | null;
  readonly recomputedTreeSha256: string | null;
  readonly manifestFileSha256: string | null;
  readonly receiptManifestFileSha256: string | null;
  /** Named in the manifest but not present on disk. */
  readonly missing: readonly string[];
  /** Present on disk inside the chain scope but absent from the manifest. */
  readonly extra: readonly string[];
  /** Present in both but with different bytes. */
  readonly altered: readonly string[];
  /** How the receipt population was established without trusting receipt.pairs. */
  readonly populationIntegrity: {
    readonly source: "frozen-plan" | "sealed-pair-records" | "pre-plan-failure";
    readonly ordering: "verified" | "unavailable-schema-v1" | "not-applicable-empty";
  } | null;
  readonly failures: readonly StructuredFailure[];
}

function canonicalRunDir(receiptOrRunDir: string): string {
  const absolute = resolve(receiptOrRunDir);
  if (absolute.endsWith(".json")) {
    if (basename(absolute) !== RECEIPT_FILE) {
      throw new EvalError("evidence-invalid", `only the canonical ${RECEIPT_FILE} may identify a run`, { at: absolute });
    }
    return dirname(absolute);
  }
  return absolute;
}

async function readJsonFile(path: string, at: string): Promise<unknown> {
  const raw = await readFile(path, "utf8").catch((cause: unknown) => {
    throw new EvalError("evidence-invalid", `${at} is not readable: ${path}`, { at, cause });
  });
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause: unknown) {
    throw new EvalError("evidence-invalid", `${at} is not valid JSON: ${path}`, { at, cause });
  }
}

/** Walks the chained portion of a run directory. Refuses to follow any symlink. */
async function walkChainFiles(runDir: string, excludeDerived = true): Promise<ReadonlyMap<string, { sha256: string; bytes: number }>> {
  const found = new Map<string, { sha256: string; bytes: number }>();

  const walk = async (relative: readonly string[]): Promise<void> => {
    const dir = relative.length === 0 ? runDir : join(runDir, ...relative);
    const entries = await readdir(dir, { withFileTypes: true }).catch((cause: unknown) => {
      throw new EvalError("evidence-invalid", `run directory is not readable: ${dir}`, { at: dir, cause });
    });
    for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const relativePath = [...relative, entry.name].join("/");
      if (excludeDerived && isChainExcludedPath(relativePath)) continue;
      if (entry.isSymbolicLink()) {
        throw new EvalError(
          "evidence-invalid",
          `run directory contains a symlink, which is never created by the store: ${relativePath}`,
          { at: relativePath },
        );
      }
      if (entry.isDirectory()) {
        await walk([...relative, entry.name]);
        continue;
      }
      if (!entry.isFile()) {
        throw new EvalError("evidence-invalid", `run directory contains a non-regular file: ${relativePath}`, {
          at: relativePath,
        });
      }
      const bytes = await readFile(join(dir, entry.name));
      found.set(relativePath, { sha256: sha256Hex(bytes), bytes: bytes.byteLength });
    }
  };

  await walk([]);
  return found;
}

/**
 * @notice Validates cryptographic integrity of a sealed run by recomputing manifest file hashes, tree hashes, and population counts from disk.
 * @param runDir Path to the sealed run directory to verify.
 * @returns Detailed report recording recomputed hash matches, missing or altered files, population integrity, and collected failures.
 * @dev Recomputes the entire hash chain from disk without mutating files. Failures are collected rather than thrown wherever the answer remains meaningful, so one corrupted file does not conceal remaining discrepancies; only an unreadable run directory, manifest, or receipt aborts early.
 */
export async function verifyRun(runDir: string): Promise<VerifyRunReport> {
  const absoluteRunDir = resolve(runDir);
  const failures: StructuredFailure[] = [];
  const empty: VerifyRunReport = {
    ok: false,
    runDir: absoluteRunDir,
    receiptManifestSha256: null,
    sealedTreeSha256: null,
    recomputedTreeSha256: null,
    manifestFileSha256: null,
    receiptManifestFileSha256: null,
    missing: [],
    extra: [],
    altered: [],
    populationIntegrity: null,
    failures,
  };

  let manifestBytes: Buffer;
  let receipt: RunReceipt;
  let sealedEntries: readonly ManifestEntry[];
  let sealedTreeSha256: string;
  let manifestSchemaVersion = 1;
  try {
    manifestBytes = await readFile(join(absoluteRunDir, MANIFEST_FILE)).catch((cause: unknown) => {
      throw new EvalError("evidence-invalid", `${MANIFEST_FILE} is missing or unreadable`, {
        at: MANIFEST_FILE,
        cause,
      });
    });
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      schemaVersion?: unknown;
      entries?: unknown;
      treeSha256?: unknown;
    };
    if (!Array.isArray(manifest.entries) || typeof manifest.treeSha256 !== "string") {
      throw new EvalError("evidence-invalid", `${MANIFEST_FILE} is not a manifest tree`, { at: MANIFEST_FILE });
    }
    manifestSchemaVersion = typeof manifest.schemaVersion === "number" ? manifest.schemaVersion : 1;
    sealedEntries = manifest.entries as readonly ManifestEntry[];
    sealedTreeSha256 = manifest.treeSha256;
    receipt = decodeReceipt(await readJsonFile(join(absoluteRunDir, RECEIPT_FILE), RECEIPT_FILE));
    if (receipt.schemaVersion !== manifestSchemaVersion) {
      throw new EvalError("evidence-invalid", "receipt schemaVersion does not match the sealed manifest", { at: "receipt.json.schemaVersion" });
    }
  } catch (error: unknown) {
    failures.push(
      error instanceof EvalError
        ? error.toStructured()
        : { code: "evidence-invalid", failureClass: "infrastructure", message: String(error), at: null },
    );
    return empty;
  }

  const manifestFileSha256 = sha256Hex(manifestBytes);
  let onDisk: ReadonlyMap<string, { sha256: string; bytes: number }>;
  try {
    onDisk = await walkChainFiles(absoluteRunDir);
  } catch (error: unknown) {
    failures.push(
      error instanceof EvalError
        ? error.toStructured()
        : { code: "evidence-invalid", failureClass: "infrastructure", message: String(error), at: null },
    );
    return { ...empty, manifestFileSha256, sealedTreeSha256, receiptManifestSha256: receipt.manifest.treeSha256 };
  }

  const missing: string[] = [];
  const altered: string[] = [];
  const recomputed: ManifestEntry[] = [];
  const sealedPaths = new Set<string>();
  for (const entry of sealedEntries) {
    sealedPaths.add(entry.path);
    const actual = onDisk.get(entry.path);
    if (actual === undefined) {
      missing.push(entry.path);
      continue;
    }
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) {
      altered.push(entry.path);
    }
    recomputed.push({ path: entry.path, sha256: actual.sha256, bytes: actual.bytes });
  }
  const extra = [...onDisk.keys()].filter((path) => !sealedPaths.has(path)).sort();
  for (const path of extra) {
    const actual = onDisk.get(path);
    if (actual !== undefined) recomputed.push({ path, sha256: actual.sha256, bytes: actual.bytes });
  }

  const recomputedTreeSha256 = buildManifestTree(recomputed, manifestSchemaVersion).treeSha256;

  if (missing.length > 0) {
    failures.push(structuredEvidenceFailure(`manifest names file(s) missing from disk: ${missing.join(", ")}`));
  }
  if (extra.length > 0) {
    failures.push(structuredEvidenceFailure(`run directory contains unmanifested file(s): ${extra.join(", ")}`));
  }
  if (altered.length > 0) {
    failures.push(structuredEvidenceFailure(`evidence file(s) were altered after sealing: ${altered.join(", ")}`));
  }
  if (recomputedTreeSha256 !== sealedTreeSha256) {
    failures.push(structuredEvidenceFailure("recomputed manifest tree hash does not match the sealed manifest"));
  }
  if (receipt.manifest.treeSha256 !== sealedTreeSha256) {
    failures.push(structuredEvidenceFailure("receipt references a different manifest tree hash"));
  }
  if (receipt.manifest.fileSha256 !== manifestFileSha256) {
    failures.push(structuredEvidenceFailure("receipt references a different manifest.json file hash"));
  }

  let populationIntegrity: VerifyRunReport["populationIntegrity"] = null;
  try {
    populationIntegrity = await verifyReceiptPopulation({
      runDir: absoluteRunDir,
      receipt,
      sealedEntries,
    });
  } catch (error: unknown) {
    failures.push(
      error instanceof EvalError
        ? error.toStructured()
        : structuredEvidenceFailure(`receipt population could not be verified: ${String(error)}`),
    );
  }

  return {
    ok: failures.length === 0,
    runDir: absoluteRunDir,
    receiptManifestSha256: receipt.manifest.treeSha256,
    sealedTreeSha256,
    recomputedTreeSha256,
    manifestFileSha256,
    receiptManifestFileSha256: receipt.manifest.fileSha256,
    missing: missing.sort(),
    extra,
    altered: altered.sort(),
    populationIntegrity,
    failures,
  };
}

interface ExpectedPairRef {
  readonly pairId: string;
  readonly repetition: number;
  readonly path: string;
  readonly conditions: readonly ReceiptConditionRef[];
}

function decodePairRef(value: unknown, at: string): ExpectedPairRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EvalError("evidence-invalid", `${at} must be an object`, { at });
  }
  const record = value as Record<string, unknown>;
  if (typeof record.pairId !== "string" || record.pairId === "") {
    throw new EvalError("evidence-invalid", `${at}.pairId must be a non-empty string`, { at });
  }
  if (!Number.isSafeInteger(record.repetition) || (record.repetition as number) <= 0) {
    throw new EvalError("evidence-invalid", `${at}.repetition must be a positive integer`, { at });
  }
  if (typeof record.path !== "string") {
    throw new EvalError("evidence-invalid", `${at}.path must be a string`, { at });
  }
  assertSafeRelativePath(record.path, `${at}.path`);
  if (!Array.isArray(record.conditions)) {
    throw new EvalError("evidence-invalid", `${at}.conditions must be an array`, { at });
  }
  const conditions = record.conditions.map((condition, index): ReceiptConditionRef => {
    const conditionAt = `${at}.conditions[${index}]`;
    if (condition === null || typeof condition !== "object" || Array.isArray(condition)) {
      throw new EvalError("evidence-invalid", `${conditionAt} must be an object`, { at: conditionAt });
    }
    const ref = condition as Record<string, unknown>;
    if (ref.conditionId !== "baseline" && ref.conditionId !== "treatment") {
      throw new EvalError("evidence-invalid", `${conditionAt}.conditionId is invalid`, { at: conditionAt });
    }
    if (typeof ref.dir !== "string") {
      throw new EvalError("evidence-invalid", `${conditionAt}.dir must be a string`, { at: conditionAt });
    }
    assertSafeRelativePath(ref.dir, `${conditionAt}.dir`);
    return { conditionId: ref.conditionId, dir: ref.dir };
  });
  return {
    pairId: record.pairId,
    repetition: record.repetition as number,
    path: record.path,
    conditions,
  };
}

function assertExactPairRef(actual: ExpectedPairRef, expected: ExpectedPairRef, at: string): void {
  if (canonicalJson(actual, at) !== canonicalJson(expected, at)) {
    throw new EvalError(
      "evidence-invalid",
      `${at} does not exactly match the integrity-bound pair identity, repetition, path, and condition order`,
      { at },
    );
  }
}

/**
 * Proves receipt population independently of the editable receipt list.
 *
 * Current evidence derives the only accepted sequence from the hash-bound frozen plan:
 * one pair per repetition, with baseline then treatment exactly as scheduled. Schema-v1
 * evidence did not retain an integrity-bound complete schedule, so it can prove exact
 * membership/references against sealed pair.json records but reports ordering unavailable.
 */
async function verifyReceiptPopulation(input: {
  readonly runDir: string;
  readonly receipt: RunReceipt;
  readonly sealedEntries: readonly ManifestEntry[];
}): Promise<NonNullable<VerifyRunReport["populationIntegrity"]>> {
  const actual = input.receipt.pairs.map((pair, index) => decodePairRef(pair, `receipt.json.pairs[${index}]`));
  const pairEntries = input.sealedEntries.filter((entry) => /^pairs\/[^/]+\/pair\.json$/.test(entry.path));
  const pairEntryPaths = new Set(pairEntries.map((entry) => entry.path));
  if (pairEntryPaths.size !== pairEntries.length) {
    throw new EvalError("evidence-invalid", "manifest contains duplicate pair.json entries", { at: MANIFEST_FILE });
  }

  const frozenPlanEntries = input.sealedEntries.filter((entry) => entry.path === "inputs/plan.json");
  if (frozenPlanEntries.length > 1) {
    throw new EvalError("evidence-invalid", "manifest contains duplicate inputs/plan.json entries", { at: MANIFEST_FILE });
  }
  const frozenPlanEntry = frozenPlanEntries[0];
  let frozenPlan: Record<string, unknown> | null = null;
  if (frozenPlanEntry !== undefined) {
    const planValue = await readJsonFile(join(input.runDir, frozenPlanEntry.path), frozenPlanEntry.path);
    if (planValue === null || typeof planValue !== "object" || Array.isArray(planValue)) {
      throw new EvalError("evidence-invalid", "inputs/plan.json must be an object", { at: "inputs/plan.json" });
    }
    const decoded = planValue as Record<string, unknown>;
    if (typeof decoded.planSha256 === "string" && Array.isArray(decoded.schedule)) {
      frozenPlan = decoded;
    } else if (input.receipt.schemaVersion !== 1) {
      throw new EvalError("evidence-invalid", "current evidence requires a complete hash-bound frozen run plan", {
        at: "inputs/plan.json",
      });
    }
  } else if (input.receipt.schemaVersion !== 1) {
    // Image/freeze failures can occur before a plan exists. They are valid evidence but
    // can never contain a population or numeric result. Every non-empty current-schema
    // population must instead be derived from a manifest-bound frozen plan.
    const explicitPrePlanFailure =
      actual.length === 0 &&
      pairEntries.length === 0 &&
      input.receipt.planSha256 === "" &&
      input.receipt.status === "partial" &&
      typeof input.receipt.stopReason === "string" &&
      input.receipt.stopReason.length > 0 &&
      input.receipt.failures.length > 0;
    if (explicitPrePlanFailure) {
      return { source: "pre-plan-failure", ordering: "not-applicable-empty" };
    }
    throw new EvalError(
      "evidence-invalid",
      "current evidence with a receipt population requires manifest-bound inputs/plan.json",
      { at: "inputs/plan.json" },
    );
  }
  if (frozenPlan !== null) {
    const plan = frozenPlan;
    if (input.receipt.schemaVersion !== 1) {
      for (const field of ["runId", "suiteId", "caseSelector", "caseId", "mode"] as const) {
        if (input.receipt[field] !== plan[field]) {
          throw new EvalError("evidence-invalid", `receipt ${field} does not match the frozen plan`, { at: `receipt.json.${field}` });
        }
      }
      if (input.receipt.testDouble !== (plan.mode === "fake") ||
          (plan.mode === "fake" && !input.receipt.evidenceLabel.startsWith("TEST-DOUBLE EVIDENCE"))) {
        throw new EvalError("evidence-invalid", "receipt cannot relabel frozen test-double evidence", { at: "receipt.json.testDouble" });
      }
    }
    const schedule = plan.schedule as unknown[];
    const { planSha256, ...hashablePlan } = plan;
    if (canonicalJsonSha256(hashablePlan) !== planSha256 || input.receipt.planSha256 !== planSha256) {
      throw new EvalError("evidence-invalid", "receipt and frozen plan do not agree on planSha256", {
        at: "receipt.json.planSha256",
      });
    }
    if (!Number.isSafeInteger(plan.repetitions) || (plan.repetitions as number) <= 0) {
      throw new EvalError("evidence-invalid", "frozen plan repetitions must be a positive integer", {
        at: "inputs/plan.json.repetitions",
      });
    }
    const repetitions = plan.repetitions as number;
    if (schedule.length !== repetitions * 2) {
      throw new EvalError("evidence-invalid", "frozen plan schedule must contain exactly two conditions per repetition", {
        at: "inputs/plan.json.schedule",
      });
    }
    const expected: ExpectedPairRef[] = [];
    for (let index = 0; index < repetitions; index += 1) {
      const baseline = schedule[index * 2] as Record<string, unknown> | undefined;
      const treatment = schedule[index * 2 + 1] as Record<string, unknown> | undefined;
      const repetition = index + 1;
      if (
        baseline?.conditionId !== "baseline" || treatment?.conditionId !== "treatment" ||
        baseline.repetition !== repetition || treatment.repetition !== repetition ||
        typeof baseline.pairId !== "string" || treatment.pairId !== baseline.pairId
      ) {
        throw new EvalError(
          "evidence-invalid",
          "frozen plan schedule must order each repetition as baseline then treatment for one pair",
          { at: `inputs/plan.json.schedule[${index * 2}]` },
        );
      }
      const pairId = baseline.pairId;
      expected.push({
        pairId,
        repetition,
        path: `pairs/${pairId}/pair.json`,
        conditions: [
          { conditionId: "baseline", dir: `pairs/${pairId}/baseline` },
          { conditionId: "treatment", dir: `pairs/${pairId}/treatment` },
        ],
      });
    }
    if (actual.length !== expected.length) {
      throw new EvalError(
        "evidence-invalid",
        `receipt pair population has ${actual.length} entries; frozen plan requires ${expected.length}`,
        { at: "receipt.json.pairs" },
      );
    }
    for (const [index, expectedPair] of expected.entries()) {
      assertExactPairRef(actual[index]!, expectedPair, `receipt.json.pairs[${index}]`);
      if (!pairEntryPaths.has(expectedPair.path)) {
        throw new EvalError("evidence-invalid", `frozen-plan pair record is absent from the manifest: ${expectedPair.path}`, {
          at: expectedPair.path,
        });
      }
      const pairRecord = await readJsonFile(join(input.runDir, expectedPair.path), expectedPair.path) as Record<string, unknown>;
      assertExactPairRef(
        decodePairRef({ ...pairRecord, path: expectedPair.path }, expectedPair.path),
        expectedPair,
        expectedPair.path,
      );
    }
    if (pairEntries.length !== expected.length) {
      throw new EvalError("evidence-invalid", "manifest pair population does not exactly match the frozen plan", {
        at: MANIFEST_FILE,
      });
    }
    return { source: "frozen-plan", ordering: "verified" };
  }

  // Schema-v1-only fallback: sealed pair records establish membership and references,
  // but no absent historical schedule is invented to claim that receipt order was bound.
  if (input.receipt.schemaVersion !== 1) {
    throw new EvalError("evidence-invalid", "current evidence requires manifest-bound inputs/plan.json", {
      at: "inputs/plan.json",
    });
  }
  const expectedByPath = new Map<string, ExpectedPairRef>();
  for (const entry of pairEntries) {
    const pairRecord = await readJsonFile(join(input.runDir, entry.path), entry.path) as Record<string, unknown>;
    expectedByPath.set(entry.path, decodePairRef({ ...pairRecord, path: entry.path }, entry.path));
  }
  if (actual.length !== expectedByPath.size) {
    throw new EvalError(
      "evidence-invalid",
      `receipt pair population has ${actual.length} entries; sealed pair records require ${expectedByPath.size}`,
      { at: "receipt.json.pairs" },
    );
  }
  const seen = new Set<string>();
  for (const [index, pair] of actual.entries()) {
    if (seen.has(pair.path)) {
      throw new EvalError("evidence-invalid", `receipt duplicates sealed pair path ${pair.path}`, {
        at: `receipt.json.pairs[${index}]`,
      });
    }
    seen.add(pair.path);
    const expected = expectedByPath.get(pair.path);
    if (expected === undefined) {
      throw new EvalError("evidence-invalid", `receipt references a pair absent from the sealed manifest: ${pair.path}`, {
        at: `receipt.json.pairs[${index}]`,
      });
    }
    assertExactPairRef(pair, expected, `receipt.json.pairs[${index}]`);
  }
  return { source: "sealed-pair-records", ordering: "unavailable-schema-v1" };
}

function structuredEvidenceFailure(message: string): StructuredFailure {
  return { code: "evidence-invalid", failureClass: "infrastructure", message, at: null };
}

// ---------------------------------------------------------------------------
// Sealed record shapes (read side)
// ---------------------------------------------------------------------------

export interface ReceiptConditionRef {
  readonly conditionId: ConditionId;
  readonly dir: string;
}

export interface ReceiptPairRef {
  readonly pairId: string;
  readonly repetition: number;
  readonly path: string;
  readonly conditions: readonly ReceiptConditionRef[];
}

export interface RunReceipt {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly suiteId: string;
  readonly caseSelector: string;
  readonly caseId: string;
  readonly caseVersion: number;
  readonly mode: string;
  readonly status: string;
  readonly stopReason: string | null;
  readonly testDouble: boolean;
  readonly evidenceLabel: string;
  readonly createdAt: string;
  readonly planSha256: string;
  readonly manifest: { readonly treeSha256: string; readonly fileSha256: string };
  readonly pairs: readonly ReceiptPairRef[];
  readonly cleanup: readonly unknown[];
  readonly failures: readonly StructuredFailure[];
}

function decodeReceipt(value: unknown): RunReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EvalError("evidence-invalid", "receipt.json must be a JSON object", { at: RECEIPT_FILE });
  }
  const record = value as Record<string, unknown>;
  const manifest = record.manifest;
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    typeof (manifest as Record<string, unknown>).treeSha256 !== "string" ||
    typeof (manifest as Record<string, unknown>).fileSha256 !== "string"
  ) {
    throw new EvalError("evidence-invalid", "receipt.json must reference a sealed manifest", { at: RECEIPT_FILE });
  }
  if (!Array.isArray(record.pairs)) {
    throw new EvalError("evidence-invalid", "receipt.json must list its pairs", { at: RECEIPT_FILE });
  }
  return record as unknown as RunReceipt;
}

export interface SealedCondition {
  readonly conditionId: ConditionId;
  readonly status: "completed" | "task-limit" | "infrastructure-failure" | "not-started";
  readonly failureClass: "task" | "infrastructure" | null;
  readonly gradeable: boolean;
  readonly skillPaths: readonly string[];
  readonly imageDigest: string | null;
  readonly guestName: string | null;
  readonly networkName: string | null;
  readonly runtime: unknown;
  readonly timing: unknown;
  readonly usage: unknown;
  readonly redactions: {
    readonly count: number;
    readonly locations: readonly string[];
  } | null;
  readonly cleanup: readonly unknown[];
  readonly testDouble: boolean;
}

// ---------------------------------------------------------------------------
// Report read model
// ---------------------------------------------------------------------------

export interface ConditionReport {
  readonly conditionId: ConditionId;
  readonly status: string;
  readonly gradeable: boolean;
  readonly score: number | null;
  readonly fullPass: boolean | null;
  readonly checksPassed: number;
  readonly checksTotal: number;
  readonly durationMs: number | null;
  readonly providerRequests: number | null;
  readonly toolSteps: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly consumedTokens: number | null;
  readonly redactions: number;
  readonly redactionLocations: readonly string[];
  readonly skillPathCount: number;
  readonly imageDigest: string | null;
  readonly cleanupOutcomes: readonly string[];
  readonly nativeSessionAvailable: boolean;
}

export interface PairReport {
  readonly pairId: string;
  readonly repetition: number;
  readonly conditions: readonly ConditionReport[];
  readonly delta: PairDelta;
  readonly valid: boolean;
  readonly baselineScore: number | null;
  readonly treatmentScore: number | null;
  readonly consumedTokensDelta: number | null;
  readonly timeDeltaSeconds: number | null;
}

export interface RunReportSummary {
  readonly baselineMean: number | null;
  readonly treatmentMean: number | null;
  readonly qualityDelta: number | null;
  readonly tokensDelta: number | null;
  readonly timeDeltaSeconds: number | null;
}

export interface RunReportCounts {
  readonly plannedPairs: number;
  readonly attemptedPairs: number;
  readonly notStartedPairs: number;
  readonly validPairs: number;
  readonly tokenDenominator: number;
  readonly timeDenominator: number;
  readonly taskLimitCount: number;
  readonly infrastructureFailureCount: number;
}

export interface RunReport {
  readonly runId: string;
  readonly suiteId: string;
  readonly caseSelector: string;
  readonly caseId: string;
  readonly mode: string;
  readonly status: string;
  readonly stopReason: string | null;
  readonly testDouble: boolean;
  readonly evidenceLabel: string;
  readonly receiptPath: string;
  readonly runDir: string;
  readonly verification: VerifyRunReport;
  readonly pairs: readonly PairReport[];
  readonly target?: Target;
  readonly harnessId?: string;
  readonly summary?: RunReportSummary;
  readonly counts?: RunReportCounts;
  readonly elapsedWallTime?: string;
  readonly failures?: readonly StructuredFailure[];
}

async function readCondition(
  runDir: string,
  conditionDir: string,
): Promise<{ condition: SealedCondition; validation: ValidationOutcome | null; nativeSessionAvailable: boolean }> {
  const condition = (await readJsonFile(join(runDir, conditionDir, "condition.json"), `${conditionDir}/condition.json`)) as SealedCondition;
  const validationRecord = (await readJsonFile(
    join(runDir, conditionDir, "validation.json"),
    `${conditionDir}/validation.json`,
  )) as { outcome?: ValidationOutcome | null };
  let nativeSessionAvailable = false;
  try {
    const sessionRaw = await readFile(join(runDir, conditionDir, "session.json"), "utf8");
    const sessionRecord = JSON.parse(sessionRaw) as Record<string, unknown>;
    const entries = Array.isArray(sessionRecord?.entries) ? sessionRecord.entries : [];
    const first = entries[0] as { type?: unknown } | undefined;
    // Advertise only what `exportNativeSessionView` will actually accept: available
    // entries AND the observed session header it requires.
    nativeSessionAvailable =
      sessionRecord !== null &&
      typeof sessionRecord === "object" &&
      sessionRecord.available !== false &&
      entries.length > 0 &&
      first?.type === "session";
  } catch {
    nativeSessionAvailable = false;
  }
  return { condition, validation: validationRecord.outcome ?? null, nativeSessionAvailable };
}

function countChecks(outcome: ValidationOutcome | null): { passed: number; total: number } {
  if (outcome === null) return { passed: 0, total: 0 };
  return { passed: outcome.checks.filter((check) => check.passed).length, total: outcome.checks.length };
}

/**
 * @notice Compiles verified per-pair scores, gradeability, deltas, execution timing, and resource usage into a read-only run report.
 * @param receiptPath Path to the sealed run receipt file or run directory.
 * @returns Compiled run report containing verification status, metadata, and per-pair evaluation results.
 * @dev Evidence is verified against disk before report generation; if verification fails, all per-pair scores and deltas are suppressed to prevent unverified evidence from being presented as valid results.
 */
export async function buildRunReport(receiptPath: string): Promise<RunReport> {
  const runDir = canonicalRunDir(receiptPath);
  const canonicalReceiptPath = join(runDir, RECEIPT_FILE);
  const receipt = decodeReceipt(await readJsonFile(canonicalReceiptPath, RECEIPT_FILE));
  const verification = await verifyRun(runDir);

  const pairs: PairReport[] = [];
  // Sealed evidence whose hash chain does not verify is not a result. The read model
  // refuses to produce ANY per-pair score or delta over it, so no caller can print one:
  // the verification failure and the named offending files are the whole report.
  if (!verification.ok) {
    return {
      runId: receipt.runId,
      suiteId: receipt.suiteId,
      caseSelector: receipt.caseSelector,
      caseId: receipt.caseId,
      mode: receipt.mode,
      status: receipt.status,
      stopReason: receipt.stopReason,
      testDouble: receipt.testDouble,
      evidenceLabel: receipt.evidenceLabel,
      receiptPath: canonicalReceiptPath,
      runDir,
      verification,
      pairs,
    };
  }

  let target: Target = { provider: "google", model: "gemini-3.8-flash", thinking: "low" };
  let harnessId = "pi";

  try {
    const targetPath = join(runDir, "inputs", "target.json");
    const rawTarget = await readJsonFile(targetPath, "inputs/target.json");
    if (rawTarget && typeof rawTarget === "object") {
      const rec = rawTarget as Record<string, unknown>;
      if (typeof rec.provider === "string" && typeof rec.model === "string" && typeof rec.thinking === "string") {
        target = { provider: rec.provider as any, model: rec.model, thinking: rec.thinking as any };
      }
      if (typeof rec.harnessId === "string") {
        harnessId = rec.harnessId;
      }
    }
  } catch {
    // Fall back to inputs/plan.json if target.json not found
  }

  try {
    const planPath = join(runDir, "inputs", "plan.json");
    const rawPlan = await readJsonFile(planPath, "inputs/plan.json");
    if (rawPlan && typeof rawPlan === "object") {
      const rec = rawPlan as Record<string, unknown>;
      const parity = rec.parity as Record<string, unknown> | undefined;
      if (parity) {
        if (typeof parity.harnessId === "string") harnessId = parity.harnessId;
        if (parity.target && typeof parity.target === "object") {
          const t = parity.target as Record<string, unknown>;
          if (typeof t.provider === "string" && typeof t.model === "string" && typeof t.thinking === "string") {
            target = { provider: t.provider as any, model: t.model, thinking: t.thinking as any };
          }
        }
      }
    }
  } catch {
    // Keep target
  }

  let taskLimitCount = 0;
  let infrastructureFailureCount = 0;

  for (const pairRef of receipt.pairs) {
    const conditionReports: ConditionReport[] = [];
    const grades: ConditionGrade[] = [];
    for (const conditionRef of pairRef.conditions) {
      const { condition, validation, nativeSessionAvailable } = await readCondition(runDir, conditionRef.dir);
      const checks = countChecks(validation);
      const timing = condition.timing as { durationMs?: unknown } | null;
      const usage = condition.usage as {
        providerRequests?: unknown;
        toolSteps?: unknown;
        inputTokens?: unknown;
        outputTokens?: unknown;
        cacheReadTokens?: unknown;
        cacheWriteTokens?: unknown;
      } | null;
      const redactions = typeof condition.redactions?.count === "number" ? condition.redactions.count : 0;
      const redactionLocations = Array.isArray(condition.redactions?.locations)
        ? condition.redactions.locations.map(String)
        : [];

      if (condition.status === "task-limit") taskLimitCount += 1;
      if (condition.status === "infrastructure-failure") infrastructureFailureCount += 1;

      const inputTokens = typeof usage?.inputTokens === "number" ? usage.inputTokens : null;
      const outputTokens = typeof usage?.outputTokens === "number" ? usage.outputTokens : null;
      const cacheReadTokens = typeof usage?.cacheReadTokens === "number" ? usage.cacheReadTokens : null;
      const cacheWriteTokens = typeof usage?.cacheWriteTokens === "number" ? usage.cacheWriteTokens : null;

      const consumedTokens =
        inputTokens !== null &&
        outputTokens !== null &&
        cacheReadTokens !== null &&
        cacheWriteTokens !== null
          ? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
          : null;

      conditionReports.push({
        conditionId: condition.conditionId,
        status: condition.status,
        gradeable: condition.gradeable,
        score: validation !== null && validation.status === "graded" ? validation.score : null,
        fullPass: validation !== null && validation.status === "graded" ? validation.fullPass : null,
        checksPassed: checks.passed,
        checksTotal: checks.total,
        durationMs: typeof timing?.durationMs === "number" ? timing.durationMs : null,
        providerRequests: typeof usage?.providerRequests === "number" ? usage.providerRequests : null,
        toolSteps: typeof usage?.toolSteps === "number" ? usage.toolSteps : null,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        consumedTokens,
        redactions,
        redactionLocations,
        skillPathCount: condition.skillPaths.length,
        imageDigest: condition.imageDigest,
        cleanupOutcomes: condition.cleanup.map((outcome) => {
          const record = outcome as { kind?: unknown; name?: unknown; status?: unknown; verified?: unknown };
          return `${String(record.kind)}:${String(record.name)}=${String(record.status)}${record.verified === true ? " (verified)" : ""}`;
        }),
        nativeSessionAvailable,
      });
      grades.push({
        conditionId: condition.conditionId,
        gradeable: condition.gradeable,
        validation,
      });
    }

    const baselineCond = conditionReports.find((c) => c.conditionId === "baseline");
    const treatmentCond = conditionReports.find((c) => c.conditionId === "treatment");
    const baselineGrade = grades.find((grade) => grade.conditionId === "baseline");
    const treatmentGrade = grades.find((grade) => grade.conditionId === "treatment");

    // A pair is valid if and only if BOTH conditions are trustworthy and gradeable with valid scores
    const baselineValid = baselineCond !== undefined && baselineCond.gradeable && baselineCond.score !== null;
    const treatmentValid = treatmentCond !== undefined && treatmentCond.gradeable && treatmentCond.score !== null;
    const pairValid = baselineValid && treatmentValid;

    // A delta is only ever produced by computePairDelta, and only when both arms exist.
    const delta: PairDelta =
      baselineGrade === undefined || treatmentGrade === undefined
        ? { gradeable: false, delta: null, reason: "the pair does not contain both conditions" }
        : computePairDelta(baselineGrade, treatmentGrade);

    let consumedTokensDelta: number | null = null;
    if (
      pairValid &&
      baselineCond?.consumedTokens !== null &&
      baselineCond?.consumedTokens !== undefined &&
      treatmentCond?.consumedTokens !== null &&
      treatmentCond?.consumedTokens !== undefined
    ) {
      consumedTokensDelta = treatmentCond.consumedTokens - baselineCond.consumedTokens;
    }

    let timeDeltaSeconds: number | null = null;
    if (
      pairValid &&
      typeof baselineCond?.durationMs === "number" &&
      typeof treatmentCond?.durationMs === "number"
    ) {
      timeDeltaSeconds = (treatmentCond.durationMs - baselineCond.durationMs) / 1000;
    }

    pairs.push({
      pairId: pairRef.pairId,
      repetition: pairRef.repetition,
      conditions: conditionReports,
      delta,
      valid: pairValid,
      baselineScore: baselineValid ? baselineCond.score : null,
      treatmentScore: treatmentValid ? treatmentCond.score : null,
      consumedTokensDelta,
      timeDeltaSeconds,
    });
  }

  // Summary means over VALID pairs only
  const validPairsList = pairs.filter((p) => p.valid);
  const validPairsCount = validPairsList.length;
  const plannedPairsCount = receipt.pairs.length;
  const attemptedPairsCount = pairs.filter((p) =>
    p.conditions.some((c) => c.status !== "not-started"),
  ).length;
  const notStartedPairsCount = plannedPairsCount - attemptedPairsCount;

  let baselineMean: number | null = null;
  let treatmentMean: number | null = null;
  let qualityDelta: number | null = null;
  let tokensDelta: number | null = null;
  let timeDeltaSeconds: number | null = null;
  let tokenDenominator = 0;
  let timeDenominator = 0;

  if (validPairsCount > 0) {
    baselineMean = validPairsList.reduce((acc, p) => acc + p.baselineScore!, 0) / validPairsCount;
    treatmentMean = validPairsList.reduce((acc, p) => acc + p.treatmentScore!, 0) / validPairsCount;
    qualityDelta = validPairsList.reduce((acc, p) => acc + p.delta.delta!, 0) / validPairsCount;

    // Normalize floating point residue
    if (Math.abs(baselineMean) < 1e-9) baselineMean = 0;
    if (Math.abs(treatmentMean) < 1e-9) treatmentMean = 0;
    if (Math.abs(qualityDelta) < 1e-9) qualityDelta = 0;

    const tokenPairs = validPairsList.filter((p) => p.consumedTokensDelta !== null);
    tokenDenominator = tokenPairs.length;
    if (tokenDenominator > 0) {
      tokensDelta = tokenPairs.reduce((acc, p) => acc + p.consumedTokensDelta!, 0) / tokenDenominator;
    }

    const timePairs = validPairsList.filter((p) => p.timeDeltaSeconds !== null);
    timeDenominator = timePairs.length;
    if (timeDenominator > 0) {
      timeDeltaSeconds = timePairs.reduce((acc, p) => acc + p.timeDeltaSeconds!, 0) / timeDenominator;
    }
  }

  const summary: RunReportSummary = {
    baselineMean,
    treatmentMean,
    qualityDelta,
    tokensDelta,
    timeDeltaSeconds,
  };

  const counts: RunReportCounts = {
    plannedPairs: plannedPairsCount,
    attemptedPairs: attemptedPairsCount,
    notStartedPairs: notStartedPairsCount,
    validPairs: validPairsCount,
    tokenDenominator,
    timeDenominator,
    taskLimitCount,
    infrastructureFailureCount,
  };

  let elapsedWallTime = "0.0s";
  if (receipt.createdAt) {
    const startMs = Date.parse(receipt.createdAt);
    const endMs = (receipt as any).finalizedAt ? Date.parse((receipt as any).finalizedAt) : Date.now();
    if (endMs >= startMs) {
      elapsedWallTime = `${((endMs - startMs) / 1000).toFixed(1)}s`;
    }
  }

  return {
    runId: receipt.runId,
    suiteId: receipt.suiteId,
    caseSelector: receipt.caseSelector,
    caseId: receipt.caseId,
    mode: receipt.mode,
    status: receipt.status,
    stopReason: receipt.stopReason,
    testDouble: receipt.testDouble,
    evidenceLabel: receipt.evidenceLabel,
    receiptPath: canonicalReceiptPath,
    runDir,
    verification,
    pairs,
    target,
    harnessId,
    summary,
    counts,
    elapsedWallTime,
    failures: receipt.failures,
  };
}

function formatScore(score: number | null): string {
  if (score === null || Number.isNaN(score)) return "n/a";
  if (Math.abs(score) < 0.0005) return "0.000";
  return score.toFixed(3);
}

function formatDelta(delta: number | null): string {
  if (delta === null || Number.isNaN(delta)) return "n/a";
  if (Math.abs(delta) < 0.0005) return "0.000";
  const str = delta.toFixed(3);
  return delta > 0 ? `+${str}` : str;
}

function formatTokensDelta(tokens: number | null): string {
  if (tokens === null || Number.isNaN(tokens)) return "n/a";
  const rounded = Math.round(tokens);
  if (rounded === 0) return "0";
  const formatted = Math.abs(rounded).toLocaleString("en-US");
  return rounded > 0 ? `+${formatted}` : `-${formatted}`;
}

function formatTimeDelta(seconds: number | null): string {
  if (seconds === null || Number.isNaN(seconds)) return "n/a";
  if (Math.abs(seconds) < 0.05) return "0.0s";
  const formatted = Math.abs(seconds).toFixed(1);
  return seconds > 0 ? `+${formatted}s` : `-${formatted}s`;
}

export function renderResultsTable(report: RunReport): string {
  const headers = ["Case", "Harness", "Provider", "Model", "Baseline", "Treatment", "Delta", "Tokens Δ", "Time Δ"];
  const row = [
    report.caseSelector,
    report.harnessId ?? "pi",
    report.target?.provider ?? "n/a",
    report.target?.model ?? "n/a",
    formatScore(report.summary?.baselineMean ?? null),
    formatScore(report.summary?.treatmentMean ?? null),
    formatDelta(report.summary?.qualityDelta ?? null),
    formatTokensDelta(report.summary?.tokensDelta ?? null),
    formatTimeDelta(report.summary?.timeDeltaSeconds ?? null),
  ];

  const colWidths = headers.map((h, i) => Math.max(h.length, row[i]!.length));

  const padHeader = (h: string, i: number) => (i < 4 ? h.padEnd(colWidths[i]!) : h.padStart(colWidths[i]!));
  const padCell = (c: string, i: number) => (i < 4 ? c.padEnd(colWidths[i]!) : c.padStart(colWidths[i]!));

  const topBorder = "┌─" + colWidths.map((w) => "─".repeat(w)).join("─┬─") + "─┐";
  const headerLine = "│ " + headers.map((h, i) => padHeader(h, i)).join(" │ ") + " │";
  const midBorder = "├─" + colWidths.map((w) => "─".repeat(w)).join("─┼─") + "─┤";
  const dataLine = "│ " + row.map((c, i) => padCell(c, i)).join(" │ ") + " │";
  const bottomBorder = "└─" + colWidths.map((w) => "─".repeat(w)).join("─┴─") + "─┘";

  return [topBorder, headerLine, midBorder, dataLine, bottomBorder].join("\n");
}

export function renderMarkdownTable(report: RunReport): string {
  const headers = ["Case", "Harness", "Provider", "Model", "Baseline", "Treatment", "Delta", "Tokens Δ", "Time Δ"];
  const aligns = [":---", ":---", ":---", ":---", "---:", "---:", "---:", "---:", "---:"];
  const row = [
    report.caseSelector,
    report.harnessId ?? "pi",
    report.target?.provider ?? "n/a",
    report.target?.model ?? "n/a",
    formatScore(report.summary?.baselineMean ?? null),
    formatScore(report.summary?.treatmentMean ?? null),
    formatDelta(report.summary?.qualityDelta ?? null),
    formatTokensDelta(report.summary?.tokensDelta ?? null),
    formatTimeDelta(report.summary?.timeDeltaSeconds ?? null),
  ];

  const headerLine = "| " + headers.join(" | ") + " |";
  const alignLine = "| " + aligns.join(" | ") + " |";
  const dataLine = "| " + row.join(" | ") + " |";

  return [headerLine, alignLine, dataLine].join("\n");
}

function renderPairDetails(report: RunReport): string {
  const lines: string[] = [];
  for (const pair of report.pairs) {
    lines.push(`pair ${pair.pairId} (repetition ${pair.repetition})`);
    for (const condition of pair.conditions) {
      const score = formatScore(condition.score);
      const redactionSuffix = condition.redactions > 0 ? ` redactions=${condition.redactions}` : "";
      lines.push(
        `  ${condition.conditionId.padEnd(9)} status=${condition.status.padEnd(22)} gradeable=${String(condition.gradeable).padEnd(5)} ` +
          `score=${score.padEnd(6)} checks=${condition.checksPassed}/${condition.checksTotal} ` +
          `skillPaths=${condition.skillPathCount} durationMs=${condition.durationMs ?? "null"} ` +
          `providerRequests=${condition.providerRequests ?? "null"} toolSteps=${condition.toolSteps ?? "null"}${redactionSuffix}`,
      );
      if (condition.redactions > 0) {
        lines.push(`             redactions=${condition.redactions} (${condition.redactionLocations.join(", ")})`);
      }
      lines.push(`             image=${condition.imageDigest ?? "(none)"}`);
      lines.push(`             cleanup=${condition.cleanupOutcomes.join(", ") || "(none)"}`);
    }
    // Never print a number when the pair is not gradeable: print the reason instead.
    lines.push(
      pair.delta.gradeable && pair.delta.delta !== null
        ? `  delta     ${formatDelta(pair.delta.delta)}  (${pair.delta.reason})`
        : `  delta     none — ${pair.delta.reason}`,
    );
  }
  return lines.join("\n");
}

function findFirstAvailableNativeSession(pairs: readonly PairReport[]): {
  readonly pairId: string;
  readonly conditionId: ConditionId;
} | null {
  for (const pair of pairs) {
    const treatment = pair.conditions.find((c) => c.conditionId === "treatment" && c.nativeSessionAvailable);
    const baseline = pair.conditions.find((c) => c.conditionId === "baseline" && c.nativeSessionAvailable);
    if (treatment !== undefined) {
      return { pairId: pair.pairId, conditionId: "treatment" };
    }
    if (baseline !== undefined) {
      return { pairId: pair.pairId, conditionId: "baseline" };
    }
  }
  return null;
}

export function formatRunReport(
  report: RunReport,
  options: { readonly format?: "table" | "markdown" | "json"; readonly details?: boolean } = {},
): string {
  const format = options.format ?? "table";

  if (format === "json") {
    if (!report.verification.ok) {
      return JSON.stringify(
        {
          schemaVersion: 1,
          success: false,
          receipt: null,
          summary: null,
          failures: [
            ...report.verification.failures,
            {
              code: "evidence-invalid",
              failureClass: "infrastructure",
              message: "the hash chain does not verify; no score and no delta are reported for this run",
              at: "report.verify",
            },
          ],
        },
        null,
        2,
      );
    }
    return JSON.stringify(
      {
        schemaVersion: 1,
        runId: report.runId,
        suiteId: report.suiteId,
        caseSelector: report.caseSelector,
        caseId: report.caseId,
        mode: report.mode,
        status: report.status,
        testDouble: report.testDouble,
        evidenceLabel: report.evidenceLabel,
        receipt: report.receiptPath,
        target: report.target ?? null,
        harness: report.harnessId ?? "pi",
        summary: report.summary
          ? {
              baseline: report.summary.baselineMean,
              treatment: report.summary.treatmentMean,
              delta: report.summary.qualityDelta,
              tokensDelta: report.summary.tokensDelta,
              timeDeltaSeconds: report.summary.timeDeltaSeconds,
            }
          : null,
        counts: report.counts ?? null,
        pairs: report.pairs,
        failures: report.failures ?? [],
        commands: {
          report: `pnpm eval:report --receipt ${report.receiptPath}`,
          inspect: `pnpm eval:inspect --receipt ${report.receiptPath} --condition treatment --view candidate`,
          exportNative: `pnpm eval:inspect --receipt ${report.receiptPath} --condition treatment --view session --export both`,
          reproduceDryRun: `pnpm eval --from ${report.receiptPath} --dry-run`,
        },
      },
      null,
      2,
    );
  }

  const lines: string[] = [];
  lines.push(`run       ${report.runId}`);
  lines.push(`suite     ${report.suiteId}`);
  lines.push(`case      ${report.caseSelector} (${report.caseId})`);
  lines.push(`mode      ${report.mode}  status=${report.status}${report.stopReason === null ? "" : `  stopReason=${report.stopReason}`}`);
  lines.push(`evidence  ${report.evidenceLabel}${report.testDouble ? " (not a measured result)" : ""}`);
  lines.push(
    `chain     ${report.verification.ok ? "VERIFIED" : "BROKEN"}  manifest=${(report.verification.sealedTreeSha256 ?? "").slice(0, 12)}`,
  );
  for (const failure of report.verification.failures) {
    lines.push(`          [${failure.code}] ${failure.message}`);
  }

  if (!report.verification.ok) {
    // Never print a score or a delta over a broken chain: name the offending files and
    // stop. `buildRunReport` has already refused to compute them.
    for (const [label, paths] of [
      ["missing", report.verification.missing],
      ["extra", report.verification.extra],
      ["altered", report.verification.altered],
    ] as ReadonlyArray<readonly [string, readonly string[]]>) {
      if (paths.length > 0) lines.push(`${label.padEnd(9)} ${paths.join(", ")}`);
    }
    lines.push("");
    lines.push(
      "REFUSED   the hash chain does not verify; no score and no delta are reported for this run",
    );
    return lines.join("\n");
  }

  if (format === "markdown") {
    const mdLines: string[] = [];
    mdLines.push("# Evaluation Results\n");
    mdLines.push(`- **Evidence:** ${report.evidenceLabel}${report.testDouble ? " (TEST-DOUBLE EVIDENCE)" : ""}`);
    mdLines.push(
      `- **Pairs:** ${report.counts?.validPairs ?? 0} valid / ${report.counts?.attemptedPairs ?? 0} attempted (${report.counts?.plannedPairs ?? 0} planned, ${report.counts?.notStartedPairs ?? 0} not started)`,
    );
    if (report.counts && report.counts.tokenDenominator !== report.counts.validPairs) {
      mdLines.push(`- **Tokens Δ denominator:** ${report.counts.tokenDenominator} pair(s)`);
    }
    if (report.counts && report.counts.timeDenominator !== report.counts.validPairs) {
      mdLines.push(`- **Time Δ denominator:** ${report.counts.timeDenominator} pair(s)`);
    }
    if (report.elapsedWallTime) {
      mdLines.push(`- **Elapsed:** ${report.elapsedWallTime} wall time`);
    }
    for (const failure of report.failures ?? []) {
      mdLines.push(`- **Failure:** [${failure.code}] ${failure.message}`);
    }
    mdLines.push(`- **Receipt:** \`${report.receiptPath}\`\n`);
    mdLines.push(renderMarkdownTable(report));
    if (options.details && report.pairs.length > 0) {
      mdLines.push(`\n## Pair details\n\n\`\`\`text\n${renderPairDetails(report)}\n\`\`\``);
    }
    const nativeTarget = findFirstAvailableNativeSession(report.pairs);
    if (nativeTarget !== null) {
      mdLines.push(
        `\n- Inspect/export: \`pnpm eval:inspect --receipt ${report.receiptPath} --pair ${nativeTarget.pairId} --condition ${nativeTarget.conditionId} --view session --export both\``,
      );
    } else {
      mdLines.push("\n- Inspect/export: n/a (no native Pi session recorded for this run)");
    }
    mdLines.push(`- Reproduction plan: \`pnpm eval --from ${report.receiptPath} --dry-run\``);
    return mdLines.join("\n");
  }

  // Bordered terminal table format (default)
  if (report.counts) {
    lines.push(
      `pairs     ${report.counts.validPairs} valid / ${report.counts.attemptedPairs} attempted (${report.counts.plannedPairs} planned, ${report.counts.notStartedPairs} not started)`,
    );
    if (report.counts.tokenDenominator !== report.counts.validPairs) {
      lines.push(`tokens Δ  based on ${report.counts.tokenDenominator} pair(s) with both measurements`);
    }
    if (report.counts.timeDenominator !== report.counts.validPairs) {
      lines.push(`time Δ    based on ${report.counts.timeDenominator} pair(s) with both measurements`);
    }
    if (report.counts.taskLimitCount > 0 || report.counts.infrastructureFailureCount > 0) {
      lines.push(
        `limits    task-limit=${report.counts.taskLimitCount}  infrastructure-failure=${report.counts.infrastructureFailureCount}`,
      );
    }
  }
  if (report.elapsedWallTime) {
    lines.push(`elapsed   ${report.elapsedWallTime} wall time`);
  }
  for (const failure of report.failures ?? []) {
    lines.push(`failure   [${failure.code}] ${failure.message}`);
  }

  lines.push("");
  lines.push(renderResultsTable(report));
  lines.push("");

  if (options.details && report.pairs.length > 0) {
    lines.push(renderPairDetails(report));
    lines.push("");
  }
  lines.push(`receipt   ${report.receiptPath}`);
  const nativeTarget = findFirstAvailableNativeSession(report.pairs);
  if (nativeTarget !== null) {
    lines.push(
      `native    pnpm eval:inspect --receipt ${report.receiptPath} --pair ${nativeTarget.pairId} --condition ${nativeTarget.conditionId} --view session --export both`,
    );
  } else {
    lines.push("native    n/a (no native Pi session recorded for this run)");
  }
  lines.push(`from      pnpm eval --from ${report.receiptPath} --dry-run`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Native session view derivation
// ---------------------------------------------------------------------------

/**
 * Derives normalized messages from native session entries.
 * Eliminates duplicate canonical message transcripts in durable evidence.
 */
export function deriveMessagesFromNativeSession(
  entries: readonly unknown[],
): readonly NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  if (!Array.isArray(entries)) return messages;

  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const msg = entry.message as Record<string, unknown>;
    const rawRole = String(msg.role ?? "assistant");
    const role: NormalizedMessage["role"] =
      rawRole === "user"
        ? "user"
        : rawRole === "toolResult" || rawRole === "tool"
        ? "tool"
        : rawRole === "system"
        ? "system"
        : "assistant";

    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            parts.push(b.text);
          } else if (b.type === "toolCall" && typeof b.name === "string") {
            parts.push(`[tool call: ${b.name}]`);
          } else if (b.type === "toolResult") {
            parts.push(typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""));
          }
        }
      }
      text = parts.join("\n");
    } else if (msg.errorMessage) {
      text = String(msg.errorMessage);
    }

    messages.push({
      index: messages.length,
      role,
      text,
      truncated: false,
    });
  }

  return messages;
}

/**
 * Derives normalized tool steps from native session entries.
 * Eliminates duplicate canonical tool transcripts in durable evidence.
 */
export function deriveToolStepsFromNativeSession(
  entries: readonly unknown[],
): readonly NormalizedToolStep[] {
  const steps: NormalizedToolStep[] = [];
  if (!Array.isArray(entries)) return steps;

  // Index tool results by toolCallId
  const resultsById = new Map<string, { isError: boolean; content: unknown }>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (entry.type === "message" && entry.message && typeof entry.message === "object") {
      const msg = entry.message as Record<string, unknown>;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object") {
            const b = block as Record<string, unknown>;
            if (b.type === "toolResult" && typeof b.toolCallId === "string") {
              resultsById.set(b.toolCallId, { isError: b.isError === true, content: b.content });
            }
          }
        }
      }
      if (typeof msg.toolCallId === "string") {
        resultsById.set(msg.toolCallId, { isError: msg.isError === true, content: msg.content });
      }
    }
  }

  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (entry.type === "message" && entry.message && typeof entry.message === "object") {
      const msg = entry.message as Record<string, unknown>;
      const calls: Array<{ id?: string; name: string; arguments?: unknown }> = [];
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object" && (block as Record<string, unknown>).type === "toolCall") {
            const b = block as Record<string, unknown>;
            if (typeof b.name === "string") {
              calls.push({ id: typeof b.id === "string" ? b.id : undefined, name: b.name, arguments: b.arguments });
            }
          }
        }
      }
      if (Array.isArray(msg.toolCalls)) {
        for (const call of msg.toolCalls) {
          if (call && typeof call === "object" && typeof (call as Record<string, unknown>).name === "string") {
            const c = call as Record<string, unknown>;
            calls.push({ id: typeof c.id === "string" ? c.id : undefined, name: String(c.name), arguments: c.arguments });
          }
        }
      }
      for (const call of calls) {
        let summary = "";
        if (call.arguments && typeof call.arguments === "object") {
          const args = call.arguments as Record<string, unknown>;
          if (typeof args.path === "string") summary = args.path;
          else if (typeof args.command === "string") summary = args.command;
          else summary = JSON.stringify(args).slice(0, 80);
        }
        const res = call.id ? resultsById.get(call.id) : undefined;
        const outcome: NormalizedToolStep["outcome"] = res?.isError ? "error" : "ok";
        steps.push({
          index: steps.length,
          tool: call.name,
          summary,
          outcome,
          durationMs: 0,
        });
      }
    }
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Inspect read model
// ---------------------------------------------------------------------------

export const INSPECT_VIEWS = [
  "condition",
  "messages",
  "tools",
  "workspace",
  "candidate",
  "validation",
  "errors",
  "runtime",
  // The OBSERVED guest attestation, as its own view: the declared policy lives in
  // inputs/policy.json and a reader must be able to reach the observation from a receipt
  // in order to compare the two.
  "attestation",
  "redactions",
  "session",
] as const;
export type InspectViewName = (typeof INSPECT_VIEWS)[number];

const VIEW_FILES: Readonly<Record<InspectViewName, string>> = {
  condition: "condition.json",
  messages: "messages.json",
  tools: "tool-steps.json",
  workspace: "workspace.json",
  candidate: "candidate.json",
  validation: "validation.json",
  errors: "errors.json",
  runtime: "condition.json",
  attestation: "attestation.json",
  redactions: "redactions.json",
  session: "session.json",
};

export interface InspectResult {
  readonly runId: string;
  readonly pairId: string;
  readonly conditionId: ConditionId;
  readonly view: InspectViewName;
  readonly file: string;
  readonly verified: boolean;
  readonly content: unknown;
}

/** One condition, one view, recomputed from sealed evidence. Never mutates. */
export async function inspectCondition(input: {
  readonly receiptPath: string;
  readonly conditionId: ConditionId;
  readonly view: InspectViewName;
  readonly pairId?: string | null;
}): Promise<InspectResult> {
  const runDir = canonicalRunDir(input.receiptPath);
  const receiptPath = join(runDir, RECEIPT_FILE);
  const receipt = decodeReceipt(await readJsonFile(receiptPath, RECEIPT_FILE));
  const verification = await verifyRun(runDir);

  const pairId = input.pairId ?? null;
  const pairRef =
    pairId === null ? receipt.pairs[0] : receipt.pairs.find((pair) => pair.pairId === pairId);
  if (pairRef === undefined) {
    throw new EvalError("input-invalid", `receipt has no pair ${pairId ?? "(first)"}`, { at: "--pair" });
  }
  const conditionRef = pairRef.conditions.find((condition) => condition.conditionId === input.conditionId);
  if (conditionRef === undefined) {
    throw new EvalError("input-invalid", `pair ${pairRef.pairId} has no ${input.conditionId} condition`, {
      at: "--condition",
    });
  }

  // Handle views that may be derived or version-dependent:
  if (input.view === "messages") {
    const legacyPath = join(runDir, conditionRef.dir, "messages.json");
    const hasLegacy = await stat(legacyPath).then(() => true).catch(() => false);
    if (hasLegacy) {
      const content = await readJsonFile(legacyPath, `${conditionRef.dir}/messages.json`);
      return {
        runId: receipt.runId,
        pairId: pairRef.pairId,
        conditionId: input.conditionId,
        view: "messages",
        file: `${conditionRef.dir}/messages.json`,
        verified: verification.ok,
        content,
      };
    }
    const sessionPath = join(runDir, conditionRef.dir, "session.json");
    const hasSession = await stat(sessionPath).then(() => true).catch(() => false);
    if (hasSession) {
      const sessionRecord = (await readJsonFile(sessionPath, `${conditionRef.dir}/session.json`)) as {
        entries?: readonly unknown[];
      };
      const messages = deriveMessagesFromNativeSession(sessionRecord.entries ?? []);
      return {
        runId: receipt.runId,
        pairId: pairRef.pairId,
        conditionId: input.conditionId,
        view: "messages",
        file: `${conditionRef.dir}/session.json`,
        verified: verification.ok,
        content: {
          conditionId: input.conditionId,
          messages,
          derivedFromSession: true,
        },
      };
    }
    throw new EvalError("evidence-invalid", `${conditionRef.dir}/messages.json is missing from sealed evidence`, {
      at: `${conditionRef.dir}/messages.json`,
    });
  }

  if (input.view === "tools") {
    const legacyPath = join(runDir, conditionRef.dir, "tool-steps.json");
    const hasLegacy = await stat(legacyPath).then(() => true).catch(() => false);
    if (hasLegacy) {
      const content = await readJsonFile(legacyPath, `${conditionRef.dir}/tool-steps.json`);
      return {
        runId: receipt.runId,
        pairId: pairRef.pairId,
        conditionId: input.conditionId,
        view: "tools",
        file: `${conditionRef.dir}/tool-steps.json`,
        verified: verification.ok,
        content,
      };
    }
    const sessionPath = join(runDir, conditionRef.dir, "session.json");
    const hasSession = await stat(sessionPath).then(() => true).catch(() => false);
    if (hasSession) {
      const sessionRecord = (await readJsonFile(sessionPath, `${conditionRef.dir}/session.json`)) as {
        entries?: readonly unknown[];
      };
      const toolSteps = deriveToolStepsFromNativeSession(sessionRecord.entries ?? []);
      return {
        runId: receipt.runId,
        pairId: pairRef.pairId,
        conditionId: input.conditionId,
        view: "tools",
        file: `${conditionRef.dir}/session.json`,
        verified: verification.ok,
        content: {
          conditionId: input.conditionId,
          toolSteps,
          derivedFromSession: true,
        },
      };
    }
    throw new EvalError("evidence-invalid", `${conditionRef.dir}/tool-steps.json is missing from sealed evidence`, {
      at: `${conditionRef.dir}/tool-steps.json`,
    });
  }

  if (input.view === "session") {
    const sessionPath = join(runDir, conditionRef.dir, "session.json");
    const hasSession = await stat(sessionPath).then(() => true).catch(() => false);
    if (!hasSession) {
      return {
        runId: receipt.runId,
        pairId: pairRef.pairId,
        conditionId: input.conditionId,
        view: "session",
        file: `${conditionRef.dir}/session.json`,
        verified: verification.ok,
        content: {
          available: false,
          reason: "native session is not available in schema-v1 evidence",
          headerAvailable: false,
          header: null,
          entries: [],
          treeEntries: [],
        },
      };
    }
    const content = (await readJsonFile(sessionPath, `${conditionRef.dir}/session.json`)) as Record<string, unknown>;
    const entries = Array.isArray(content.entries) ? content.entries : [];
    const firstRecord = entries[0];
    const header = firstRecord && typeof firstRecord === "object" && (firstRecord as Record<string, unknown>).type === "session"
      ? firstRecord
      : null;
    const available = content.available !== false && entries.length > 0;
    return {
      runId: receipt.runId,
      pairId: pairRef.pairId,
      conditionId: input.conditionId,
      view: "session",
      file: `${conditionRef.dir}/session.json`,
      verified: verification.ok,
      content: {
        ...content,
        available,
        headerAvailable: header !== null,
        header,
        treeEntries: header === null ? entries : entries.slice(1),
        reason: available ? null : (typeof content.incompleteReason === "string" ? content.incompleteReason : "native session entries unavailable for this condition"),
      },
    };
  }

  if (input.view === "candidate") {
    const file = `${conditionRef.dir}/${VIEW_FILES.candidate}`;
    const absolute = join(runDir, conditionRef.dir, VIEW_FILES.candidate);
    await stat(absolute).catch((cause: unknown) => {
      throw new EvalError("evidence-invalid", `${file} is missing from sealed evidence`, { at: file, cause });
    });
    const candidate = await readCandidate(runDir, conditionRef.dir);
    return {
      runId: receipt.runId,
      pairId: pairRef.pairId,
      conditionId: input.conditionId,
      view: "candidate",
      file,
      verified: verification.ok,
      content: candidate,
    };
  }

  const file = `${conditionRef.dir}/${VIEW_FILES[input.view]}`;
  const absolute = join(runDir, conditionRef.dir, VIEW_FILES[input.view]);
  await stat(absolute).catch((cause: unknown) => {
    throw new EvalError("evidence-invalid", `${file} is missing from sealed evidence`, { at: file, cause });
  });
  const content = await readJsonFile(absolute, file);

  return {
    runId: receipt.runId,
    pairId: pairRef.pairId,
    conditionId: input.conditionId,
    view: input.view,
    file,
    verified: verification.ok,
    content:
      input.view === "runtime"
        ? {
            runtime: (content as SealedCondition).runtime,
            imageDigest: (content as SealedCondition).imageDigest,
            guestName: (content as SealedCondition).guestName,
            networkName: (content as SealedCondition).networkName,
            skillPaths: (content as SealedCondition).skillPaths,
            redactions: (content as SealedCondition).redactions ?? { count: 0, locations: [] },
            cleanup: (content as SealedCondition).cleanup,
            testDouble: (content as SealedCondition).testDouble,
            // Named so a reader of the runtime view knows where the observation is.
            attestationFile: `${conditionRef.dir}/attestation.json`,
          }
        : content,
  };
}

export function formatInspectResult(result: InspectResult): string {
  const header = [
    `run       ${result.runId}`,
    `pair      ${result.pairId}`,
    `condition ${result.conditionId}`,
    `view      ${result.view}  (${result.file})`,
    `chain     ${result.verified ? "VERIFIED" : "BROKEN"}`,
    "",
  ].join("\n");

  // The workspace and candidate views are stored base64 so the sealed bytes are exact.
  // A wall of base64 is not inspectable by a human, so the human rendering decodes,
  // while the read model above stays byte-exact.
  if (result.view === "workspace" || result.view === "candidate") {
    const record = result.content as {
      files?: ReadonlyArray<{
        path: string;
        base64?: string;
        bytes?: number;
        sha256?: string;
        workspaceRef?: string | null;
        workspaceRefResolved?: boolean;
        present?: boolean;
      }>;
      skipped?: readonly unknown[];
      truncated?: boolean;
      includedPaths?: readonly string[];
    };
    const rawFiles = record.files ?? [];
    const files: Array<{ path: string; base64: string }> = [];
    for (const f of rawFiles) {
      if (f.present === false) {
        files.push({ path: `${f.path} [MISSING / ABSENT]`, base64: "" });
      } else if (typeof f.base64 === "string" && f.base64.length > 0) {
        files.push({ path: f.path, base64: f.base64 });
      } else if (
        typeof f.base64 === "string" &&
        f.base64.length === 0 &&
        (!f.workspaceRef || f.workspaceRefResolved === true)
      ) {
        files.push({ path: f.path, base64: "" });
      } else if (f.workspaceRef) {
        files.push({ path: `${f.path} (ref: ${f.workspaceRef})`, base64: "" });
      }
    }
    const summary = [
      `files     ${rawFiles.length}`,
      `truncated ${String(record.truncated ?? false)}`,
      `skipped   ${JSON.stringify(record.skipped ?? [])}`,
      "",
    ].join("\n");
    return `${header}${summary}${renderFileMap(files)}\n`;
  }

  if (result.view === "session") {
    const record = result.content as {
      available?: boolean;
      reason?: string;
      completed?: boolean;
      tailStatus?: string;
      incompleteTail?: boolean;
      incompleteReason?: string;
      entryCount?: number;
      entries?: readonly unknown[];
    };
    if (record.available === false) {
      return `${header}session   UNAVAILABLE (${record.reason ?? "not recorded"})\n`;
    }
    const summary = [
      `entries   ${record.entryCount ?? (record.entries?.length ?? 0)}`,
      `completed ${String(record.completed ?? true)}`,
      `tail      ${record.tailStatus ?? "completed"}${record.incompleteTail ? ` (incomplete: ${record.incompleteReason ?? "truncated"})` : ""}`,
      "",
    ].join("\n");
    return `${header}${summary}${JSON.stringify(record.entries ?? [], null, 2)}\n`;
  }

  return `${header}${JSON.stringify(result.content, null, 2)}`;
}

export function isBinaryBuffer(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  const text = buf.toString("utf8");
  return !Buffer.from(text, "utf8").equals(buf);
}

/**
 * Decodes a base64 workspace or candidate view into readable text.
 *
 * Kept separate from `inspectCondition` so the authoritative read model stays byte-exact
 * and only the human-facing rendering decodes.
 */
export function renderFileMap(files: ReadonlyArray<{ path: string; base64?: string }>): string {
  return files
    .map((file) => {
      if (file.base64 === undefined || file.base64 === null) {
        return `----- ${file.path} -----\n(referenced in workspace or omitted from capture)`;
      }
      if (file.base64 === "") {
        if (file.path.includes("[MISSING / ABSENT]")) {
          return `----- ${file.path} -----\n(file absent)`;
        }
        if (file.path.includes("(ref: ")) {
          return `----- ${file.path} -----\n(referenced in workspace or omitted from capture)`;
        }
        return `----- ${file.path} -----\n(empty file)`;
      }
      const buf = Buffer.from(file.base64, "base64");
      if (isBinaryBuffer(buf)) {
        return `----- ${file.path} -----\n[binary data: ${buf.byteLength} bytes, hex: ${buf.toString("hex")}]`;
      }
      return `----- ${file.path} -----\n${buf.toString("utf8")}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Universal Reader APIs (Schema v1 and Schema v2 round-trip)
// ---------------------------------------------------------------------------

export interface SealedFrozenInputsResult {
  readonly available: boolean;
  readonly reason: string | null;
  readonly schemaVersion: number;
  readonly prompt: string | null;
  readonly oracleBytes: Buffer | null;
  readonly validatorSource: string | null;
  readonly fixtureFiles: ReadonlyArray<{ readonly path: string; readonly bytes: Buffer }>;
  readonly skillFiles: ReadonlyArray<{ readonly path: string; readonly bytes: Buffer }>;
  readonly provenance: Readonly<Record<string, string>> | null;
  readonly caseConfig: Record<string, unknown> | null;
  readonly policy: Record<string, unknown> | null;
}

export async function readFrozenInputs(receiptOrRunDir: string): Promise<SealedFrozenInputsResult> {
  const runDir = canonicalRunDir(receiptOrRunDir);
  const frozenDir = join(runDir, "inputs", "frozen");
  const verification = await verifyRun(runDir);
  if (!verification.ok) {
    throw new EvalError("evidence-invalid", "retained inputs refuse a broken evidence chain", { at: join(runDir, RECEIPT_FILE) });
  }

  const caseConfig = (await readJsonFile(join(runDir, "inputs", "case.json"), "inputs/case.json").catch(() => null)) as Record<string, unknown> | null;
  const policy = (await readJsonFile(join(runDir, "inputs", "policy.json"), "inputs/policy.json").catch(() => null)) as Record<string, unknown> | null;

  const manifestPath = join(frozenDir, "manifest.json");
  const hasFrozenManifest = await stat(manifestPath).then(() => true).catch(() => false);
  if (!hasFrozenManifest) {
    return {
      available: false,
      reason: "frozen input snapshot is not available in schema-v1 evidence",
      schemaVersion: 1,
      prompt: null,
      oracleBytes: null,
      validatorSource: null,
      fixtureFiles: [],
      skillFiles: [],
      provenance: null,
      caseConfig,
      policy,
    };
  }

  // Current schema: independently verify the retained snapshot manifest and exact population.
  const frozenManifest = await readJsonFile(manifestPath, "inputs/frozen/manifest.json") as {
    schemaVersion?: unknown;
    treeSha256?: unknown;
    entries?: readonly ManifestEntry[];
  };
  if (!Array.isArray(frozenManifest.entries) || typeof frozenManifest.treeSha256 !== "string") {
    throw new EvalError("evidence-invalid", "frozen input manifest is malformed", { at: "inputs/frozen/manifest.json" });
  }
  const retainedFiles = await walkChainFiles(frozenDir, false);
  const retainedWithoutManifest = [...retainedFiles.entries()]
    .filter(([path]) => path !== "manifest.json")
    .map(([path, value]) => ({ path, ...value }));
  const declaredPaths = new Set(frozenManifest.entries.map((entry) => entry.path));
  const actualPaths = new Set(retainedWithoutManifest.map((entry) => entry.path));
  if (declaredPaths.size !== frozenManifest.entries.length ||
      [...declaredPaths].some((path) => !actualPaths.has(path)) ||
      [...actualPaths].some((path) => !declaredPaths.has(path))) {
    throw new EvalError("evidence-invalid", "frozen input manifest does not name the exact retained file population", { at: "inputs/frozen/manifest.json" });
  }
  for (const entry of frozenManifest.entries) {
    const actual = retainedFiles.get(entry.path);
    if (actual?.sha256 !== entry.sha256 || actual?.bytes !== entry.bytes) {
      throw new EvalError("evidence-invalid", `retained input does not match frozen manifest: ${entry.path}`, { at: entry.path });
    }
  }
  if (buildManifestTree(retainedWithoutManifest, Number(frozenManifest.schemaVersion ?? 1)).treeSha256 !== frozenManifest.treeSha256) {
    throw new EvalError("evidence-invalid", "frozen input tree hash does not verify", { at: "inputs/frozen/manifest.json" });
  }

  const prompt = await readFile(join(frozenDir, "case", "prompt.txt"), "utf8").catch(() => null);
  const oracleBytes = await readFile(join(frozenDir, "case", "oracle.json")).catch(() => null);
  const frozenCaseConfig = (await readJsonFile(join(frozenDir, "case", "case.json"), "inputs/frozen/case/case.json").catch(() => null)) as Record<string, unknown> | null;

  let validatorSource: string | null = null;
  const validatorDir = join(frozenDir, "case", "validator");
  const declaredValidator =
    typeof frozenCaseConfig?.validator === "string"
      ? frozenCaseConfig.validator
    : typeof caseConfig?.validator === "string"
      ? caseConfig.validator
      : null;
  const hasClosureIdentity = typeof caseConfig?.validatorClosureSha256 === "string";
  if (declaredValidator !== null) {
    try {
      const safeRel = assertSafeRelativePath(declaredValidator, "declared validator entry");
      validatorSource = await readFile(join(validatorDir, safeRel), "utf8").catch(() => null);
      if (validatorSource === null && !hasClosureIdentity) {
        // Older v2 snapshots flattened the sole entry. Never guess among a modern bundle.
        validatorSource = await readFile(join(validatorDir, basename(safeRel)), "utf8").catch(() => null);
      }
    } catch {
      validatorSource = null;
    }
  } else if (!hasClosureIdentity) {
    const files = await readdir(validatorDir, { withFileTypes: true }).catch(() => []);
    if (files.length === 1 && files[0]!.isFile()) {
      validatorSource = await readFile(join(validatorDir, files[0]!.name), "utf8").catch(() => null);
    }
  }

  const fixtureFiles: Array<{ path: string; bytes: Buffer }> = [];
  const fixtureDir = join(frozenDir, "fixture");
  const walkFixture = async (relDir: string): Promise<void> => {
    const full = relDir === "" ? fixtureDir : join(fixtureDir, relDir);
    const entries = await readdir(full, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      if (e.isDirectory()) await walkFixture(rel);
      else if (e.isFile()) {
        const bytes = await readFile(join(full, e.name));
        fixtureFiles.push({ path: rel, bytes });
      }
    }
  };
  await walkFixture("");

  const skillFiles: Array<{ path: string; bytes: Buffer }> = [];
  const skillDir = join(frozenDir, "skill");
  const walkSkill = async (relDir: string): Promise<void> => {
    const full = relDir === "" ? skillDir : join(skillDir, relDir);
    const entries = await readdir(full, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      if (e.isDirectory()) await walkSkill(rel);
      else if (e.isFile()) {
        const bytes = await readFile(join(full, e.name));
        skillFiles.push({ path: rel, bytes });
      }
    }
  };
  await walkSkill("");

  if (prompt === null || oracleBytes === null || frozenCaseConfig === null) {
    throw new EvalError("evidence-invalid", "retained snapshot is incomplete (prompt, case configuration, or oracle missing)", { at: "inputs/frozen" });
  }
  if (validatorSource === null) {
    throw new EvalError("evidence-invalid", "retained validator entry is missing", { at: "inputs/frozen/case/validator" });
  }
  const expectedPromptHash = typeof caseConfig?.promptSha256 === "string" ? caseConfig.promptSha256 : null;
  const expectedOracleHash = typeof caseConfig?.oracleSha256 === "string" ? caseConfig.oracleSha256 : null;
  const expectedFixtureHash = typeof caseConfig?.fixtureTreeSha256 === "string" ? caseConfig.fixtureTreeSha256 : null;
  if (expectedPromptHash !== null && sha256Hex(prompt) !== expectedPromptHash) throw new EvalError("evidence-invalid", "retained prompt hash disagrees with case summary", { at: "inputs/case.json" });
  if (expectedOracleHash !== null && sha256Hex(oracleBytes) !== expectedOracleHash) throw new EvalError("evidence-invalid", "retained oracle hash disagrees with case summary", { at: "inputs/case.json" });
  const fixtureIdentity = fixtureFiles.map((file) => ({ path: file.path, sha256: sha256Hex(file.bytes), bytes: file.bytes.byteLength })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (expectedFixtureHash !== null && canonicalJsonSha256(fixtureIdentity) !== expectedFixtureHash) throw new EvalError("evidence-invalid", "retained fixture hash disagrees with case summary", { at: "inputs/case.json" });
  const skillSummary = await readJsonFile(join(runDir, "inputs", "skill-snapshot.json"), "inputs/skill-snapshot.json") as Record<string, unknown>;
  const skillIdentity = skillFiles.map((file) => ({ path: file.path, sha256: sha256Hex(file.bytes), bytes: file.bytes.byteLength })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (typeof skillSummary.treeSha256 !== "string" || canonicalJsonSha256(skillIdentity) !== skillSummary.treeSha256) throw new EvalError("evidence-invalid", "retained skill tree disagrees with skill snapshot summary", { at: "inputs/skill-snapshot.json" });

  const provPath = join(runDir, "inputs", "provenance.json");
  const provenanceRecord = (await readJsonFile(provPath, "inputs/provenance.json").catch(() => null)) as Record<string, unknown> | null;
  const provenance = (provenanceRecord?.provenance ?? provenanceRecord) as Record<string, string> | null;

  return {
    available: true,
    reason: null,
    schemaVersion: 2,
    prompt,
    oracleBytes,
    validatorSource,
    fixtureFiles,
    skillFiles,
    provenance,
    caseConfig: frozenCaseConfig,
    policy,
  };
}

export interface ResolvedCandidateFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly base64: string;
  readonly workspaceRef: string | null;
  readonly workspaceRefResolved?: boolean;
  readonly present: boolean;
}

export interface ResolvedCandidateResult {
  readonly conditionId: ConditionId;
  readonly candidateMode: CandidateMode | null;
  readonly outputPath: string | null;
  readonly projected: boolean;
  readonly includedPaths: readonly string[];
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  readonly files: readonly ResolvedCandidateFile[];
}

export async function readCandidate(
  receiptOrRunDir: string,
  conditionDir: string,
): Promise<ResolvedCandidateResult> {
  const runDir = canonicalRunDir(receiptOrRunDir);
  const receiptAddressed = resolve(receiptOrRunDir).endsWith(".json");
  // A run-directory input remains an explicit internal legacy seam. Public callers pass
  // a receipt and therefore get a fully verified, membership-bound read.
  if (receiptAddressed) {
    const verification = await verifyRun(runDir);
    if (!verification.ok) throw new EvalError("evidence-invalid", "candidate read refuses a broken evidence chain", { at: conditionDir });
  }
  const safeConditionDir = assertSafeRelativePath(conditionDir, "conditionDir");
  const manifest = (await readJsonFile(join(runDir, MANIFEST_FILE), MANIFEST_FILE)) as { schemaVersion?: unknown; entries?: ReadonlyArray<{ path?: unknown }> };
  const strictAddressedBytes = typeof manifest.schemaVersion === "number" && manifest.schemaVersion >= 2;
  const members = new Set((manifest.entries ?? []).map((entry) => String(entry.path ?? "")));
  const candidateMember = `${safeConditionDir}/candidate.json`;
  const conditionMember = `${safeConditionDir}/condition.json`;
  if (!members.has(candidateMember) || !members.has(conditionMember)) {
    throw new EvalError("evidence-invalid", "candidate condition is not a member of the sealed run", { at: safeConditionDir });
  }
  const conditionRecord = (await readJsonFile(join(runDir, safeConditionDir, "condition.json"), conditionMember)) as Record<string, unknown>;
  const candPath = join(runDir, safeConditionDir, "candidate.json");
  const candRecord = (await readJsonFile(candPath, candidateMember)) as Record<string, unknown>;
  if ((conditionRecord.conditionId !== "baseline" && conditionRecord.conditionId !== "treatment") || candRecord.conditionId !== conditionRecord.conditionId) {
    throw new EvalError("evidence-invalid", "candidate condition identity disagrees with its sealed condition", { at: candidateMember });
  }

  const workspaceMember = `${safeConditionDir}/workspace.json`;
  const workspacePath = join(runDir, safeConditionDir, "workspace.json");
  const workspaceFiles = new Map<string, { base64: string; bytes: number; sha256: string }>();
  try {
    const wsRecord = (await readJsonFile(workspacePath, `${conditionDir}/workspace.json`)) as {
      files?: ReadonlyArray<{ path: string; base64: string; bytes: number; sha256: string }>;
    };
    if (!members.has(workspaceMember)) throw new EvalError("evidence-invalid", "workspace record is not a member of the sealed run", { at: workspaceMember });
    if (Array.isArray(wsRecord.files)) {
      for (const f of wsRecord.files) {
        const bytes = Buffer.from(f.base64, "base64");
        if (strictAddressedBytes && (bytes.toString("base64") !== f.base64 || bytes.byteLength !== f.bytes || sha256Hex(bytes) !== f.sha256)) {
          throw new EvalError("evidence-invalid", "workspace file bytes disagree with their addressed identity", { at: `${workspaceMember}:${f.path}` });
        }
        workspaceFiles.set(f.path, f);
      }
    }
  } catch (error) {
    if (members.has(workspaceMember)) throw error;
    // A workspace record is optional only when the manifest says it is absent.
  }

  const rawFiles = Array.isArray(candRecord.files) ? (candRecord.files as ReadonlyArray<Record<string, unknown>>) : [];
  const files: ResolvedCandidateFile[] = [];

  for (const rf of rawFiles) {
    const path = String(rf.path ?? "");
    const workspaceRef = typeof rf.workspaceRef === "string" ? rf.workspaceRef : null;
    let base64 = typeof rf.base64 === "string" ? rf.base64 : "";
    let bytes = typeof rf.bytes === "number" ? rf.bytes : 0;
    let sha256 = typeof rf.sha256 === "string" ? rf.sha256 : "";
    const present = rf.present !== false;

    let workspaceRefResolved: boolean | undefined = undefined;

    if (base64 === "" && workspaceRef !== null && workspaceFiles.has(workspaceRef)) {
      const ws = workspaceFiles.get(workspaceRef)!;
      base64 = ws.base64;
      if (bytes === 0) bytes = ws.bytes;
      if (sha256 === "") sha256 = ws.sha256;
      workspaceRefResolved = true;
    } else if (workspaceRef !== null && !workspaceFiles.has(workspaceRef)) {
      throw new EvalError("evidence-invalid", "candidate references a workspace member that is absent", { at: `${candidateMember}:${workspaceRef}` });
    }
    if (present) {
      const content = Buffer.from(base64, "base64");
      if (strictAddressedBytes && (content.toString("base64") !== base64 || content.byteLength !== bytes || sha256Hex(content) !== sha256)) {
        throw new EvalError("evidence-invalid", "candidate bytes disagree with their addressed identity", { at: `${candidateMember}:${path}` });
      }
    }

    files.push({
      path,
      bytes,
      sha256,
      base64,
      workspaceRef,
      workspaceRefResolved,
      present,
    });
  }

  return {
    conditionId: candRecord.conditionId as ConditionId,
    candidateMode: (candRecord.candidateMode as CandidateMode) ?? null,
    outputPath: typeof candRecord.outputPath === "string" ? candRecord.outputPath : null,
    projected: candRecord.projected === true,
    includedPaths: Array.isArray(candRecord.includedPaths) ? candRecord.includedPaths.map(String) : [],
    skipped: Array.isArray(candRecord.skipped)
      ? (candRecord.skipped as ReadonlyArray<{ path: string; reason: string }>)
      : [],
    files,
  };
}

export interface ResolvedNativeSessionResult {
  readonly available: boolean;
  readonly reason: string | null;
  readonly conditionId: ConditionId;
  readonly completed: boolean;
  readonly incompleteTail: boolean;
  readonly tailStatus: string;
  /** Full native JSONL records: actual header first when it was observed, then tree entries. */
  readonly entries: readonly unknown[];
  readonly header: unknown | null;
  readonly treeEntries: readonly unknown[];
  readonly entryCount: number;
  readonly redactions: {
    readonly count: number;
    readonly locations: readonly string[];
  };
}

export async function readNativeSession(
  receiptOrRunDir: string,
  conditionDir: string,
): Promise<ResolvedNativeSessionResult> {
  const runDir = canonicalRunDir(receiptOrRunDir);
  // Receipt-addressed public reads are chain verified. A run-directory input remains a
  // narrow legacy/internal compatibility seam; public inspection/export never uses it.
  if (resolve(receiptOrRunDir).endsWith(".json")) {
    const verification = await verifyRun(runDir);
    if (!verification.ok) throw new EvalError("evidence-invalid", "native session export refuses a broken evidence chain", { at: conditionDir });
  }
  assertSafeRelativePath(conditionDir, "conditionDir");
  const sessionPath = join(runDir, conditionDir, "session.json");

  const exists = await stat(sessionPath).then(() => true).catch(() => false);
  if (!exists) {
    return {
      available: false,
      reason: "native session is not available in schema-v1 evidence",
      conditionId: "baseline",
      completed: false,
      incompleteTail: false,
      tailStatus: "unavailable",
      entries: [],
      header: null,
      treeEntries: [],
      entryCount: 0,
      redactions: { count: 0, locations: [] },
    };
  }

  const record = (await readJsonFile(sessionPath, `${conditionDir}/session.json`)) as Record<string, unknown>;
  const entries = Array.isArray(record.entries) ? record.entries : [];
  const firstRecord = entries[0];
  const header = firstRecord && typeof firstRecord === "object" && (firstRecord as Record<string, unknown>).type === "session"
    ? firstRecord
    : null;
  const treeEntries = header === null ? entries : entries.slice(1);
  const available = record.available !== false && entries.length > 0;
  const reason = typeof record.reason === "string"
    ? record.reason
    : (!available ? (typeof record.incompleteReason === "string" ? record.incompleteReason : "native session entries unavailable for this condition") : null);
  const rawRedactions = record.redactions && typeof record.redactions === "object"
    ? record.redactions as { count?: unknown; locations?: unknown }
    : undefined;
  const redactions = {
    count: typeof rawRedactions?.count === "number" ? rawRedactions.count : 0,
    locations: Array.isArray(rawRedactions?.locations) ? rawRedactions.locations.map(String) : [],
  };
  return {
    available,
    reason,
    conditionId: (record.conditionId as ConditionId) ?? "baseline",
    completed: record.completed === true,
    incompleteTail: record.incompleteTail === true,
    tailStatus: typeof record.tailStatus === "string" ? record.tailStatus : (available ? "completed" : "unavailable"),
    entries,
    header,
    treeEntries,
    entryCount: typeof record.entryCount === "number" ? record.entryCount : entries.length,
    redactions,
  };
}

// ---------------------------------------------------------------------------
// History and derived native exports
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  readonly namespace: string;
  readonly runId: string;
  readonly runDir: string;
  readonly receiptPath: string;
  readonly state: "verified" | "incomplete" | "corrupt" | "unreadable";
  readonly status: string | null;
  readonly caseSelector: string | null;
  readonly evidenceLabel: string | null;
  readonly failures: readonly string[];
}

/**
 * @notice Enumerates retained runs from both canonical and historical namespaces without rewriting their paths.
 * @param evalsRoot Root of the evals evidence tree.
 * @returns History entries retaining the exact on-disk run and receipt paths.
 */
export async function listRunHistory(evalsRoot: string): Promise<readonly HistoryEntry[]> {
  const roots = [resolve(evalsRoot, "cases"), resolve(evalsRoot)];
  const result: HistoryEntry[] = [];
  const seenRuns = new Set<string>();
  for (const root of roots) {
    const namespaces = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const namespace of namespaces.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!namespace.isDirectory() || namespace.isSymbolicLink() || namespace.name.startsWith(".")) continue;
    if (root === resolve(evalsRoot) && namespace.name === "cases") continue;
    const runsDir = join(root, namespace.name, "runs");
    const runsStat = await lstat(runsDir).catch(() => null);
    if (runsStat === null || !runsStat.isDirectory() || runsStat.isSymbolicLink()) continue;
    const runs = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
    for (const run of runs.sort((a, b) => b.name.localeCompare(a.name))) {
      if (!run.isDirectory() || run.isSymbolicLink() || run.name.startsWith(".")) continue;
      const runDir = join(runsDir, run.name);
      if (seenRuns.has(runDir)) continue;
      seenRuns.add(runDir);
      const receiptPath = join(runDir, RECEIPT_FILE);
      let receipt: RunReceipt | null = null;
      try {
        receipt = decodeReceipt(await readJsonFile(receiptPath, RECEIPT_FILE));
      } catch (error) {
        const manifestExists = await stat(join(runDir, MANIFEST_FILE)).then((s) => s.isFile()).catch(() => false);
        result.push({ namespace: namespace.name, runId: run.name, runDir, receiptPath, state: manifestExists ? "corrupt" : "incomplete", status: null, caseSelector: null, evidenceLabel: null, failures: [error instanceof Error ? error.message : String(error)] });
        continue;
      }
      try {
        const verification = await verifyRun(runDir);
        const identityMatchesDirectory = receipt.runId === run.name;
        result.push({
          namespace: namespace.name,
          runId: run.name,
          runDir,
          receiptPath,
          state: verification.ok && identityMatchesDirectory ? "verified" : "corrupt",
          status: receipt.status,
          caseSelector: receipt.caseSelector,
          evidenceLabel: receipt.evidenceLabel,
          failures: [...verification.failures.map((failure) => failure.message), ...(identityMatchesDirectory ? [] : [`receipt runId ${receipt.runId} does not match directory ${run.name}`])],
        });
      } catch (error) {
        result.push({ namespace: namespace.name, runId: run.name, runDir, receiptPath, state: "unreadable", status: null, caseSelector: null, evidenceLabel: null, failures: [error instanceof Error ? error.message : String(error)] });
      }
    }
    }
  }
  return result;
}

export function formatRunHistory(entries: readonly HistoryEntry[], format: "table" | "json" = "table"): string {
  if (format === "json") return JSON.stringify({ schemaVersion: 1, entries }, null, 2);
  if (entries.length === 0) return "No retained evaluation runs found.";
  const lines = ["State       Namespace                 Run                                      Status      Case / exact receipt"];
  for (const entry of entries) {
    lines.push(`${entry.state.padEnd(11)} ${entry.namespace.padEnd(25)} ${entry.runId.padEnd(40)} ${(entry.status ?? "n/a").padEnd(11)} ${entry.caseSelector ?? "n/a"}`);
    lines.push(`  receipt: ${entry.receiptPath}`);
    for (const failure of entry.failures.slice(0, 2)) lines.push(`  issue:   ${failure}`);
  }
  return lines.join("\n");
}

export interface LatestRunPair {
  readonly pairId: string;
  readonly repetition: number;
}

export interface LatestRunResolution {
  readonly runId: string;
  readonly namespace: string;
  readonly runDir: string;
  readonly receiptPath: string;
  readonly caseSelector: string;
  readonly caseId: string;
  readonly skill: string;
  readonly status: string;
  readonly evidenceLabel: string;
  readonly pairs: readonly LatestRunPair[];
  readonly receipt: RunReceipt;
}

export interface ResolveLatestOptions {
  readonly caseSelector?: string | null;
}

export function parseRunTimestamp(runId: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?(?:-|$)/.exec(runId);
  if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined || match[5] === undefined || match[6] === undefined) {
    return null;
  }
  const ms = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]);
  return Number.isNaN(ms) ? null : ms;
}

export function compareRunsChronologically<T extends { readonly runId: string; readonly namespace?: string }>(
  a: T,
  b: T,
): number {
  const timeA = parseRunTimestamp(a.runId);
  const timeB = parseRunTimestamp(b.runId);
  if (timeA !== null && timeB !== null && timeA !== timeB) {
    return timeB - timeA;
  }
  if (timeA !== null && timeB === null) return -1;
  if (timeA === null && timeB !== null) return 1;
  const runCmp = b.runId.localeCompare(a.runId);
  if (runCmp !== 0) return runCmp;
  return (b.namespace ?? "").localeCompare(a.namespace ?? "");
}

export function matchesCaseSelector(
  selector: string | null,
  caseId: string | null,
  filter: string,
): boolean {
  if (!filter) return true;
  const target = filter.trim();
  if (selector !== null) {
    if (selector === target) return true;
    if (selector.endsWith(`/${target}`)) return true;
    if (target.endsWith(`/${selector}`)) return true;
  }
  if (caseId !== null) {
    if (caseId === target) return true;
    if (target.endsWith(`/${caseId}`)) return true;
  }
  return false;
}

async function resolveEntryCase(entry: HistoryEntry): Promise<{ caseSelector: string | null; caseId: string | null }> {
  if (entry.caseSelector !== null) {
    return { caseSelector: entry.caseSelector, caseId: null };
  }
  try {
    const planPath = join(entry.runDir, "inputs", "plan.json");
    const plan = (await readJsonFile(planPath, "inputs/plan.json")) as Record<string, unknown>;
    const caseSelector = typeof plan?.caseSelector === "string" ? plan.caseSelector : null;
    const caseId = typeof plan?.caseId === "string" ? plan.caseId : null;
    return { caseSelector, caseId };
  } catch {
    try {
      const casePath = join(entry.runDir, "inputs", "case.json");
      const caseData = (await readJsonFile(casePath, "inputs/case.json")) as Record<string, unknown>;
      const caseSelector = typeof caseData?.selector === "string" ? caseData.selector : null;
      const caseId = typeof caseData?.caseId === "string" ? caseData.caseId : null;
      return { caseSelector, caseId };
    } catch {
      return { caseSelector: null, caseId: null };
    }
  }
}

async function resolveSkillSetup(runDir: string, receipt: RunReceipt): Promise<string> {
  try {
    const snapshotPath = join(runDir, "inputs", "skill-snapshot.json");
    const snapshot = (await readJsonFile(snapshotPath, "inputs/skill-snapshot.json")) as Record<string, unknown>;
    if (typeof snapshot?.sourcePath === "string" && snapshot.sourcePath.length > 0) {
      return snapshot.sourcePath;
    }
  } catch {
    // Fall through
  }
  try {
    const planPath = join(runDir, "inputs", "plan.json");
    const plan = (await readJsonFile(planPath, "inputs/plan.json")) as Record<string, unknown>;
    if (typeof plan?.skillGuestPath === "string" && plan.skillGuestPath.length > 0) {
      return plan.skillGuestPath;
    }
  } catch {
    // Fall through
  }
  return receipt.suiteId;
}

export async function resolveLatestRun(
  evalsRoot: string,
  options?: ResolveLatestOptions,
): Promise<LatestRunResolution> {
  const root = resolve(evalsRoot);
  const entries = await listRunHistory(root);
  const sorted = [...entries].sort(compareRunsChronologically);

  const caseFilter = options?.caseSelector?.trim() || null;
  const candidates: HistoryEntry[] = [];
  if (caseFilter !== null) {
    for (const entry of sorted) {
      const { caseSelector, caseId } = await resolveEntryCase(entry);
      if (matchesCaseSelector(caseSelector, caseId, caseFilter)) {
        candidates.push(entry);
      }
    }
  } else {
    candidates.push(...sorted);
  }

  if (candidates.length === 0) {
    throw new EvalError(
      "input-invalid",
      caseFilter !== null ? `no matching run found for case "${caseFilter}"` : "no matching run found",
      { at: caseFilter !== null ? "--case" : "--latest" },
    );
  }

  const latest = candidates[0]!;
  const ambiguousLatest = candidates.filter((entry) => entry.runId === latest.runId);
  if (ambiguousLatest.length > 1) {
    throw new EvalError(
      "evidence-invalid",
      `the latest run ${latest.runId} is ambiguous across retained paths: ${ambiguousLatest.map((entry) => entry.receiptPath).join(", ")}`,
      { at: "--latest" },
    );
  }
  if (latest.state === "incomplete") {
    throw new EvalError("evidence-invalid", `the latest run ${latest.runId} is incomplete`, {
      at: latest.receiptPath,
    });
  }
  if (latest.state === "corrupt" || latest.state === "unreadable") {
    const failureMsg = latest.failures.length > 0 ? `: ${latest.failures.join("; ")}` : "";
    throw new EvalError("evidence-invalid", `the latest run ${latest.runId} is corrupt${failureMsg}`, {
      at: latest.receiptPath,
    });
  }

  const receipt = decodeReceipt(await readJsonFile(latest.receiptPath, RECEIPT_FILE));
  const skill = await resolveSkillSetup(latest.runDir, receipt);
  const pairs: LatestRunPair[] = receipt.pairs.map((p) => ({ pairId: p.pairId, repetition: p.repetition }));

  return {
    runId: receipt.runId,
    namespace: latest.namespace,
    runDir: latest.runDir,
    receiptPath: latest.receiptPath,
    caseSelector: receipt.caseSelector,
    caseId: receipt.caseId,
    skill,
    status: receipt.status,
    evidenceLabel: receipt.evidenceLabel,
    pairs,
    receipt,
  };
}

export function formatLatestRun(
  resolved: LatestRunResolution,
  format: "table" | "json" = "table",
): string {
  if (format === "json") {
    return JSON.stringify(
      {
        schemaVersion: 1,
        runId: resolved.runId,
        namespace: resolved.namespace,
        receiptPath: resolved.receiptPath,
        caseSelector: resolved.caseSelector,
        caseId: resolved.caseId,
        skill: resolved.skill,
        status: resolved.status,
        evidenceLabel: resolved.evidenceLabel,
        pairs: resolved.pairs,
      },
      null,
      2,
    );
  }

  const caseDisplay =
    resolved.caseSelector === resolved.caseId
      ? resolved.caseSelector
      : `${resolved.caseSelector} (${resolved.caseId})`;

  const lines = [
    `run       ${resolved.runId}`,
    `receipt   ${resolved.receiptPath}`,
    `case      ${caseDisplay}`,
    `skill     ${resolved.skill}`,
    `status    ${resolved.status}`,
    `evidence  ${resolved.evidenceLabel}`,
    "pairs",
    ...resolved.pairs.map((p) => `  - ${p.pairId} (repetition ${p.repetition})`),
  ];
  return lines.join("\n");
}

export interface NativeExportResult {
  readonly runId: string;
  readonly pairId: string;
  readonly conditionId: ConditionId;
  readonly jsonlPath: string;
  readonly htmlPath: string | null;
  readonly completed: boolean;
  readonly tailStatus: string;
  readonly redactions: number;
}

/** Writes fresh, non-authoritative views only after verifying the canonical receipt chain. */
export async function exportNativeSessionView(input: {
  readonly receiptPath: string;
  readonly conditionId: ConditionId;
  readonly pairId?: string | null;
  readonly format: "jsonl" | "html" | "both";
}): Promise<NativeExportResult> {
  const runDir = canonicalRunDir(input.receiptPath);
  const receipt = decodeReceipt(await readJsonFile(join(runDir, RECEIPT_FILE), RECEIPT_FILE));
  const verification = await verifyRun(runDir);
  if (!verification.ok) throw new EvalError("evidence-invalid", "native export refuses a broken evidence chain", { at: input.receiptPath });
  const pair = input.pairId ? receipt.pairs.find((candidate) => candidate.pairId === input.pairId) : receipt.pairs[0];
  if (!pair) throw new EvalError("input-invalid", "receipt has no selected pair", { at: "--pair" });
  const condition = pair.conditions.find((candidate) => candidate.conditionId === input.conditionId);
  if (!condition) throw new EvalError("input-invalid", `pair has no ${input.conditionId} condition`, { at: "--condition" });
  const session = await readNativeSession(join(runDir, RECEIPT_FILE), condition.dir);
  if (!session.available || session.header === null) {
    throw new EvalError("evidence-invalid", `native session is unavailable or lacks its actual header: ${session.reason ?? "unknown"}`, { at: `${condition.dir}/session.json` });
  }
  const viewsDir = join(runDir, VIEWS_DIR);
  const existing = await lstat(viewsDir).catch(() => null);
  if (existing !== null && (!existing.isDirectory() || existing.isSymbolicLink())) throw new EvalError("path-unsafe", "views path must be a real directory", { at: viewsDir });
  await mkdir(viewsDir, { recursive: true, mode: 0o755 });
  const id = `${pair.pairId}-${input.conditionId}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const jsonlPath = join(viewsDir, `${id}.jsonl`);
  const jsonlBody = `${session.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const handle = await open(jsonlPath, "wx", 0o600);
  try { await handle.writeFile(jsonlBody, "utf8"); await handle.sync(); } finally { await handle.close(); }
  let htmlPath: string | null = null;
  if (input.format !== "jsonl") {
    htmlPath = join(viewsDir, `${id}.html`);
    const temporary = join(viewsDir, `.${id}.html.tmp`);
    await exportSessionFileToHtml(jsonlPath, temporary);
    await link(temporary, htmlPath);
    await unlink(temporary);
  }
  return { runId: receipt.runId, pairId: pair.pairId, conditionId: input.conditionId, jsonlPath, htmlPath, completed: session.completed, tailStatus: session.tailStatus, redactions: session.redactions.count };
}
