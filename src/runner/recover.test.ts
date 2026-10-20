/**
 * Exact-ID recovery proof.
 *
 * Recovery is the one operation that touches a run AFTER it was sealed, so the two things
 * worth proving are exactly the two prohibitions: it must not edit or delete prior
 * evidence, and it must not re-run a task. These tests hash every prior evidence file
 * before and after and require byte equality, and check that the appended record is
 * itself sealed and outside the original hash chain so `verifyRun` still passes.
 *
 * They also prove recovery acts only on journaled exact identities: a live resource that
 * this run never journaled is left completely alone.
 */

import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resourceNameFor, runIdFor, sha256Hex } from "../core/experiment.ts";
import { createFakeHarness } from "../harnesses/fake.ts";
import { createFakeSandbox } from "../sandboxes/fake.ts";
import { createRunJournal } from "../artifacts/store.ts";
import { verifyRun } from "../artifacts/queries.ts";
import { createInProcessValidatorRunner } from "./validation.ts";
import { disposeRunWorkDir, runPairedEvaluation } from "./run.ts";
import type { RunResult } from "./run.ts";
import { findRunDirectory, formatRecoveryResult, recoverRun } from "./recover.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const evalsRoot = repoRoot;

const workDirs: string[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  while (workDirs.length > 0) {
    const dir = workDirs.pop();
    if (dir !== undefined) await disposeRunWorkDir(dir);
  }
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function sealRun(): Promise<{ result: RunResult; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "eval-recover-test-"));
  tempRoots.push(root);
  const workDir = await mkdtemp(join(tmpdir(), "eval-recover-work-"));
  workDirs.push(workDir);
  const stateDir = join(root, ".state");
  const result = await runPairedEvaluation({
    evalsRoot,
    repoRoot,
    caseSelector: "network-config-01",
    skillPath: "src/test-fixtures/skills/mcp-skill",
    mode: "fake",
    repetitions: 1,
    cliLimits: {},
    target: { provider: "google", model: "fake-model-0", thinking: "off" },
    runId: runIdFor(new Date(0), "abcdef12"),
    resourceNonce: "0a1b2c3d",
    createdAt: new Date(0).toISOString(),
    source: { revision: "0".repeat(40), dirty: false },
    evaluatorBuild: "evals-src@test",
    harness: createFakeHarness(),
    sandbox: createFakeSandbox(),
    validatorRunner: createInProcessValidatorRunner(),
    workDir,
    runsRoot: join(root, "runs"),
    stateDir,
  });
  return { result, stateDir };
}

/** Hash of every file in a tree, keyed by relative path. */
async function hashTree(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const walk = async (relative: readonly string[]): Promise<void> => {
    const dir = relative.length === 0 ? root : join(root, ...relative);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const next = [...relative, entry.name];
      if (entry.isDirectory()) {
        await walk(next);
        continue;
      }
      hashes.set(next.join("/"), sha256Hex(await readFile(join(dir, entry.name))));
    }
  };
  await walk([]);
  return hashes;
}

describe("exact-ID recovery", () => {
  it("appends a recovery record and receipt without editing prior evidence", async () => {
    const { result, stateDir } = await sealRun();
    const before = await hashTree(result.runDir);
    expect(before.size).toBeGreaterThan(10);

    const recovery = await recoverRun({
      evalsRoot,
      runId: result.runId,
      runDir: result.runDir,
      stateDir,
      sandbox: createFakeSandbox(),
      recoveryId: "19700101T000100Z-11112222",
      attemptedAt: new Date(60_000).toISOString(),
    });

    const after = await hashTree(result.runDir);
    // Every file that existed before is byte-identical afterwards.
    for (const [path, hash] of before) {
      expect(after.get(path), `${path} was modified or deleted by recovery`).toBe(hash);
    }
    // Only recovery records were added.
    const added = [...after.keys()].filter((path) => !before.has(path)).sort();
    expect(added).toEqual([
      "recovery/19700101T000100Z-11112222/manifest.json",
      "recovery/19700101T000100Z-11112222/receipt.json",
      "recovery/19700101T000100Z-11112222/recovery.json",
    ]);

    // The original chain still verifies: recovery lives outside it by construction.
    expect((await verifyRun(result.runDir)).ok).toBe(true);

    const record = JSON.parse(await readFile(join(recovery.recoveryDir, "recovery.json"), "utf8")) as {
      taskReExecuted: boolean;
      priorEvidenceModified: boolean;
      resources: Array<{ kind: string; name: string; action: string; verifiedAbsent: boolean }>;
    };
    expect(record.taskReExecuted).toBe(false);
    expect(record.priorEvidenceModified).toBe(false);
    // The journal named an image, two networks, and two guests.
    expect(record.resources.length).toBeGreaterThanOrEqual(5);
    expect(record.resources.filter((resource) => resource.kind !== "image").every((resource) => resource.verifiedAbsent)).toBe(true);
    expect(record.resources.filter((resource) => resource.kind === "image").every((resource) => resource.action === "preserved-shared-image" && !resource.verifiedAbsent)).toBe(true);
    expect(recovery.ok).toBe(true);
    expect(formatRecoveryResult(recovery)).toContain("recovery  19700101T000100Z-11112222  OK");
  });

  it("refuses to overwrite an existing recovery record", async () => {
    const { result, stateDir } = await sealRun();
    const args = {
      evalsRoot,
      runId: result.runId,
      runDir: result.runDir,
      stateDir,
      sandbox: createFakeSandbox(),
      recoveryId: "19700101T000100Z-11112222",
      attemptedAt: new Date(60_000).toISOString(),
    };
    await recoverRun(args);
    await expect(recoverRun(args)).rejects.toMatchObject({ code: "evidence-invalid" });
  });

  it("destroys only journaled exact identities and leaves an unjournaled resource alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-recover-exact-"));
    tempRoots.push(root);
    const stateDir = join(root, ".state");
    const runDir = join(root, "run");
    const runId = "19700101T000000Z-abcdef12";

    const nonce = "0a1b2c3d";
    const ownedName = resourceNameFor("net", { runId, resourceNonce: nonce }, 1, "baseline");
    const sandbox = createFakeSandbox({ ownershipLabels: { "eval-run": runId } });
    const image = await sandbox.buildImage({ runtimeProfileId: "default", contextDir: join(evalsRoot, "container") });
    await sandbox.createNetwork(ownedName, {
      allowPublicDns: true,
      allowPublicTcpPorts: [443],
      denyRanges: [],
    });
    await sandbox.createNetwork("eval-net-unrelated", {
      allowPublicDns: true,
      allowPublicTcpPorts: [443],
      denyRanges: [],
    });

    // A journal that names exactly one of the two live networks.
    const journal = await createRunJournal({ stateDir, runId, nonce });
    await journal.record({
      event: "intent",
      action: "create",
      kind: "network",
      name: ownedName,
      conditionId: "baseline",
      status: null,
    });
    await journal.record({
      event: "observed",
      action: "create",
      kind: "network",
      name: ownedName,
      conditionId: "baseline",
      status: "created",
    });

    const recovery = await recoverRun({
      evalsRoot,
      runId,
      runDir,
      stateDir,
      sandbox,
      recoveryId: "19700101T000100Z-11112222",
      attemptedAt: new Date(60_000).toISOString(),
    });

    expect(recovery.ok).toBe(true);
    expect(recovery.resources).toHaveLength(1);
    expect(recovery.resources[0]).toMatchObject({
      kind: "network",
      name: ownedName,
      presenceBefore: "present",
      action: "destroyed",
      verifiedAbsent: true,
    });
    // The unjournaled network and the image were never touched: no scan happened.
    expect(sandbox.live.networks).toEqual(["eval-net-unrelated"]);
    expect(await sandbox.inspectResource("image", image.digest)).toBe("present");
  });

  it("refuses a journaled collision whose exact live object has foreign ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-recover-foreign-"));
    tempRoots.push(root);
    const stateDir = join(root, ".state");
    const runDir = join(root, "run");
    const runId = "19700101T000000Z-feedface";
    const nonce = "0a1b2c3d";
    const name = resourceNameFor("net", { runId, resourceNonce: nonce }, 1, "baseline");
    const sandbox = createFakeSandbox({ ownershipLabels: { "eval-run": "someone-else" } });
    await sandbox.createNetwork(name, { allowPublicDns: true, allowPublicTcpPorts: [443], denyRanges: [] });
    const journal = await createRunJournal({ stateDir, runId, nonce });
    await journal.record({ event: "intent", action: "create", kind: "network", name, conditionId: "baseline", status: null });
    const recovery = await recoverRun({ evalsRoot, runId, runDir, stateDir, sandbox, recoveryId: "19700101T000100Z-11112222", attemptedAt: new Date(60_000).toISOString() });
    expect(recovery.ok).toBe(false);
    expect(recovery.resources[0]).toMatchObject({ action: "failed", presenceBefore: "present", verifiedAbsent: false });
    expect(await sandbox.inspectResource("network", name)).toBe("present");
  });

  it("reports a missing journal as an evidence defect rather than a clean recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-recover-nojournal-"));
    tempRoots.push(root);
    await expect(
      recoverRun({
        evalsRoot,
        runId: "19700101T000000Z-deadbeef",
        runDir: join(root, "run"),
        stateDir: join(root, ".state"),
        sandbox: createFakeSandbox(),
        recoveryId: "19700101T000100Z-11112222",
        attemptedAt: new Date(60_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "evidence-invalid" });
  });

  it("discovers historical runs and rejects ambiguous identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-recover-layouts-"));
    tempRoots.push(root);
    await mkdir(join(root, "eval-cases", "skill-a", "new-case", "runs", "new-run"), { recursive: true });
    await mkdir(join(root, "old-case", "runs", "old-run"), { recursive: true });
    await mkdir(join(root, "eval-cases", "skill-a", "new-case", "runs", "same-run"), { recursive: true });
    await mkdir(join(root, "old-case", "runs", "same-run"), { recursive: true });
    await expect(findRunDirectory(root, "new-run")).resolves.toBe(join(root, "eval-cases", "skill-a", "new-case", "runs", "new-run"));
    await expect(findRunDirectory(root, "old-run")).resolves.toBe(join(root, "old-case", "runs", "old-run"));
    await expect(findRunDirectory(root, "same-run")).rejects.toThrow(/ambiguous/);
  });

  it("refuses an unsafe or unknown run id instead of scanning for a match", async () => {
    await expect(findRunDirectory(evalsRoot, "../../etc")).rejects.toMatchObject({ code: "path-unsafe" });
    await expect(findRunDirectory(evalsRoot, "19700101T000000Z-nosuchrun")).rejects.toMatchObject({
      code: "input-invalid",
    });
  });
});
