import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvalError } from "../core/types.ts";
import { formatRunHistory, listRunHistory } from "./queries.ts";
import { findRunDirectory } from "../runner/recover.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("eval history discovery", () => {
  it("supports historical-only roots with no canonical cases directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-history-legacy-")); roots.push(root);
    const runDir = join(root, "old-case", "runs", "old-run");
    await mkdir(runDir, { recursive: true });
    expect((await listRunHistory(root)).map((entry) => entry.runDir)).toEqual([runDir]);
    expect(await findRunDirectory(root, "old-run")).toBe(runDir);
  });

  it("rejects a non-directory canonical root with path-unsafe", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-history-invalid-")); roots.push(root);
    await writeFile(join(root, "eval-cases"), "not a directory");
    await expect(listRunHistory(root)).rejects.toMatchObject({ code: "path-unsafe" });
    await expect(findRunDirectory(root, "old-run")).rejects.toMatchObject({ code: "path-unsafe" });
  });

  it("rejects canonical directory symlinks, including dangling links", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-history-links-")); roots.push(root);
    const target = await mkdtemp(join(tmpdir(), "eval-history-target-")); roots.push(target);
    await mkdir(join(target, "new-case", "runs", "new-run"), { recursive: true });
    for (const dangling of [false, true]) {
      await symlink(dangling ? join(root, "missing") : target, join(root, "eval-cases"));
      await expect(listRunHistory(root)).rejects.toBeInstanceOf(EvalError);
      await expect(listRunHistory(root)).rejects.toMatchObject({ code: "path-unsafe" });
      await expect(findRunDirectory(root, "new-run")).rejects.toMatchObject({ code: "path-unsafe" });
      await rm(join(root, "eval-cases"), { force: true });
    }
  });

  it("enumerates canonical and historical run namespaces without changing paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-history-layouts-")); roots.push(root);
    await mkdir(join(root, "eval-cases", "new-case", "runs", "new-run"), { recursive: true });
    await mkdir(join(root, "old-case", "runs", "old-run"), { recursive: true });
    const entries = await listRunHistory(root);
    expect(entries.map((entry) => entry.runDir)).toEqual([
      join(root, "eval-cases", "new-case", "runs", "new-run"),
      join(root, "old-case", "runs", "old-run"),
    ]);
  });

  it("keeps incomplete/corrupt entries visible without scores and refuses symlink traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-history-")); roots.push(root);
    const runs = join(root, "eval-cases", "orphan-namespace", "runs");
    await mkdir(join(runs, "incomplete-run"), { recursive: true });
    await mkdir(join(runs, "corrupt-run"), { recursive: true });
    await writeFile(join(runs, "corrupt-run", "manifest.json"), "{}\n");
    await writeFile(join(runs, "corrupt-run", "receipt.json"), "not json\n");
    const outside = await mkdtemp(join(tmpdir(), "eval-history-private-")); roots.push(outside);
    await writeFile(join(outside, "receipt.json"), JSON.stringify({ status: "complete", score: 1 }));
    await symlink(outside, join(runs, "private-link"));
    const entries = await listRunHistory(root);
    expect(entries.map((entry) => [entry.runId, entry.state])).toEqual([["incomplete-run", "incomplete"], ["corrupt-run", "corrupt"]]);
    const rendered = formatRunHistory(entries);
    expect(rendered).not.toContain("score");
    expect(rendered).not.toContain("private-link");
  });
});
