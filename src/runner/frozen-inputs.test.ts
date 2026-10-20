/**
 * Tests for Frozen Inputs and Scratch Snapshot (Item 4).
 *
 * Requirements:
 * - Every recorded identity describes the exact bytes used in execution/grading
 * - Snapshot written to evaluator-owned scratch state
 * - Editing or deleting source files after freeze cannot change staged inputs or grades
 * - Container validator uses frozen bytes, not rereading mutable source
 * - Frozen scratch-snapshot bytes reproduce their hashes without the original checkout
 */

import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freezeCase, loadFrozenCase } from "./case-loader.ts";
import { createSkillSnapshot } from "./skill-snapshot.ts";
import { createFrozenInputSnapshot, verifyFrozenInputSnapshot } from "./frozen-inputs.ts";
import { createInProcessValidatorRunner } from "./validation.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  tempRoots.length = 0;
});

async function createCaseAndSkill(root: string): Promise<{
  evalsRoot: string;
  repoRoot: string;
  suiteId: string;
  caseSelector: string;
  validatorPath: string;
}> {
  const evalsRoot = join(root, "evals");
  const repoRoot = root;
  const suiteId = "freeze-suite";
  const caseSelector = "freeze-case";

  const caseDir = join(evalsRoot, suiteId, "cases", caseSelector);
  await mkdir(join(caseDir, "fixture"), { recursive: true });

  await writeFile(
    join(evalsRoot, suiteId, "eval.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: suiteId,
      skillPath: "skills/freeze-skill",
      runtimeProfileId: "default",
      limits: {},
    }),
  );

  const validatorPath = join(caseDir, "validator.ts");
  await writeFile(
    validatorPath,
    "export function validateSnapshot() { return { status: 'graded', score: 0.99, fullPass: true, checks: [{ id: 'frozen-check', passed: true, message: 'original-frozen-validator' }] }; }",
  );

  await writeFile(
    join(caseDir, "case.json"),
    JSON.stringify({
      id: caseSelector,
      version: 1,
      prompt: "Original frozen prompt",
      outputPath: "out.json",
      allowedTools: ["read"],
      validator: "validator.ts",
      runtimeProfileId: null,
      limits: {},
      fixtureDir: "fixture",
      oracle: "oracle.json",
    }),
  );

  await writeFile(join(caseDir, "fixture", "data.json"), '{"key":"original-fixture"}');
  await writeFile(join(caseDir, "oracle.json"), '{"answer":"original-oracle"}');

  const skillDir = join(repoRoot, "skills", "freeze-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "# Original skill instructions");

  await mkdir(join(root, "work"), { recursive: true });

  return { evalsRoot, repoRoot, suiteId, caseSelector, validatorPath };
}

describe("Frozen Inputs and Scratch State Integrity", () => {
  it("creates a complete bounded input snapshot in evaluator-owned scratch state", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-frozen-snapshot-"));
    tempRoots.push(root);

    const setup = await createCaseAndSkill(root);
    const frozen = await loadFrozenCase({
      evalsRoot: setup.evalsRoot,
      suiteId: setup.suiteId,
      caseSelector: setup.caseSelector,
    });

    const snapshotDir = join(root, "work", "skill-snapshot");
    const snapshot = await createSkillSnapshot({
      repoRoot: setup.repoRoot,
      skillPath: "skills/freeze-skill",
      snapshotDir,
    });

    const scratchTarget = join(root, "work", "frozen-inputs");
    const frozenSnapshot = await createFrozenInputSnapshot({
      targetDir: scratchTarget,
      frozen,
      snapshot,
    });

    expect(frozenSnapshot.fileCount).toBeGreaterThanOrEqual(5);
    expect(frozenSnapshot.manifest.entries.some((e) => e.path === "case/prompt.txt")).toBe(true);
    expect(frozenSnapshot.manifest.entries.some((e) => e.path === "case/oracle.json")).toBe(true);
    expect(frozenSnapshot.manifest.entries.some((e) => e.path.startsWith("case/validator/"))).toBe(true);
    expect(frozenSnapshot.manifest.entries.some((e) => e.path === "fixture/data.json")).toBe(true);
    expect(frozenSnapshot.manifest.entries.some((e) => e.path === "skill/SKILL.md")).toBe(true);
  });

  it("reproduces all hashes from scratch-snapshot bytes without requiring original checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-reproduce-hashes-"));
    tempRoots.push(root);

    const setup = await createCaseAndSkill(root);
    const frozen = await loadFrozenCase({
      evalsRoot: setup.evalsRoot,
      suiteId: setup.suiteId,
      caseSelector: setup.caseSelector,
    });

    const snapshot = await createSkillSnapshot({
      repoRoot: setup.repoRoot,
      skillPath: "skills/freeze-skill",
      snapshotDir: join(root, "work", "skill-snapshot"),
    });

    const scratchTarget = join(root, "work", "frozen-inputs");
    const frozenSnapshot = await createFrozenInputSnapshot({
      targetDir: scratchTarget,
      frozen,
      snapshot,
    });

    // Verify scratch snapshot directly
    const verification = await verifyFrozenInputSnapshot(scratchTarget);
    expect(verification.ok).toBe(true);
    expect(verification.treeSha256).toBe(frozenSnapshot.manifest.treeSha256);
  });

  it("proves editing or deleting source files after freeze cannot change staged inputs or grades", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-tamper-after-freeze-"));
    tempRoots.push(root);

    const setup = await createCaseAndSkill(root);
    const frozen = await loadFrozenCase({
      evalsRoot: setup.evalsRoot,
      suiteId: setup.suiteId,
      caseSelector: setup.caseSelector,
    });

    const snapshot = await createSkillSnapshot({
      repoRoot: setup.repoRoot,
      skillPath: "skills/freeze-skill",
      snapshotDir: join(root, "work", "skill-snapshot"),
    });

    const scratchTarget = join(root, "work", "frozen-inputs");
    const frozenSnapshot = await createFrozenInputSnapshot({
      targetDir: scratchTarget,
      frozen,
      snapshot,
    });

    // NOW: mutate and delete original source files!
    // 1. Delete original validator file entirely
    await unlink(setup.validatorPath);
    // 2. Mutate fixture on disk
    await writeFile(join(setup.evalsRoot, setup.suiteId, "cases", setup.caseSelector, "fixture", "data.json"), '{"key":"MUTATED"}');
    // 3. Mutate oracle on disk
    await writeFile(join(setup.evalsRoot, setup.suiteId, "cases", setup.caseSelector, "oracle.json"), '{"answer":"MUTATED"}');

    // Run validator against frozen snapshot path / frozen bytes
    const runner = createInProcessValidatorRunner();
    const result = await runner.run({
      validatorPath: frozenSnapshot.validatorPath,
      validatorSource: frozenSnapshot.validatorSource,
      input: {
        outputPath: "out.json",
        fixtureFiles: { "data.json": Buffer.from('{"key":"original-fixture"}').toString("base64") },
        candidateFiles: { "out.json": Buffer.from("{}").toString("base64") },
        oracle: frozen.oracle,
      },
    });

    // Grading STILL succeeds using frozen bytes, even though original validator.ts was deleted!
    expect(result.outcome.status).toBe("graded");
    expect(result.outcome.score).toBe(0.99);
    expect(result.outcome.checks[0]?.message).toBe("original-frozen-validator");

    // And scratch snapshot verification still succeeds because scratch state is isolated!
    const verification = await verifyFrozenInputSnapshot(scratchTarget);
    expect(verification.ok).toBe(true);
  });
});
