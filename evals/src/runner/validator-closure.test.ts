/**
 * Bounded frozen validator dependency closure regressions (L0).
 *
 * Enforces:
 * - Deterministic static ESM import/re-export/side-effect closure traversal using TypeScript parser.
 * - Node builtins permitted without snapshot.
 * - Explicit relative .ts/.mts/.js/.mjs files strictly contained within case root.
 * - Rejection of unsafe bare packages, absolute paths, escaping paths, dynamic imports,
 *   require calls, type reference directives, extensionless imports, parse errors, missing files,
 *   and symlinks.
 * - Closure hard bounds: max 32 files, 256KiB/file, 1MiB total.
 * - DFS cycle handling with sorted deterministic snapshot.
 * - Entry bytes hash (validatorSha256) vs closure tree hash (validatorClosureSha256) parity.
 * - Grading and hash verification after source deletion.
 * - Zero agent dispatch on malformed/oversize dependencies.
 * - Supervisor child bundle validation (valid, malformed, duplicate, escaping, missing entry, non-canonical base64).
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { cp, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRunReport, readFrozenInputs, verifyRun } from "../artifacts/queries.ts";
import { assertParity, buildConditionPlans } from "../core/experiment.ts";
import type { ParityBinding } from "../core/experiment.ts";
import { EvalError, SAFE_DEFAULT_LIMITS, SCHEMA_VERSION } from "../core/types.ts";
import type { SnapshotValidationInput } from "../core/types.ts";
import { createFakeHarness } from "../harnesses/fake.ts";
import { createFakeSandbox } from "../sandboxes/fake.ts";
import { buildAllowlistedEnv } from "../test-guards.ts";
import {
  discoverCases,
  discoverSuites,
  freezeCase,
  loadFrozenCase,
  MAX_VALIDATOR_FILES,
  MAX_VALIDATOR_FILE_BYTES,
  MAX_VALIDATOR_TOTAL_BYTES,
} from "./case-loader.ts";
import { createFrozenInputSnapshot, verifyFrozenInputSnapshot } from "./frozen-inputs.ts";
import { disposeRunWorkDir, runPairedEvaluation } from "./run.ts";
import type { RunOptions } from "./run.ts";
import { createInProcessValidatorRunner } from "./validation.ts";

const createdDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir !== undefined) await disposeRunWorkDir(dir).catch(() => undefined);
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

async function setupSuite(
  root: string,
  suiteId: string,
  caseId: string,
  files: Record<string, string>,
  caseOverrides: Record<string, unknown> = {},
): Promise<string> {
  const caseDir = join(root, suiteId, "cases", caseId);
  await mkdir(join(caseDir, "fixture"), { recursive: true });
  await writeFile(join(caseDir, "fixture", "in.txt"), "input data\n", "utf8");
  await writeFile(
    join(root, suiteId, "eval.json"),
    JSON.stringify({ schemaVersion: SCHEMA_VERSION, id: suiteId, skillPath: "skills/test" }),
    "utf8",
  );
  await writeFile(
    join(caseDir, "case.json"),
    JSON.stringify({
      id: caseId,
      version: 1,
      prompt: "test prompt",
      fixtureDir: "fixture",
      outputPath: "result.json",
      oracle: "oracle.json",
      validator: "validator.ts",
      allowedTools: ["read"],
      ...caseOverrides,
    }),
    "utf8",
  );
  await writeFile(join(caseDir, "oracle.json"), JSON.stringify({ expected: 42 }), "utf8");
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(caseDir, relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return caseDir;
}

const VALIDATOR = 'export function validateSnapshot() { return { status: "graded", score: 1, fullPass: true, checks: [{ id: "ok", passed: true, message: "ok" }] }; }';

async function runFixture(root: string, caseId: string, overrides: Partial<RunOptions> = {}) {
  await mkdir(join(root, "skills", "test"), { recursive: true });
  await writeFile(join(root, "skills", "test", "SKILL.md"), "# Synthetic skill\nKeep the result correct.\n");
  return runPairedEvaluation({
    evalsRoot: root, repoRoot: root, suiteId: "test-suite", caseSelector: caseId,
    mode: "fake", harness: createFakeHarness(), sandbox: createFakeSandbox(),
    validatorRunner: createInProcessValidatorRunner(), repetitions: 1, cliLimits: {},
    target: { provider: "google", model: "fake-model-0", thinking: "off" },
    runId: "20260907T000000Z-closure", resourceNonce: "0a1b2c3d",
    createdAt: new Date(0).toISOString(), source: { revision: "0".repeat(40), dirty: false },
    evaluatorBuild: "evals-src@test", workDir: await makeTempDir("closure-work-"),
    runsRoot: join(root, "runs"), stateDir: join(root, ".state"), ...overrides,
  });
}

async function expectNoDispatch(root: string, caseId: string, code: string) {
  const counts = { builds: 0, guests: 0, prompts: 0 };
  const sandbox = createFakeSandbox();
  const harness = createFakeHarness();
  sandbox.buildImage = async () => { counts.builds++; throw new Error("unexpected build"); };
  sandbox.createGuest = async () => { counts.guests++; throw new Error("unexpected guest"); };
  harness.run = async () => { counts.prompts++; throw new Error("unexpected prompt"); };
  await expect(runFixture(root, caseId, { sandbox, harness })).rejects.toMatchObject({ code });
  expect(counts).toEqual({ builds: 0, guests: 0, prompts: 0 });
}

async function runSupervisorValidate(
  payload: unknown,
): Promise<{ code: number | null; stdout: string; stderr: string; json: Record<string, unknown> | null; materialized: boolean }> {
  const supervisorPath = join(process.cwd(), "evals", "container", "run-measured.mjs");
  const tempDir = await makeTempDir("sup-validate-");
  const child = spawn(process.execPath, [supervisorPath, "validate"], {
    env: buildAllowlistedEnv(tempDir, { EVAL_CONTROL_DIR: tempDir }),
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 3_000,
    killSignal: "SIGKILL",
  });

  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  let json: Record<string, unknown> | null = null;
  try {
    const last = stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
    if (last !== undefined) json = JSON.parse(last) as Record<string, unknown>;
  } catch {
    // leave null
  }
  const materialized = await stat(join(tempDir, "validator")).then(() => true, () => false);
  return { code, stdout, stderr, json, materialized };
}

describe("Validator dependency closure", () => {
  it("supports nested imports, ../ within case root, re-exports, and dependency cycles", async () => {
    const root = await makeTempDir("val-deps-");
    await setupSuite(root, "test-suite", "complex-case", {
      "nested/val.ts": `
import { helperScore } from "../helpers/score.ts";
import { reexportedScore } from "../helpers/reexport.ts";
import { cycleA } from "../helpers/cycle-a.ts";
export function validateSnapshot(input: any) {
  return {
    status: "pass",
    score: helperScore() + reexportedScore() + cycleA(),
    fullPass: true,
    checks: [{ id: "check", passed: true, message: "ok" }]
  };
}
`,
      "helpers/score.ts": `
import { baseScore } from "./deep/base.ts";
export function helperScore(): number { return baseScore() + 10; }
`,
      "helpers/deep/base.ts": `
export function baseScore(): number { return 5; }
`,
      "helpers/reexport.ts": `
export { reexportedScore } from "./actual-reexport.mts";
export * from "./side-effect.js";
`,
      "helpers/actual-reexport.mts": `
export function reexportedScore(): number { return 20; }
`,
      "helpers/side-effect.js": `
// side effect module
export const sideEffect = true;
`,
      "helpers/cycle-a.ts": `
import { cycleB } from "./cycle-b.ts";
export function cycleA(): number { return cycleB(); }
`,
      "helpers/cycle-b.ts": `
import { cycleA } from "./cycle-a.ts";
export function cycleB(): number { return 7; }
`,
    }, {
      validator: "nested/val.ts",
    });

    const frozen = await loadFrozenCase({
      evalsRoot: root,
      suiteId: "test-suite",
      caseSelector: "complex-case",
    });

    expect(frozen.validatorEntryPath).toBe("nested/val.ts");
    expect(frozen.validatorBundle.length).toBe(8);
    const bundlePaths = frozen.validatorBundle.map((f) => f.path);
    expect(bundlePaths).toEqual([
      "helpers/actual-reexport.mts",
      "helpers/cycle-a.ts",
      "helpers/cycle-b.ts",
      "helpers/deep/base.ts",
      "helpers/reexport.ts",
      "helpers/score.ts",
      "helpers/side-effect.js",
      "nested/val.ts",
    ].sort());
    expect(frozen.validatorClosureSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("grades from frozen bundle and verifies hashes after original source is deleted", async () => {
    const root = await makeTempDir("source-del-");
    const caseDir = await setupSuite(root, "test-suite", "del-case", {
      "validator.mjs": `
import { computePoints } from "./helper.mjs";
export function validateSnapshot(input) {
  return {
    status: "graded",
    score: computePoints(),
    fullPass: true,
    checks: [{ id: "c1", passed: true, message: "ok" }]
  };
}
`,
      "helper.mjs": `
export function computePoints() { return 1.0; }
`,
    }, {
      validator: "validator.mjs",
    });

    const frozen = await loadFrozenCase({
      evalsRoot: root,
      suiteId: "test-suite",
      caseSelector: "del-case",
    });

    const scratchDir = await makeTempDir("scratch-snap-");
    const snapshot = await createFrozenInputSnapshot({
      targetDir: scratchDir,
      frozen,
      snapshot: { sourcePath: root, snapshotDir: root, files: [], treeSha256: "00".repeat(32), totalBytes: 0 },
    });

    // Completely DELETE source case directory
    await rm(caseDir, { recursive: true, force: true });

    // Grade using in-process validator runner from frozen snapshot path
    const runner = createInProcessValidatorRunner();
    const result = await runner.run({
      validatorPath: snapshot.validatorPath,
      input: {
        outputPath: "result.json",
        fixtureFiles: {},
        candidateFiles: { "result.json": Buffer.from("test").toString("base64") },
        oracle: { expected: 42 },
      },
    });

    expect(result.outcome.status).toBe("graded");
    expect(result.outcome.score).toBe(1.0);

    // Verify snapshot reconstructs its hashes without original source
    const verified = await verifyFrozenInputSnapshot(scratchDir);
    expect(verified.ok).toBe(true);
  });

  it("proves helper mutation changes validatorClosureSha256 while validatorSha256 stays constant", async () => {
    const root = await makeTempDir("helper-mut-");
    await setupSuite(root, "test-suite", "mut-case", {
      "validator.ts": `
import { score } from "./helper.ts";
export function validateSnapshot() { return { status: "pass", score: score() }; }
`,
      "helper.ts": `
export function score(): number { return 50; }
`,
    });

    const f1 = await loadFrozenCase({
      evalsRoot: root,
      suiteId: "test-suite",
      caseSelector: "mut-case",
    });

    // Mutate helper.ts ONLY
    await writeFile(join(root, "test-suite", "cases", "mut-case", "helper.ts"), `
export function score(): number { return 99; }
`, "utf8");

    const f2 = await loadFrozenCase({
      evalsRoot: root,
      suiteId: "test-suite",
      caseSelector: "mut-case",
    });

    // validatorSha256 is the ENTRY BYTES hash: it must be identical
    expect(f1.validatorSha256).toBe(f2.validatorSha256);

    // validatorClosureSha256 is the CLOSURE hash: it must have changed!
    expect(f1.validatorClosureSha256).not.toBe(f2.validatorClosureSha256);

    // Parity enforcement proves the change is caught
    const makeP = (f: typeof f1): ParityBinding => ({
      promptSha256: f.promptSha256,
      fixtureTreeSha256: f.fixtureTreeSha256,
      outputPath: f.config.outputPath,
      oracleSha256: f.oracleSha256,
      validatorSha256: f.validatorSha256,
      validatorClosureSha256: f.validatorClosureSha256,
      allowedTools: [...f.config.allowedTools],
      harnessId: "fake",
      sandboxId: "fake",
      validatorRunnerId: "in-process",
      runtimeProfileId: "default",
      imageDigest: "sha256:abc",
      target: { provider: "google", model: "m", thinking: "off" },
      limits: SAFE_DEFAULT_LIMITS,
      networkPolicySha256: "00".repeat(32),
      guestPolicySha256: "00".repeat(32),
      workspaceRoot: "/work",
      executionPolicySha256: "00".repeat(32),
      caseId: f.config.id,
      caseVersion: f.config.version,
      skillSnapshotTreeSha256: "00".repeat(32),
      skillToolBundleSha256: "00".repeat(32),
      candidateMode: f.config.candidateMode,
    });

    const plans = [
      { conditionId: "baseline" as const, skillPaths: [], parity: makeP(f1) },
      { conditionId: "treatment" as const, skillPaths: ["/skill"], parity: makeP(f2) },
    ] as const;

    expect(() => assertParity(plans)).toThrowError(/validatorClosureSha256/);
  });

  it("permits safe Node builtins without creating snapshot files", async () => {
    const root = await makeTempDir("builtins-");
    await setupSuite(root, "test-suite", "builtin-case", {
      "validator.ts": `
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "fs";
export function validateSnapshot() {
  return { status: "pass", score: 1, fullPass: true, checks: [] };
}
`,
    });

    const frozen = await loadFrozenCase({
      evalsRoot: root,
      suiteId: "test-suite",
      caseSelector: "builtin-case",
    });

    expect(frozen.validatorBundle).toHaveLength(1);
    expect(frozen.validatorBundle[0]?.path).toBe("validator.ts");
  });

  it("rejects unsafe bare packages, absolute paths, escaping paths, dynamic imports, require, type refs, and extensionless paths before any dispatch", async () => {
    const root = await makeTempDir("unsafe-deps-");

    const cases: Array<{ name: string; files: Record<string, string>; expectedCode: string }> = [
      {
        name: "bare-pkg",
        files: { "validator.ts": 'import lodash from "lodash";\nexport function validateSnapshot() {}' },
        expectedCode: "path-unsafe",
      },
      {
        name: "abs-path",
        files: { "validator.ts": 'import { x } from "/tmp/some-file.ts";\nexport function validateSnapshot() {}' },
        expectedCode: "path-unsafe",
      },
      {
        name: "escape-case",
        files: { "validator.ts": 'import { x } from "../outside.ts";\nexport function validateSnapshot() {}' },
        expectedCode: "path-unsafe",
      },
      {
        name: "dyn-import",
        files: { "validator.ts": 'export async function validateSnapshot() { await import("./sub.ts"); }' },
        expectedCode: "path-unsafe",
      },
      {
        name: "require-call",
        files: { "validator.ts": 'export function validateSnapshot() { const x = require("./sub.js"); }' },
        expectedCode: "path-unsafe",
      },
      {
        name: "type-ref",
        files: { "validator.ts": '/// <reference types="node" />\nexport function validateSnapshot() {}' },
        expectedCode: "input-invalid",
      },
      {
        name: "extensionless",
        files: {
          "validator.ts": 'import { x } from "./helper";\nexport function validateSnapshot() {}',
          "helper.ts": "export const x = 1;",
        },
        expectedCode: "input-invalid",
      },
      {
        name: "parse-error",
        files: { "validator.ts": "export function validateSnapshot( { const x = ; }" },
        expectedCode: "input-invalid",
      },
      {
        name: "missing-dep",
        files: { "validator.ts": 'import { missing } from "./missing.ts";\nexport function validateSnapshot() {}' },
        expectedCode: "input-invalid",
      },
    ];

    for (const testCase of cases) {
      await setupSuite(root, "test-suite", testCase.name, testCase.files);
      await expectNoDispatch(root, testCase.name, testCase.expectedCode);
    }
  });

  it("enforces closure bounds (max files, max file bytes, max total bytes) before dispatch", async () => {
    const root = await makeTempDir("bounds-");

    // 1. Single file too large (> 256KiB)
    const largeContent = "export const x = 1;\n" + "// large padding\n".repeat(20_000);
    await setupSuite(root, "test-suite", "large-file", {
      "validator.ts": 'import { x } from "./huge.ts";\nexport function validateSnapshot() {}',
      "huge.ts": largeContent,
    });
    await expectNoDispatch(root, "large-file", "input-invalid");

    // 2. Too many files (> 32 files)
    const manyFiles: Record<string, string> = {};
    let current = "validator.ts";
    for (let i = 1; i <= 33; i++) {
      const next = `h${i}.ts`;
      manyFiles[current] = `import { h${i} } from "./${next}";\nexport function validateSnapshot() {}\nexport const h${i - 1} = 1;`;
      current = next;
    }
    manyFiles[current] = "export const h33 = 33;";
    await setupSuite(root, "test-suite", "many-files", manyFiles);
    await expectNoDispatch(root, "many-files", "input-invalid");

    const aggregate: Record<string, string> = {};
    aggregate["validator.ts"] = Array.from({ length: 5 }, (_, i) => `import "./part${i}.ts";`).join("\n");
    for (let i = 0; i < 5; i++) aggregate[`part${i}.ts`] = "//" + "x".repeat(220_000);
    await setupSuite(root, "test-suite", "aggregate", aggregate);
    await expectNoDispatch(root, "aggregate", "input-invalid");
  });

  it.each(["leaf", "ancestor", "hardlink"])("rejects dependency %s links before guest effects", async (kind) => {
    const root = await makeTempDir("linked-dependency-");
    const dependency = kind === "ancestor" ? "helpers/value.ts" : "helper.ts";
    const caseDir = await setupSuite(root, "test-suite", "linked", {
      "validator.ts": `import "./${dependency}";\n${VALIDATOR}`,
    });
    const outside = await makeTempDir("linked-source-");
    await writeFile(join(outside, "value.ts"), "export const value = 1;");
    if (kind === "ancestor") await symlink(outside, join(caseDir, "helpers"));
    else if (kind === "leaf") await symlink(join(outside, "value.ts"), join(caseDir, dependency));
    else await link(join(outside, "value.ts"), join(caseDir, dependency));
    await expectNoDispatch(root, "linked", "path-unsafe");
  });

  it.each(["validator.mjs", "nested/validator.mjs"])("reads the declared sealed entry %s, never a helper", async (entry) => {
    const root = await makeTempDir("sealed-validator-entry-");
    const source = `import { value } from "${entry.startsWith("nested/") ? "../" : "./"}a-helper.mjs";\n${VALIDATOR}\n// Entry marker`;
    const caseDir = await setupSuite(root, "test-suite", "entry", {
      [entry]: source, "a-helper.mjs": "export const value = 1;",
    }, { validator: entry });
    const run = await runFixture(root, "entry");
    await rm(caseDir, { recursive: true });
    expect((await verifyRun(run.runDir)).ok).toBe(true);
    expect((await readFrozenInputs(run.receiptPath)).validatorSource).toBe(source);
    expect((await buildRunReport(run.receiptPath)).pairs[0]?.delta).not.toBeNull();

    const copy = await makeTempDir("missing-validator-copy-");
    await cp(run.runDir, copy, { recursive: true });
    await rm(join(copy, "inputs/frozen/case/validator", entry));
    expect((await verifyRun(copy)).ok).toBe(false);
    await expect(readFrozenInputs(copy)).rejects.toMatchObject({ code: "evidence-invalid" });
  });

  it("reads each input once and retains config/limits across preparer source mutation", async () => {
    const root = await makeTempDir("freeze-once-");
    const caseDir = await setupSuite(root, "test-suite", "stable", { "validator.ts": VALIDATOR }, {
      limits: { wallClockMs: 12_000 },
    });
    const configPath = join(caseDir, "case.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const watched = [configPath, join(caseDir, "validator.ts"), join(caseDir, "oracle.json"), join(caseDir, "fixture/in.txt")];
    const reads = new Map(watched.map((path) => [path, 0]));
    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const path = String(args[0]);
      if (reads.has(path)) reads.set(path, reads.get(path)! + 1);
      return originalOpen(...args);
    });
    syncBuiltinESMExports();
    const harness = createFakeHarness();
    const runPrompt = harness.run.bind(harness);
    const observed: Array<{ prompt: string; budget: number | null }> = [];
    harness.run = async (guest, request) => {
      observed.push({ prompt: request.prompt, budget: request.limits.wallClockMs });
      return runPrompt(guest, request);
    };
    const run = await runFixture(root, "stable", {
      harness,
      preparer: async () => {
        await writeFile(configPath, JSON.stringify({ ...config, prompt: "MUTATED", validator: "absent.ts", limits: { wallClockMs: 1 } }));
        return {};
      },
    });
    expect(observed).toEqual([
      { prompt: "test prompt", budget: 12_000 }, { prompt: "test prompt", budget: 12_000 },
    ]);
    expect([...reads.values()]).toEqual([1, 1, 1, 1]);
    expect((await verifyRun(run.runDir)).ok).toBe(true);
    const retained = JSON.parse(await readFile(join(run.runDir, "inputs/frozen/case/case.json"), "utf8"));
    expect(retained.prompt).toBe("test prompt");
    expect(retained.validator).toBe("validator.ts");
  });

  it("proves helper and oracle are NEVER staged into agent guests", async () => {
    const root = await makeTempDir("staging-isolation-");
    const skillRoot = await makeTempDir("skill-root-");
    await mkdir(join(skillRoot, "skills", "test"), { recursive: true });
    await writeFile(join(skillRoot, "skills", "test", "skill.md"), "skill docs", "utf8");

    await setupSuite(root, "staging-suite", "staged-case", {
      "validator.ts": `
import { secretHelper } from "./helper.ts";
export function validateSnapshot() { return { status: "pass", score: 1 }; }
`,
      "helper.ts": "export function secretHelper() { return 'SECRET_VALIDATOR_LOGIC'; }",
    });

    const stagedFilesCollector: string[] = [];
    const fakeSandbox = createFakeSandbox();
    const origCreateGuest = fakeSandbox.createGuest.bind(fakeSandbox);
    fakeSandbox.createGuest = async (spec) => {
      const guest = await origCreateGuest(spec);
      const origStage = guest.stage.bind(guest);
      guest.stage = async (req) => {
        for (const f of req.files) {
          stagedFilesCollector.push(f.path);
        }
        return origStage(req);
      };
      return guest;
    };

    await runPairedEvaluation({
      evalsRoot: root,
      repoRoot: skillRoot,
      suiteId: "staging-suite",
      caseSelector: "staged-case",
      mode: "fake",
      harness: createFakeHarness(),
      sandbox: fakeSandbox,
      validatorRunner: createInProcessValidatorRunner(),
      repetitions: 1,
      cliLimits: {},
      target: { provider: "google", model: "fake-model-0", thinking: "off" },
      runId: "20260907T000000Z-stagetest",
      resourceNonce: "0a1b2c3d",
      createdAt: new Date(0).toISOString(),
      source: { revision: "0".repeat(40), dirty: false },
      evaluatorBuild: "evals-src@test",
      workDir: await makeTempDir("work-"),
      runsRoot: join(root, "runs"),
      stateDir: join(root, ".state"),
    });

    // Verify staged files only contain fixture files (and treatment skill snapshot), NEVER validator, helper, or oracle
    expect(stagedFilesCollector).not.toContain("validator.ts");
    expect(stagedFilesCollector).not.toContain("helper.ts");
    expect(stagedFilesCollector).not.toContain("oracle.json");
    expect(stagedFilesCollector).toContain("in.txt");
  });

  describe("Supervisor child bundle validation (run-measured.mjs validate)", () => {
    it("accepts a valid bundle with helper and returns validation outcome", async () => {
      const validatorCode = `
import { getVal } from "./helper.ts";
export function validateSnapshot(input: any) {
  return { status: "pass", score: getVal(), fullPass: true, checks: [] };
}
`;
      const helperCode = "export function getVal() { return 88; }";

      const payload = {
        validatorBundle: [
          { path: "validator.ts", base64: Buffer.from(validatorCode, "utf8").toString("base64") },
          { path: "helper.ts", base64: Buffer.from(helperCode, "utf8").toString("base64") },
        ],
        validatorEntry: "validator.ts",
        input: { outputPath: "x.json", fixtureFiles: {}, candidateFiles: {}, oracle: {} },
      };

      const res = await runSupervisorValidate(payload);
      expect(res.code).toBe(0);
      expect(res.json?.ok).toBe(true);
      expect((res.json?.outcome as Record<string, unknown>)?.score).toBe(88);
    });

    it.each(["per-file", "count", "aggregate"])("rejects %s overflow before materializing any validator file", async (bound) => {
      let files = [{ path: "validator.ts", base64: Buffer.from(VALIDATOR).toString("base64") }];
      if (bound === "per-file") files.push({ path: "huge.ts", base64: Buffer.alloc(MAX_VALIDATOR_FILE_BYTES + 1, 32).toString("base64") });
      else if (bound === "count") files = Array.from({ length: MAX_VALIDATOR_FILES + 1 }, (_, i) => ({ path: i === 0 ? "validator.ts" : `f${i}.ts`, base64: "" }));
      else for (let i = 0; i < 5; i++) files.push({ path: `part${i}.ts`, base64: Buffer.alloc(Math.ceil(MAX_VALIDATOR_TOTAL_BYTES / 5), 32).toString("base64") });
      const res = await runSupervisorValidate({ validatorBundle: files, validatorEntry: "validator.ts", input: {} });
      expect(res.code).not.toBe(0);
      expect(res.json?.ok).toBe(false);
      expect(res.json?.error).toMatch(/exceeds/);
      expect(res.materialized).toBe(false);
    });

    it("rejects a malformed file object in validatorBundle", async () => {
      const payload = {
        validatorBundle: [{ path: "validator.ts" }], // missing base64
        validatorEntry: "validator.ts",
        input: {},
      };
      const res = await runSupervisorValidate(payload);
      expect(res.code).not.toBe(0);
      expect(res.json?.ok).toBe(false);
      expect(String(res.json?.error)).toContain("malformed");
    });

    it("rejects duplicate paths in validatorBundle", async () => {
      const payload = {
        validatorBundle: [
          { path: "validator.ts", base64: Buffer.from("").toString("base64") },
          { path: "validator.ts", base64: Buffer.from("").toString("base64") },
        ],
        validatorEntry: "validator.ts",
        input: {},
      };
      const res = await runSupervisorValidate(payload);
      expect(res.code).not.toBe(0);
      expect(res.json?.ok).toBe(false);
      expect(String(res.json?.error)).toContain("duplicate path");
    });

    it("rejects escaping paths in validatorBundle", async () => {
      const payload = {
        validatorBundle: [
          { path: "../outside.ts", base64: Buffer.from("").toString("base64") },
        ],
        validatorEntry: "../outside.ts",
        input: {},
      };
      const res = await runSupervisorValidate(payload);
      expect(res.code).not.toBe(0);
      expect(res.json?.ok).toBe(false);
      expect(String(res.json?.error)).toContain("unsafe");
    });

    it("rejects when declared validatorEntry is not in validatorBundle", async () => {
      const payload = {
        validatorBundle: [
          { path: "helper.ts", base64: Buffer.from("export const x = 1;").toString("base64") },
        ],
        validatorEntry: "validator.ts",
        input: {},
      };
      const res = await runSupervisorValidate(payload);
      expect(res.code).not.toBe(0);
      expect(res.json?.ok).toBe(false);
      expect(String(res.json?.error)).toContain("not found");
    });

    it("rejects non-canonical base64 in validatorBundle", async () => {
      const payload = {
        validatorBundle: [
          { path: "validator.ts", base64: "dGVzdA===bad" },
        ],
        validatorEntry: "validator.ts",
        input: {},
      };
      const res = await runSupervisorValidate(payload);
      expect(res.code).not.toBe(0);
      expect(res.json?.ok).toBe(false);
      expect(String(res.json?.error)).toContain("non-canonical base64");
    });
  });
});
