/** Strict retained-input resolver for fresh reproduction. Never consults suite/case/skill sources. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalJsonSha256, sha256Hex } from "../core/experiment.ts";
import type { ParityBinding, Target } from "../core/experiment.ts";
import { EvalError, LIMIT_KEYS, decodePartialLimits, decodeRetainedCaseConfig } from "../core/types.ts";
import type { SkillToolBundle } from "../core/skill-tools.ts";
import type { CandidateMode, Limits, RunMode } from "../core/types.ts";
import { readFrozenInputs } from "../artifacts/queries.ts";
import type { FrozenCase, FrozenFile } from "./case-loader.ts";
import type { SkillSnapshot } from "./skill-snapshot.ts";
import { validatorClosureHash } from "./case-loader.ts";
import { validateTargetConfiguration } from "./models.ts";
import { validateSkillToolBundle } from "./skill-tool-manifest.ts";

export interface RetainedImageIdentity { readonly reference: string; readonly digest: string; readonly runtimeProfileId: string; readonly testDouble: boolean }
export interface RetainedRunInputs {
  readonly sourceReceiptPath: string;
  readonly sourceRunId: string;
  readonly frozen: FrozenCase;
  readonly snapshot: SkillSnapshot;
  readonly limits: Limits;
  readonly limitProvenance: Readonly<Record<string, string>>;
  readonly target: Target;
  readonly mode: RunMode;
  readonly harnessId: string;
  readonly sandboxId: string;
  readonly validatorRunnerId: string;
  readonly schedulingPolicy: "serial" | "overlap";
  readonly repetitions: number;
  readonly image: RetainedImageIdentity;
  readonly testDouble: boolean;
  readonly policyHashes: { readonly network: string; readonly guest: string; readonly execution: string };
  readonly skillToolBundle: SkillToolBundle;
}

function object(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new EvalError("evidence-invalid", `${at} must be an object`, { at });
  return value as Record<string, unknown>;
}

export async function resolveRetainedRunInputs(receiptPath: string, snapshotDir: string): Promise<RetainedRunInputs> {
  const canonical = resolve(receiptPath);
  if (!canonical.endsWith("/receipt.json")) throw new EvalError("evidence-invalid", "--from requires the canonical receipt.json", { at: "--from" });
  const retained = await readFrozenInputs(canonical);
  if (!retained.available || retained.prompt === null || retained.oracleBytes === null || retained.validatorSource === null || retained.caseConfig === null || retained.policy === null) {
    throw new EvalError("not-implemented", `receipt cannot reproduce: ${retained.reason ?? "complete retained inputs unavailable"}`, { at: "--from" });
  }
  const runDir = dirname(canonical);
  const readJson = async (path: string): Promise<Record<string, unknown>> => object(JSON.parse(await (await import("node:fs/promises")).readFile(join(runDir, path), "utf8")), path);
  const receipt = await readJson("receipt.json");
  const targetRecord = await readJson("inputs/target.json");
  const plan = await readJson("inputs/plan.json");
  const skillRecord = await readJson("inputs/skill-snapshot.json");
  const policy = retained.policy;
  const execution = object(policy.execution, "inputs/policy.json.execution");
  const image = object(targetRecord.image, "inputs/target.json.image");
  // Retained evidence keeps its own recorded collection policy. A snapshot whose case
  // configuration predates the field recovers the mode from this run's execution policy,
  // which the parity hash comparison below independently verifies; it never inherits the
  // fresh-run default. A contradiction between the two records is refused.
  let recordedCandidateMode: CandidateMode | null = null;
  if (execution.candidateMode !== undefined) {
    if (execution.candidateMode !== "file" && execution.candidateMode !== "workspace") {
      throw new EvalError("evidence-invalid", "retained execution policy records an unsupported candidate mode", { at: "inputs/policy.json.execution.candidateMode" });
    }
    recordedCandidateMode = execution.candidateMode;
  }
  const config = decodeRetainedCaseConfig(retained.caseConfig, "retained case configuration", { recordedCandidateMode });
  if (retained.prompt !== config.prompt) throw new EvalError("evidence-invalid", "retained prompt differs from retained case configuration", { at: "inputs/frozen/case/case.json" });

  const validatorEntry = config.validator;
  const validatorFiles: FrozenFile[] = [];
  const manifest = object(JSON.parse(await (await import("node:fs/promises")).readFile(join(runDir, "inputs/frozen/manifest.json"), "utf8")), "frozen manifest");
  for (const raw of manifest.entries as Array<Record<string, unknown>>) {
    const path = String(raw.path);
    if (!path.startsWith("case/validator/")) continue;
    const relative = path.slice("case/validator/".length);
    const bytes = await (await import("node:fs/promises")).readFile(join(runDir, "inputs/frozen", path));
    validatorFiles.push({ path: relative, bytes: bytes.byteLength, sha256: sha256Hex(bytes), base64: bytes.toString("base64") });
  }
  validatorFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const entry = validatorFiles.find((file) => file.path === validatorEntry);
  if (!entry) throw new EvalError("evidence-invalid", `retained validator entry is absent: ${validatorEntry}`, { at: validatorEntry });
  const caseSummary = await readJson("inputs/case.json");
  const closure = validatorClosureHash(validatorEntry, validatorFiles);
  const requiredCaseHashes = ["promptSha256", "fixtureTreeSha256", "oracleSha256", "validatorSha256", "validatorClosureSha256"] as const;
  if (requiredCaseHashes.some((key) => typeof caseSummary[key] !== "string" || caseSummary[key] === "")) {
    throw new EvalError("evidence-invalid", "retained case summary omits a required content hash", { at: "inputs/case.json" });
  }
  if (caseSummary.validatorClosureSha256 !== closure || caseSummary.validatorSha256 !== entry.sha256) throw new EvalError("evidence-invalid", "retained validator closure disagrees with case summary", { at: "inputs/case.json" });

  await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
  for (const file of retained.skillFiles) {
    const target = join(snapshotDir, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes, { flag: "wx", mode: 0o444 });
  }
  const skillFiles = retained.skillFiles.map((file) => ({ path: file.path, bytes: file.bytes.byteLength, sha256: sha256Hex(file.bytes) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const treeSha256 = canonicalJsonSha256(skillFiles);
  if (skillRecord.treeSha256 !== treeSha256) throw new EvalError("evidence-invalid", "retained skill bytes do not match snapshot identity", { at: "inputs/skill-snapshot.json" });

  // Receipts sealed before the skill-declared tool bundle became a frozen input cannot be
  // reproduced: their parity binding lacks the field, and inventing an empty bundle would
  // claim a declaration the original run never froze. Refuse with a named reason instead of
  // surfacing a raw ENOENT.
  const rawBundleRecord = await readJson("inputs/skill-tool-bundle.json").catch((cause: unknown) => {
    throw new EvalError(
      "evidence-invalid",
      "this receipt has no frozen skill-tool-bundle input and predates skill-bundle parity, so it cannot be reproduced; report and inspect it instead",
      { at: "inputs/skill-tool-bundle.json", cause },
    );
  });
  let toolBundleRecord: SkillToolBundle;
  try {
    toolBundleRecord = validateSkillToolBundle(rawBundleRecord, "inputs/skill-tool-bundle.json");
  } catch (cause) {
    throw new EvalError(
      "evidence-invalid",
      `retained skill-tool-bundle is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
      { at: "inputs/skill-tool-bundle.json", cause },
    );
  }
  const skillToolBundleSha256 = canonicalJsonSha256(toolBundleRecord);

  let oracle: unknown;
  try { oracle = JSON.parse(retained.oracleBytes.toString("utf8")); } catch (cause) { throw new EvalError("evidence-invalid", "retained oracle is not JSON", { at: "inputs/frozen/case/oracle.json", cause }); }
  const fixtureFiles = retained.fixtureFiles.map((file) => ({ path: file.path, bytes: file.bytes.byteLength, sha256: sha256Hex(file.bytes), base64: file.bytes.toString("base64") }));
  const runtimeProfileId = String(policy.runtimeProfileId ?? "");
  if (!runtimeProfileId || image.runtimeProfileId !== runtimeProfileId || plan.parity === undefined) throw new EvalError("evidence-invalid", "retained runtime profile/image plan is incomplete", { at: "inputs/policy.json" });
  const parity = object(plan.parity, "inputs/plan.json.parity");
  const network = object(policy.network, "inputs/policy.json.network");
  const guest = object(policy.guest, "inputs/policy.json.guest");
  if (parity.networkPolicySha256 !== canonicalJsonSha256(network) || parity.guestPolicySha256 !== canonicalJsonSha256(guest) || parity.executionPolicySha256 !== canonicalJsonSha256(execution)) throw new EvalError("evidence-invalid", "retained policy hashes do not match the frozen plan", { at: "inputs/policy.json" });

  const mode = String(targetRecord.mode) as RunMode;
  if (mode !== "fake" && mode !== "measured") throw new EvalError("evidence-invalid", "retained mode is invalid", { at: "inputs/target.json.mode" });
  const parityTarget = object(parity.target, "inputs/plan.json.parity.target");
  const schedule = Array.isArray(plan.schedule) ? plan.schedule : [];
  const repetitions = Number(plan.repetitions);
  if (!Number.isSafeInteger(repetitions) || repetitions <= 0 || schedule.length !== repetitions * 2) throw new EvalError("evidence-invalid", "retained schedule is incomplete", { at: "inputs/plan.json.schedule" });

  const target: Target = { provider: String(targetRecord.provider) as any, model: String(targetRecord.model), thinking: String(targetRecord.thinking) as any };
  if (targetRecord.harnessId === "pi" || mode === "measured") validateTargetConfiguration(target);
  const limits = decodePartialLimits(policy.limits, "inputs/policy.json.limits");
  if (LIMIT_KEYS.some((key) => limits[key] === undefined)) throw new EvalError("evidence-invalid", "retained limits are incomplete", { at: "inputs/policy.json.limits" });

  // The plan is redundant by design. Reconstruct every execution binding from the
  // independently retained bytes/records, then require exact equality. A consistently
  // re-sealed snapshot with one contradictory record must never reach dispatch.
  const reconstructedParity: ParityBinding = {
    promptSha256: sha256Hex(retained.prompt),
    fixtureTreeSha256: canonicalJsonSha256(fixtureFiles.map(({ path, bytes, sha256 }) => ({ path, sha256, bytes })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    outputPath: config.outputPath,
    oracleSha256: sha256Hex(retained.oracleBytes),
    validatorSha256: entry.sha256,
    validatorClosureSha256: closure,
    allowedTools: [...config.allowedTools],
    harnessId: String(targetRecord.harnessId),
    sandboxId: String(targetRecord.sandboxId),
    validatorRunnerId: String(targetRecord.validatorRunnerId),
    runtimeProfileId: runtimeProfileId as ParityBinding["runtimeProfileId"],
    imageDigest: String(image.digest),
    target,
    limits: limits as Limits,
    networkPolicySha256: canonicalJsonSha256(network),
    guestPolicySha256: canonicalJsonSha256(guest),
    workspaceRoot: "/work",
    executionPolicySha256: canonicalJsonSha256(execution),
    caseId: config.id,
    caseVersion: config.version,
    skillSnapshotTreeSha256: treeSha256,
    skillToolBundleSha256,
    candidateMode: config.candidateMode,
  };
  const conditions = Array.isArray(plan.conditions) ? plan.conditions : [];
  const conditionParities = conditions.map((condition, index) => object(object(condition, `inputs/plan.json.conditions[${index}]`).parity, `inputs/plan.json.conditions[${index}].parity`));
  const identitiesAgree = receipt.runId === plan.runId && receipt.suiteId === plan.suiteId && receipt.caseSelector === plan.caseSelector &&
    receipt.mode === mode && plan.mode === mode && plan.caseId === config.id && plan.caseVersion === config.version &&
    targetRecord.testDouble === receipt.testDouble && image.runtimeProfileId === runtimeProfileId && typeof image.testDouble === "boolean";
  if (!identitiesAgree || canonicalJsonSha256(parityTarget) !== canonicalJsonSha256(target) ||
      canonicalJsonSha256(parity) !== canonicalJsonSha256(reconstructedParity) ||
      conditionParities.length !== 2 || conditionParities.some((binding) => canonicalJsonSha256(binding) !== canonicalJsonSha256(reconstructedParity))) {
    throw new EvalError("evidence-invalid", "retained execution binding contradicts the frozen bytes or identity records", { at: "inputs/plan.json.parity" });
  }
  if (caseSummary.promptSha256 !== reconstructedParity.promptSha256 || caseSummary.fixtureTreeSha256 !== reconstructedParity.fixtureTreeSha256 ||
      caseSummary.oracleSha256 !== reconstructedParity.oracleSha256 || caseSummary.validatorSha256 !== reconstructedParity.validatorSha256 ||
      caseSummary.validatorClosureSha256 !== reconstructedParity.validatorClosureSha256 || caseSummary.outputPath !== config.outputPath ||
      caseSummary.caseId !== config.id || caseSummary.caseVersion !== config.version ||
      canonicalJsonSha256(caseSummary.allowedTools) !== canonicalJsonSha256(config.allowedTools) || caseSummary.candidateMode !== config.candidateMode) {
    throw new EvalError("evidence-invalid", "retained case summary contradicts the frozen case", { at: "inputs/case.json" });
  }
  const snapshot: SkillSnapshot = { sourcePath: String(skillRecord.sourcePath ?? "retained"), snapshotDir, files: skillFiles, totalBytes: skillFiles.reduce((n, f) => n + f.bytes, 0), treeSha256 };
  const frozen: FrozenCase = {
    suite: { schemaVersion: 1, id: String(receipt.suiteId), skillPath: String(skillRecord.sourcePath ?? "retained"), runtimeProfileId, limits: {} },
    suiteDir: resolve(runDir, "..", ".."), selector: String(receipt.caseSelector), caseDir: join(runDir, "inputs/frozen/case"), config,
    promptSha256: sha256Hex(retained.prompt), fixtureFiles, fixtureTreeSha256: String(caseSummary.fixtureTreeSha256), oracle, oracleSha256: sha256Hex(retained.oracleBytes), oracleBytes: retained.oracleBytes,
    validatorPath: join(runDir, "inputs/frozen/case/validator", validatorEntry), validatorEntryPath: validatorEntry, validatorSha256: entry.sha256, validatorBytes: Buffer.from(entry.base64, "base64"), validatorBundle: validatorFiles, validatorClosureSha256: closure, runtimeProfileId: runtimeProfileId as any, preparationProvenance: retained.provenance,
  };
  return {
    sourceReceiptPath: canonical, sourceRunId: String(receipt.runId), frozen, snapshot,
    limits: limits as Limits,
    limitProvenance: object(policy.limitProvenance, "inputs/policy.json.limitProvenance") as Readonly<Record<string, string>>,
    target, mode,
    harnessId: String(targetRecord.harnessId), sandboxId: String(targetRecord.sandboxId), validatorRunnerId: String(targetRecord.validatorRunnerId),
    schedulingPolicy: execution.schedulingPolicy === "serial" ? "serial" : "overlap", repetitions,
    image: { reference: String(image.reference), digest: String(image.digest), runtimeProfileId, testDouble: image.testDouble === true },
    testDouble: targetRecord.testDouble === true,
    policyHashes: { network: String(parity.networkPolicySha256), guest: String(parity.guestPolicySha256), execution: String(parity.executionPolicySha256) },
    skillToolBundle: toolBundleRecord,
  };
}
