/**
 * Frozen evaluated-skill snapshot.
 *
 * Only the treatment arm receives this tree, and its hash is bound to BOTH arms, so a
 * symlinked skill root, a symlinked file inside the skill, or a reused snapshot
 * directory would silently change what "the skill" means for a measured pair.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvalError } from "../core/types.ts";
import { createSkillSnapshot } from "./skill-snapshot.ts";

const created: string[] = [];

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir === undefined) continue;
    // Snapshot directories are sealed read-only; make them removable again.
    await chmod(dir, 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eval-skill-"));
  created.push(dir);
  return dir;
}

async function canSymlink(root: string): Promise<boolean> {
  try {
    await writeFile(join(root, "probe"), "x", "utf8");
    await symlink(join(root, "probe"), join(root, "probe-link"));
    await rm(join(root, "probe-link"));
    await rm(join(root, "probe"));
    return true;
  } catch {
    return false;
  }
}

async function buildSkill(repoRoot: string): Promise<void> {
  await mkdir(join(repoRoot, "skills", "example", "agents"), { recursive: true });
  await writeFile(join(repoRoot, "skills", "example", "SKILL.md"), "# skill\n", "utf8");
  await writeFile(join(repoRoot, "skills", "example", "agents", "notes.md"), "notes\n", "utf8");
}

async function expectEvalErrorAsync(promise: Promise<unknown>, code: string): Promise<EvalError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EvalError);
  expect((caught as EvalError).code).toBe(code);
  return caught as EvalError;
}

describe("createSkillSnapshot", () => {
  it("copies a skill tree read-only with a deterministic tree hash", async () => {
    const repoRoot = await tempRoot();
    await buildSkill(repoRoot);
    const first = await createSkillSnapshot({
      repoRoot,
      skillPath: "skills/example",
      snapshotDir: join(repoRoot, "snap-1"),
    });
    const second = await createSkillSnapshot({
      repoRoot,
      skillPath: "skills/example",
      snapshotDir: join(repoRoot, "snap-2"),
    });
    expect(first.files.map((file) => file.path)).toEqual(["SKILL.md", "agents/notes.md"]);
    expect(first.treeSha256).toBe(second.treeSha256);
    expect(first.totalBytes).toBeGreaterThan(0);
  });

  it("excludes the skill-root results file so published numbers never reach the agent", async () => {
    const repoRoot = await tempRoot();
    await buildSkill(repoRoot);
    const before = await createSkillSnapshot({
      repoRoot,
      skillPath: "skills/example",
      snapshotDir: join(repoRoot, "snap-before"),
    });

    // Publishing results for this skill must not change what was measured.
    await writeFile(join(repoRoot, "skills/example/EVALS.md"), "# Results\n\nscore 91/100\n");
    const after = await createSkillSnapshot({
      repoRoot,
      skillPath: "skills/example",
      snapshotDir: join(repoRoot, "snap-after"),
    });

    expect(after.files.map((file) => file.path)).toEqual(["SKILL.md", "agents/notes.md"]);
    expect(after.files.some((file) => file.path === "EVALS.md")).toBe(false);
    expect(after.treeSha256).toBe(before.treeSha256);
    expect(after.totalBytes).toBe(before.totalBytes);
    await expect(readFile(join(repoRoot, "snap-after/EVALS.md"), "utf8")).rejects.toThrow();
  });

  it("still measures a nested file that shares the excluded name", async () => {
    const repoRoot = await tempRoot();
    await buildSkill(repoRoot);
    await writeFile(join(repoRoot, "skills/example/agents/EVALS.md"), "authored reference\n");
    const snapshot = await createSkillSnapshot({
      repoRoot,
      skillPath: "skills/example",
      snapshotDir: join(repoRoot, "snap-nested"),
    });
    expect(snapshot.files.map((file) => file.path)).toContain("agents/EVALS.md");
  });

  it("refuses to reuse an existing snapshot directory", async () => {
    const repoRoot = await tempRoot();
    await buildSkill(repoRoot);
    await mkdir(join(repoRoot, "snap"));
    await expectEvalErrorAsync(
      createSkillSnapshot({ repoRoot, skillPath: "skills/example", snapshotDir: join(repoRoot, "snap") }),
      "evidence-invalid",
    );
  });

  it("rejects a symlinked skill root", async () => {
    const repoRoot = await tempRoot();
    if (!(await canSymlink(repoRoot))) return;
    await buildSkill(repoRoot);
    await symlink(join(repoRoot, "skills", "example"), join(repoRoot, "skills", "aliased"));
    await expectEvalErrorAsync(
      createSkillSnapshot({ repoRoot, skillPath: "skills/aliased", snapshotDir: join(repoRoot, "snap") }),
      "path-unsafe",
    );
  });

  it("rejects a symlinked ancestor of the skill path", async () => {
    const repoRoot = await tempRoot();
    if (!(await canSymlink(repoRoot))) return;
    await buildSkill(repoRoot);
    await symlink(join(repoRoot, "skills"), join(repoRoot, "linked-skills"));
    await expectEvalErrorAsync(
      createSkillSnapshot({ repoRoot, skillPath: "linked-skills/example", snapshotDir: join(repoRoot, "snap") }),
      "path-unsafe",
    );
  });

  it("rejects a symlinked file inside the skill", async () => {
    const repoRoot = await tempRoot();
    if (!(await canSymlink(repoRoot))) return;
    await buildSkill(repoRoot);
    await writeFile(join(repoRoot, "outside.md"), "x", "utf8");
    await symlink(join(repoRoot, "outside.md"), join(repoRoot, "skills", "example", "linked.md"));
    const error = await expectEvalErrorAsync(
      createSkillSnapshot({ repoRoot, skillPath: "skills/example", snapshotDir: join(repoRoot, "snap") }),
      "path-unsafe",
    );
    expect(error.message).toContain("symlink");
  });

  it("rejects a traversing skill path and a missing skill directory", async () => {
    const repoRoot = await tempRoot();
    await buildSkill(repoRoot);
    await expectEvalErrorAsync(
      createSkillSnapshot({ repoRoot, skillPath: "../etc", snapshotDir: join(repoRoot, "snap") }),
      "path-unsafe",
    );
    await expectEvalErrorAsync(
      createSkillSnapshot({ repoRoot, skillPath: "skills/absent", snapshotDir: join(repoRoot, "snap2") }),
      "input-invalid",
    );
  });

  it("rejects an empty skill directory", async () => {
    const repoRoot = await tempRoot();
    await mkdir(join(repoRoot, "skills", "empty"), { recursive: true });
    await expectEvalErrorAsync(
      createSkillSnapshot({ repoRoot, skillPath: "skills/empty", snapshotDir: join(repoRoot, "snap") }),
      "input-invalid",
    );
  });
});
