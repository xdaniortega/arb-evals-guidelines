import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDefaultRepoRoot } from "./artifacts/publish.ts";
import { discoverAuthoredCases } from "./runner/case-loader.ts";

const repoRoot = resolve(import.meta.dirname, "..");

describe("flat repository layout", () => {
  it("scripts root and the default publish root are the repository root", () => {
    expect(resolveDefaultRepoRoot()).toBe(repoRoot);
    expect(existsSync(join(repoRoot, "package.json"))).toBe(true);
    expect(existsSync(join(repoRoot, "eval-cases"))).toBe(true);
    expect(existsSync(join(repoRoot, "evals"))).toBe(false);
  });

  it("discovers cases under eval-cases/<skill>/<case-id>", async () => {
    const cases = await discoverAuthoredCases(repoRoot);
    expect(cases.map((entry) => entry.selector)).toContain("network-config-01");
  });
});
