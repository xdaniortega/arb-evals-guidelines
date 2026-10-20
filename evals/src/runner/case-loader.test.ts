/**
 * Discovery, containment, symlink refusal, duplicate identity, and freezing.
 *
 * These tests build real temporary trees and real links, because the guarantees under
 * test are filesystem guarantees: a lexical check alone would happily follow a
 * symlinked fixture root or freeze an inode that is also reachable from outside the
 * case directory.
 */

import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvalError, SCHEMA_VERSION } from "../core/types.ts";
import {
  MAX_CASE_JSON_BYTES,
  assertNoSymlinkedAncestor,
  assertRealDirectory,
  containedPath,
  discoverAuthoredCases,
  discoverCases,
  discoverSuites,
  fixtureTreeHash,
  freezeCase,
  loadFrozenCase,
  readRegularFile,
  resolveCaseSelector,
} from "./case-loader.ts";
import type { CaseRef } from "./case-loader.ts";

const created: string[] = [];

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eval-case-loader-"));
  created.push(dir);
  return dir;
}

/** True when this platform lets the test process create a symlink. */
async function canSymlink(root: string): Promise<boolean> {
  try {
    await writeFile(join(root, "probe-target"), "x", "utf8");
    await symlink(join(root, "probe-target"), join(root, "probe-link"));
    await rm(join(root, "probe-link"));
    await rm(join(root, "probe-target"));
    return true;
  } catch {
    return false;
  }
}

const suiteJson = (id: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ schemaVersion: SCHEMA_VERSION, id, skillPath: "skills/example", ...overrides });

const caseJson = (id: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id,
    version: 1,
    prompt: "p",
    outputPath: "config.json",
    allowedTools: ["read"],
    validator: "validator.ts",
    ...overrides,
  });

interface SuiteOptions {
  readonly suiteOverrides?: Record<string, unknown>;
  readonly caseOverrides?: Record<string, unknown>;
  readonly selector?: string;
  readonly caseId?: string;
}

/** Builds a complete, valid suite/case tree under `root`. */
async function buildSuite(root: string, suiteId: string, options: SuiteOptions = {}): Promise<string> {
  const selector = options.selector ?? "group/case-a";
  const suiteDir = join(root, suiteId);
  const caseDir = join(suiteDir, "cases", ...selector.split("/"));
  await mkdir(join(caseDir, "fixture"), { recursive: true });
  await writeFile(join(suiteDir, "eval.json"), suiteJson(suiteId, options.suiteOverrides ?? {}), "utf8");
  await writeFile(join(caseDir, "case.json"), caseJson(options.caseId ?? "case-a", options.caseOverrides ?? {}), "utf8");
  await writeFile(join(caseDir, "oracle.json"), JSON.stringify({ expected: true }), "utf8");
  await writeFile(join(caseDir, "validator.ts"), "export function validateSnapshot() { return null; }\n", "utf8");
  await writeFile(join(caseDir, "fixture", "config.json"), JSON.stringify({ a: 1 }), "utf8");
  return caseDir;
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

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

describe("containedPath", () => {
  it("resolves a safe relative path under its root", () => {
    expect(containedPath("/a/b", "c/d.json", "p")).toBe("/a/b/c/d.json");
  });

  it.each(["../escape", "/etc/passwd", "a/../../b", "a\\b", "a\u0000b", "C:/x", ".env"])(
    "rejects %s before joining",
    (candidate) => {
      let caught: unknown;
      try {
        containedPath("/a/b", candidate, "p");
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EvalError);
      expect((caught as EvalError).code).toBe("path-unsafe");
    },
  );
});

// ---------------------------------------------------------------------------
// Symlink and hardlink rejection
// ---------------------------------------------------------------------------

describe("link rejection", () => {
  it("readRegularFile rejects a symlinked file", async () => {
    const root = await tempRoot();
    if (!(await canSymlink(root))) return;
    await writeFile(join(root, "real.txt"), "hello", "utf8");
    await symlink(join(root, "real.txt"), join(root, "link.txt"));
    await expectEvalErrorAsync(readRegularFile(join(root, "link.txt"), 1_000, "f"), "path-unsafe");
  });

  it("readRegularFile rejects a hardlinked input file", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "real.txt"), "hello", "utf8");
    try {
      await link(join(root, "real.txt"), join(root, "hard.txt"));
    } catch {
      return; // platform cannot hardlink
    }
    const error = await expectEvalErrorAsync(readRegularFile(join(root, "hard.txt"), 1_000, "f"), "path-unsafe");
    expect(error.message).toContain("hardlinked");
  });

  it("readRegularFile rejects an oversize file and a directory", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "big.txt"), "x".repeat(100), "utf8");
    await expectEvalErrorAsync(readRegularFile(join(root, "big.txt"), 10, "f"), "input-invalid");
    await expectEvalErrorAsync(readRegularFile(root, 10, "f"), "path-unsafe");
  });

  it("assertRealDirectory rejects a symlinked directory", async () => {
    const root = await tempRoot();
    if (!(await canSymlink(root))) return;
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "linked"));
    await expectEvalErrorAsync(assertRealDirectory(join(root, "linked"), "d"), "path-unsafe");
    await expect(assertRealDirectory(join(root, "real"), "d")).resolves.toBe(true);
  });

  it("discoverAuthoredCases validates the canonical root", async () => {
    const root = await tempRoot();
    const target = join(root, "target");
    await mkdir(join(target, "case-a"), { recursive: true });
    await writeFile(join(target, "case-a", "case.json"), caseJson("case-a"), "utf8");
    expect((await discoverAuthoredCases(root)).map((item) => item.config.id)).toEqual([]);
    await rm(join(root, "cases"), { recursive: true, force: true });
    await mkdir(join(root, "cases"), { recursive: true });
    await writeFile(join(root, "cases", "case-a", "case.json"), caseJson("case-a"), "utf8").catch(async () => {
      await mkdir(join(root, "cases", "case-a"), { recursive: true });
      await writeFile(join(root, "cases", "case-a", "case.json"), caseJson("case-a"), "utf8");
    });
    expect((await discoverAuthoredCases(root)).map((item) => item.config.id)).toEqual(["case-a"]);
    if (!(await canSymlink(root))) return;
    for (const kind of ["directory", "dangling"] as const) {
      await rm(join(root, "cases"), { recursive: true, force: true });
      if (kind === "directory") await symlink(target, join(root, "cases"));
      else await symlink(join(root, "missing-target"), join(root, "cases"));
      await expectEvalErrorAsync(discoverAuthoredCases(root), "path-unsafe");
    }
    await rm(join(root, "cases"), { force: true });
    await writeFile(join(root, "cases"), "file", "utf8");
    await expectEvalErrorAsync(discoverAuthoredCases(root), "path-unsafe");
  });

  it("assertNoSymlinkedAncestor rejects a symlinked ancestor directory", async () => {
    const root = await tempRoot();
    if (!(await canSymlink(root))) return;
    await mkdir(join(root, "real", "inner"), { recursive: true });
    await writeFile(join(root, "real", "inner", "f.txt"), "x", "utf8");
    await symlink(join(root, "real"), join(root, "aliased"));
    const error = await expectEvalErrorAsync(
      assertNoSymlinkedAncestor(root, "aliased/inner/f.txt", "p"),
      "path-unsafe",
    );
    expect(error.message).toContain("traverses a symlink");
    await expect(assertNoSymlinkedAncestor(root, "real/inner/f.txt", "p")).resolves.toBeUndefined();
  });

  it("freezeCase rejects a symlinked fixture root", async () => {
    const root = await tempRoot();
    if (!(await canSymlink(root))) return;
    const caseDir = await buildSuite(root, "s1");
    await rm(join(caseDir, "fixture"), { recursive: true });
    await mkdir(join(root, "elsewhere"), { recursive: true });
    await writeFile(join(root, "elsewhere", "config.json"), "{}", "utf8");
    await symlink(join(root, "elsewhere"), join(caseDir, "fixture"));
    const [suite] = await discoverSuites(root);
    const cases = await discoverCases(suite!);
    await expectEvalErrorAsync(freezeCase(suite!, cases[0]!), "path-unsafe");
  });

  it("freezeCase rejects a symlinked file inside the fixture", async () => {
    const root = await tempRoot();
    if (!(await canSymlink(root))) return;
    const caseDir = await buildSuite(root, "s1");
    await writeFile(join(root, "outside.txt"), "secret", "utf8");
    await symlink(join(root, "outside.txt"), join(caseDir, "fixture", "extra.txt"));
    const [suite] = await discoverSuites(root);
    const cases = await discoverCases(suite!);
    const error = await expectEvalErrorAsync(freezeCase(suite!, cases[0]!), "path-unsafe");
    expect(error.message).toContain("symlink");
  });

  it("freezeCase rejects a symlinked validator", async () => {
    const root = await tempRoot();
    if (!(await canSymlink(root))) return;
    const caseDir = await buildSuite(root, "s1");
    await rm(join(caseDir, "validator.ts"));
    await writeFile(join(root, "outside-validator.ts"), "export {}\n", "utf8");
    await symlink(join(root, "outside-validator.ts"), join(caseDir, "validator.ts"));
    const [suite] = await discoverSuites(root);
    const cases = await discoverCases(suite!);
    await expectEvalErrorAsync(freezeCase(suite!, cases[0]!), "path-unsafe");
  });
});

// ---------------------------------------------------------------------------
// Discovery, duplicates, profiles
// ---------------------------------------------------------------------------

describe("discoverSuites", () => {
  it("returns an empty list when no suite has an eval.json", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "not-a-suite"));
    expect(await discoverSuites(root)).toEqual([]);
  });

  it("skips src, scripts, and container directories", async () => {
    const root = await tempRoot();
    for (const name of ["src", "scripts", "container"]) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, "eval.json"), suiteJson(name), "utf8");
    }
    expect(await discoverSuites(root)).toEqual([]);
  });

  it("rejects a suite id that does not equal its directory name", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1");
    await writeFile(join(root, "s1", "eval.json"), suiteJson("other"), "utf8");
    const error = await expectEvalErrorAsync(discoverSuites(root), "input-invalid");
    expect(error.message).toContain("must equal its directory name");
  });

  it("rejects two suite directories declaring the same id", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1");
    await buildSuite(root, "s2");
    await writeFile(join(root, "s2", "eval.json"), suiteJson("s1"), "utf8");
    // Two suites can only collide by declaring the same id from different directories,
    // and the id-equals-directory-name rule catches that first. The dedicated
    // duplicate-id guard behind it is defence in depth for a future relaxation.
    const error = await expectEvalErrorAsync(discoverSuites(root), "input-invalid");
    expect(error.message).toMatch(/must equal its directory name|duplicate suite id/);
    expect(error.at).toBe("s2/eval.json");
  });

  it("rejects an unknown runtimeProfileId in a suite config", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1", { suiteOverrides: { runtimeProfileId: "stylus" } });
    const error = await expectEvalErrorAsync(discoverSuites(root), "input-invalid");
    expect(error.message).toContain("runtimeProfileId");
  });

  it("rejects invalid JSON and an oversize suite config", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1");
    await writeFile(join(root, "s1", "eval.json"), "{not json", "utf8");
    await expectEvalErrorAsync(discoverSuites(root), "input-invalid");
    await writeFile(join(root, "s1", "eval.json"), " ".repeat(MAX_CASE_JSON_BYTES + 1), "utf8");
    await expectEvalErrorAsync(discoverSuites(root), "input-invalid");
  });
});

describe("discoverCases", () => {
  it("finds a nested case and sorts by selector", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1", { selector: "group/case-b", caseId: "case-b" });
    await buildSuite(root, "s1", { selector: "group/case-a", caseId: "case-a" });
    const [suite] = await discoverSuites(root);
    const cases = await discoverCases(suite!);
    expect(cases.map((entry) => entry.selector)).toEqual(["group/case-a", "group/case-b"]);
  });

  it("rejects two cases sharing a case id", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1", { selector: "group/one", caseId: "same" });
    await buildSuite(root, "s1", { selector: "group/two", caseId: "same" });
    const [suite] = await discoverSuites(root);
    const error = await expectEvalErrorAsync(discoverCases(suite!), "input-invalid");
    expect(error.message).toContain("duplicate case id same");
  });

  it("rejects an unknown runtimeProfileId in a case config", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1", { caseOverrides: { runtimeProfileId: "stylus" } });
    const [suite] = await discoverSuites(root);
    await expectEvalErrorAsync(discoverCases(suite!), "input-invalid");
  });

  it("rejects an unknown field in a case config", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1", { caseOverrides: { extraneous: 1 } });
    const [suite] = await discoverSuites(root);
    await expectEvalErrorAsync(discoverCases(suite!), "input-invalid");
  });
});

describe("resolveCaseSelector", () => {
  const entry = (selector: string, id: string): CaseRef =>
    ({
      suiteId: "s",
      selector,
      dir: "/tmp",
      config: {
        id,
        version: 1,
        prompt: "p",
        outputPath: "config.json",
        allowedTools: ["read"],
        validator: "validator.ts",
        runtimeProfileId: null,
        limits: {},
        fixtureDir: "fixture",
        oracle: "oracle.json",
        candidateMode: "workspace",
      },
    }) as CaseRef;

  const cases = [entry("group-a/leaf", "case-1"), entry("group-b/leaf", "case-2")];

  it("matches an exact selector", () => {
    expect(resolveCaseSelector(cases, "group-a/leaf").config.id).toBe("case-1");
  });

  it("matches a unique case id", () => {
    expect(resolveCaseSelector(cases, "case-2").selector).toBe("group-b/leaf");
  });

  it("rejects an ambiguous selector matching more than one case", () => {
    let caught: unknown;
    try {
      resolveCaseSelector(cases, "leaf");
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EvalError);
    expect((caught as EvalError).code).toBe("selector-ambiguous");
    expect((caught as EvalError).message).toContain("matches 2 cases");
  });

  it("rejects an unmatched selector and an unsafe selector", () => {
    expect(() => resolveCaseSelector(cases, "nope")).toThrow(EvalError);
    expect(() => resolveCaseSelector(cases, "../nope")).toThrow(EvalError);
  });
});

// ---------------------------------------------------------------------------
// Freezing
// ---------------------------------------------------------------------------

describe("freezeCase", () => {
  it("freezes prompt, fixture, oracle, and validator with stable hashes", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1");
    const frozen = await loadFrozenCase({ evalsRoot: root, suiteId: "s1", caseSelector: "group/case-a" });
    expect(frozen.fixtureFiles.map((file) => file.path)).toEqual(["config.json"]);
    expect(frozen.promptSha256).toHaveLength(64);
    expect(frozen.oracle).toEqual({ expected: true });
    expect(frozen.runtimeProfileId).toBe("default");
    expect(frozen.fixtureTreeSha256).toBe(fixtureTreeHash(frozen.fixtureFiles));
  });

  it("prefers the case runtime profile over the suite profile", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1", { caseOverrides: { runtimeProfileId: "default" } });
    const frozen = await loadFrozenCase({ evalsRoot: root, suiteId: "s1", caseSelector: "group/case-a" });
    expect(frozen.runtimeProfileId).toBe("default");
  });

  // The generic case contract permits absent initial output and empty fixture directory.
  it("permits an outputPath that is not in the frozen fixture", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1", { caseOverrides: { outputPath: "absent.json" } });
    const frozen = await loadFrozenCase({ evalsRoot: root, suiteId: "s1", caseSelector: "group/case-a" });
    expect(frozen.config.outputPath).toBe("absent.json");
    expect(frozen.fixtureFiles.some((f) => f.path === "absent.json")).toBe(false);
  });

  it("permits an empty fixture directory", async () => {
    const root = await tempRoot();
    const caseDir = await buildSuite(root, "s1");
    await rm(join(caseDir, "fixture", "config.json"));
    const frozen = await loadFrozenCase({ evalsRoot: root, suiteId: "s1", caseSelector: "group/case-a" });
    expect(frozen.fixtureFiles).toEqual([]);
    expect(frozen.fixtureTreeSha256).toBe(fixtureTreeHash([]));
  });

  it("rejects a traversing fixtureDir", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1", { caseOverrides: { fixtureDir: "../../../etc" } });
    await expectEvalErrorAsync(
      loadFrozenCase({ evalsRoot: root, suiteId: "s1", caseSelector: "group/case-a" }),
      "path-unsafe",
    );
  });

  it("rejects an unknown suite id", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1");
    await expectEvalErrorAsync(
      loadFrozenCase({ evalsRoot: root, suiteId: "nope", caseSelector: "group/case-a" }),
      "input-invalid",
    );
  });
});
