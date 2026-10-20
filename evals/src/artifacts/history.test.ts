import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatRunHistory, listRunHistory } from "./queries.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("eval history discovery", () => {
  it("enumerates canonical and historical run namespaces without changing paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-history-layouts-")); roots.push(root);
    await mkdir(join(root, "cases", "new-case", "runs", "new-run"), { recursive: true });
    await mkdir(join(root, "old-case", "runs", "old-run"), { recursive: true });
    const entries = await listRunHistory(root);
    expect(entries.map((entry) => entry.runDir)).toEqual([
      join(root, "cases", "new-case", "runs", "new-run"),
      join(root, "old-case", "runs", "old-run"),
    ]);
  });

  it("keeps incomplete/corrupt entries visible without scores and refuses symlink traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-history-")); roots.push(root);
    const runs = join(root, "cases", "orphan-namespace", "runs");
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
