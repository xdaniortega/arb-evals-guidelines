/**
 * Evaluator-owned scratch snapshot of all frozen inputs.
 *
 * This module ensures that every recorded identity describes the exact bytes used
 * in execution and grading. All inputs — prompt, case configuration, fixture, skill,
 * oracle, validator and local validator dependencies — are resolved once, written to
 * evaluator-owned scratch state, and sealed read-only.
 *
 * Crucially, after freeze:
 * 1. Staging and execution read only from this scratch state.
 * 2. Grading uses the frozen validator bytes in this scratch state.
 * 3. Editing or deleting source files after freeze cannot change staged inputs or grades.
 * 4. The snapshot bytes can reproduce their hashes without the original checkout.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  assertSafeRelativePath,
  buildManifestTree,
  canonicalJson,
  canonicalJsonSha256,
  sha256Hex,
} from "../core/experiment.ts";
import type { ManifestEntry, ManifestTree } from "../core/experiment.ts";
import { EvalError, SCHEMA_VERSION } from "../core/types.ts";
import type { FrozenCase, FrozenFile } from "./case-loader.ts";
import type { SkillSnapshot } from "./skill-snapshot.ts";

export interface FrozenInputSnapshot {
  readonly snapshotDir: string;
  readonly validatorPath: string;
  readonly validatorEntryPath: string;
  readonly validatorSource: string;
  readonly manifest: ManifestTree;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface ValidatorDependency {
  readonly path: string;
  readonly bytes: Buffer;
}

/**
 * Writes all frozen input bytes into evaluator-owned scratch state and seals them.
 */
export async function createFrozenInputSnapshot(input: {
  readonly targetDir: string;
  readonly frozen: FrozenCase;
  readonly snapshot: SkillSnapshot;
  readonly validatorDependencies?: readonly ValidatorDependency[];
}): Promise<FrozenInputSnapshot> {
  const { targetDir, frozen, snapshot } = input;
  await mkdir(targetDir, { recursive: true, mode: 0o700 });

  const entries: ManifestEntry[] = [];
  let totalBytes = 0;

  async function writeSnapshotFile(relPath: string, bytes: Buffer): Promise<void> {
    const safeRel = assertSafeRelativePath(relPath, "snapshot path");
    const fullPath = join(targetDir, safeRel);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, bytes, { mode: 0o444 });
    const fileBytes = bytes.byteLength;
    const sha256 = sha256Hex(bytes);
    entries.push({ path: safeRel, sha256, bytes: fileBytes });
    totalBytes += fileBytes;
  }

  // 1. Prompt
  const promptBytes = Buffer.from(frozen.config.prompt, "utf8");
  await writeSnapshotFile("case/prompt.txt", promptBytes);

  // 2. Case configuration (canonical JSON)
  const caseConfigBytes = Buffer.from(canonicalJson(frozen.config, "case.config"), "utf8");
  await writeSnapshotFile("case/case.json", caseConfigBytes);

  // 3. Oracle bytes
  await writeSnapshotFile("case/oracle.json", frozen.oracleBytes);

  // 4. Validator files
  if (frozen.validatorBundle !== undefined) {
    for (const file of frozen.validatorBundle) {
      const content = Buffer.from(file.base64, "base64");
      await writeSnapshotFile(`case/validator/${file.path}`, content);
    }
  } else {
    const validatorRelName = basename(frozen.config.validator);
    const validatorRelPath = `case/validator/${validatorRelName}`;
    await writeSnapshotFile(validatorRelPath, frozen.validatorBytes);
  }
  const entryRelPath = frozen.validatorEntryPath ?? basename(frozen.config.validator);
  const scratchValidatorPath = join(targetDir, "case/validator", entryRelPath);

  // 5. Validator dependencies (legacy seam preserved)
  if (input.validatorDependencies !== undefined) {
    for (const dep of input.validatorDependencies) {
      await writeSnapshotFile(`case/validator-deps/${dep.path}`, dep.bytes);
    }
  }

  // 6. Fixture files (with actual bytes)
  for (const file of frozen.fixtureFiles) {
    const content = Buffer.from(file.base64, "base64");
    await writeSnapshotFile(`fixture/${file.path}`, content);
  }

  // 7. Skill files (with actual bytes)
  for (const file of snapshot.files) {
    const filePath = join(snapshot.snapshotDir, ...file.path.split("/"));
    const content = await readFile(filePath);
    await writeSnapshotFile(`skill/${file.path}`, content);
  }

  // 8. Preparation provenance, if present
  if (frozen.preparationProvenance !== null) {
    const provBytes = Buffer.from(canonicalJson(frozen.preparationProvenance, "preparationProvenance"), "utf8");
    await writeSnapshotFile("provenance.json", provBytes);
  }

  // Build manifest tree and write manifest.json
  const manifest = buildManifestTree(entries);
  const manifestBytes = Buffer.from(
    canonicalJson({
      schemaVersion: SCHEMA_VERSION,
      treeSha256: manifest.treeSha256,
      entries: manifest.entries,
    }),
    "utf8",
  );
  await writeFile(join(targetDir, "manifest.json"), manifestBytes, { mode: 0o444 });

  return {
    snapshotDir: targetDir,
    validatorPath: scratchValidatorPath,
    validatorEntryPath: entryRelPath,
    validatorSource: frozen.validatorBytes.toString("utf8"),
    manifest,
    fileCount: entries.length,
    totalBytes,
  };
}

/**
 * Reads all files from the scratch snapshot without touching the original checkout
 * and proves they reproduce every recorded hash.
 */
export async function verifyFrozenInputSnapshot(snapshotDir: string): Promise<{
  readonly ok: boolean;
  readonly fileCount: number;
  readonly treeSha256: string;
}> {
  const manifestRaw = await readFile(join(snapshotDir, "manifest.json"), "utf8").catch((cause: unknown) => {
    throw new EvalError("evidence-invalid", `cannot read snapshot manifest at ${snapshotDir}`, { cause });
  });
  const parsed = JSON.parse(manifestRaw) as {
    schemaVersion?: unknown;
    treeSha256?: unknown;
    entries?: readonly ManifestEntry[];
  };
  if (!Array.isArray(parsed.entries)) {
    throw new EvalError("evidence-invalid", "snapshot manifest entries must be an array");
  }

  const verifiedEntries: ManifestEntry[] = [];
  for (const entry of parsed.entries) {
    const filePath = join(snapshotDir, entry.path);
    const bytes = await readFile(filePath).catch((cause: unknown) => {
      throw new EvalError("evidence-invalid", `snapshot file missing or unreadable: ${entry.path}`, { cause });
    });
    const actualSha256 = sha256Hex(bytes);
    if (actualSha256 !== entry.sha256) {
      throw new EvalError(
        "evidence-invalid",
        `snapshot file ${entry.path} sha256 mismatch (expected ${entry.sha256}, found ${actualSha256})`,
      );
    }
    if (bytes.byteLength !== entry.bytes) {
      throw new EvalError(
        "evidence-invalid",
        `snapshot file ${entry.path} size mismatch (expected ${entry.bytes}, found ${bytes.byteLength})`,
      );
    }
    verifiedEntries.push({ path: entry.path, sha256: actualSha256, bytes: bytes.byteLength });
  }

  const verifiedTree = buildManifestTree(verifiedEntries);
  if (verifiedTree.treeSha256 !== parsed.treeSha256) {
    throw new EvalError(
      "evidence-invalid",
      `snapshot tree hash mismatch (expected ${parsed.treeSha256}, computed ${verifiedTree.treeSha256})`,
    );
  }

  return {
    ok: true,
    fileCount: verifiedEntries.length,
    treeSha256: verifiedTree.treeSha256,
  };
}
