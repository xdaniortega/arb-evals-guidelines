/**
 * Combined exports: `EVALS-<runIdA>+<runIdB>.md` inside a case's runs folder.
 * Fake harness and sandbox only; every tree lives in a temp root, never in eval-cases/.
 */

import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildAllowlistedEnv } from "../test-guards.ts";
import { runIdFor } from "../core/experiment.ts";
import type { Target } from "../core/experiment.ts";
import type { FakeHarnessScript } from "../harnesses/fake.ts";
import { createFakeHarness } from "../harnesses/fake.ts";
import { createFakeSandbox } from "../sandboxes/fake.ts";
import { createInProcessValidatorRunner } from "../runner/validation.ts";
import { disposeRunWorkDir, runPairedEvaluation } from "../runner/run.ts";
import {
  checkAllCombined,
  checkCombinedExports,
  exportCombinedForRuns,
  combinedFileName,
  differingIdentityFields,
  listCombinedFiles,
  parseCombinedFileName,
  regenerateAllCombined,
  renderCombinedExports,
  writeCombinedExports,
} from "./combined-exports.ts";
import { renderRunExports } from "./run-exports.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const REPO_URL = "https://github.com/example/evals";
const tempRoots: string[] = [];
const workDirs: string[] = [];

afterAll(async () => {
  for (const dir of workDirs) await disposeRunWorkDir(dir).catch(() => {});
  for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {});
});

const FLASH: Target = { provider: "google", model: "gemini-3.8-flash", thinking: "low" };
const ARGON: Target = { provider: "google", model: "gemini-4-argon", thinking: "low" };

interface Sealed {
  readonly runId: string;
  readonly receiptPath: string;
  readonly runDir: string;
}

/** A temp tree `<root>/eval-cases/<caseId>` copied from the real case (without its runs), optionally edited. */
async function caseRoot(
  caseId: string,
  edit?: (caseJson: Record<string, unknown>) => void,
  editRubric?: (rubricJson: { topics: { id: string; label: string }[] }) => void,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eval-combined-cases-"));
  tempRoots.push(root);
  const dest = join(root, "eval-cases", caseId);
  await cp(join(repoRoot, "eval-cases", "network-config-01"), dest, { recursive: true, filter: (src) => !src.includes(`${join("network-config-01", "runs")}`) });
  const caseJsonPath = join(dest, "case.json");
  const caseJson = JSON.parse(await readFile(caseJsonPath, "utf8")) as Record<string, unknown>;
  caseJson.id = caseId;
  edit?.(caseJson);
  await writeFile(caseJsonPath, `${JSON.stringify(caseJson, null, 2)}\n`);
  if (editRubric !== undefined) {
    const rubricPath = join(dest, "rubric.json");
    const rubricJson = JSON.parse(await readFile(rubricPath, "utf8")) as { topics: { id: string; label: string }[] };
    editRubric(rubricJson);
    await writeFile(rubricPath, `${JSON.stringify(rubricJson, null, 2)}\n`);
  }
  return root;
}

let nonceCounter = 0;

async function seal(input: {
  readonly runsRoot: string;
  readonly target: Target;
  readonly evalsRoot?: string;
  readonly caseSelector?: string;
  readonly skill?: string;
  readonly script?: FakeHarnessScript;
  readonly repetitions?: number;
}): Promise<Sealed> {
  const workDir = await mkdtemp(join(tmpdir(), "eval-combined-work-"));
  workDirs.push(workDir);
  nonceCounter += 1;
  const runId = runIdFor(new Date(Date.UTC(2026, 10, 8, 10, 0, nonceCounter)), `abcdef${String(nonceCounter).padStart(2, "0")}`);
  const evalsRoot = input.evalsRoot ?? repoRoot;
  const result = await runPairedEvaluation({
    evalsRoot,
    repoRoot,
    caseSelector: input.caseSelector ?? "network-config-01",
    skillPath: resolve(repoRoot, input.skill ?? "src/test-fixtures/skills/mcp-skill"),
    mode: "fake",
    repetitions: input.repetitions ?? 1,
    cliLimits: {},
    target: input.target,
    runId,
    resourceNonce: "0a1b2c3d",
    createdAt: new Date(0).toISOString(),
    source: { revision: "0".repeat(40), dirty: false },
    evaluatorBuild: "evals-src@test",
    harness: createFakeHarness(input.script === undefined ? {} : { script: input.script }),
    sandbox: createFakeSandbox(),
    validatorRunner: createInProcessValidatorRunner(),
    workDir,
    runsRoot: input.runsRoot,
    stateDir: join(input.runsRoot, "..", ".state"),
  });
  return { runId, receiptPath: result.receiptPath, runDir: result.runDir };
}

async function newRunsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eval-combined-runs-"));
  tempRoots.push(root);
  return join(root, "runs");
}

/** Two same-case runs of different models under one runs folder. */
async function twoRuns(): Promise<{ runsRoot: string; a: Sealed; b: Sealed }> {
  const runsRoot = await newRunsRoot();
  const a = await seal({ runsRoot, target: FLASH });
  const b = await seal({ runsRoot, target: ARGON });
  return { runsRoot, a, b };
}

/** A temp cases root whose `<case>/runs` holds already sealed runs, for the `--all` functions. */
async function casesRootWith(runsRoot: string, caseId = "network-config-01"): Promise<string> {
  // `runsRoot` is `<tmp>/runs`; expose it as `<cases>/<caseId>/runs` through a plain copy of the folder.
  const cases = await mkdtemp(join(tmpdir(), "eval-combined-all-"));
  tempRoots.push(cases);
  await mkdir(join(cases, caseId), { recursive: true });
  await cp(runsRoot, join(cases, caseId, "runs"), { recursive: true });
  return cases;
}

describe("combined file names", () => {
  const A = "20261108T100001Z-abcdef01";
  const B = "20261108T100002Z-abcdef02";
  const C = "20261108T100003Z-abcdef03";

  it("round-trips ids in argument order", () => {
    expect(combinedFileName([A, B, C])).toBe(`EVALS-${A}+${B}+${C}.md`);
    expect(parseCombinedFileName(`EVALS-${A}+${B}+${C}.md`)).toEqual([A, B, C]);
    expect(parseCombinedFileName(`EVALS-${B}+${A}.md`)).toEqual([B, A]);
  });

  it.each([
    ["EVALS.md"],
    ["EVALS-FULL-REPORT.md"],
    [`EVALS-${A}.md`],
    [`EVALS-${A}+${A}.md`],
    [`EVALS-${A}+nope.md`],
    [`EVALS-${A}++${B}.md`],
    [`EVALS-${A}+${B}.txt`],
    [`evals-${A}+${B}.md`],
    [`EVALS-${A}+${B}+.md`],
  ])("rejects %s", (name) => {
    expect(parseCombinedFileName(name)).toBeNull();
  });

  it("reports which identity fields differ from the first run", () => {
    expect(differingIdentityFields([])).toEqual([]);
    expect(differingIdentityFields([{ a: "1", b: "2" }, { a: "1", b: "2" }])).toEqual([]);
    expect(differingIdentityFields([{ a: "1", b: "2" }, { a: "1", b: "3" }, { a: "9", b: "2" }]).sort()).toEqual(["a", "b"]);
  });
});

describe("renderCombinedExports", () => {
  it("renders both runs in argument order, each linking its own full report, with numbers equal to each run's own EVALS.md", async () => {
    const { runsRoot, a, b } = await twoRuns();
    const ab = await renderCombinedExports({ receiptPaths: [a.receiptPath, b.receiptPath], repoUrl: REPO_URL });
    if (!ab.ok) throw new Error(ab.reason);
    expect(ab.fileName).toBe(`EVALS-${a.runId}+${b.runId}.md`);
    expect(ab.runsDir).toBe(runsRoot);
    expect(ab.caseId).toBe("network-config-01");
    expect(ab.runIds).toEqual([a.runId, b.runId]);

    expect(ab.content.indexOf("Google Gemini 3.8 Flash")).toBeLessThan(ab.content.indexOf("Google Gemini 4 Argon"));
    expect(ab.content.match(/^## network-config-01$/gm)).toHaveLength(1);
    expect(ab.content.match(/^### Task$/gm)).toHaveLength(1);
    for (const run of [a, b]) {
      expect(ab.content).toContain(`${REPO_URL}/blob/HEAD/eval-cases/network-config-01/runs/${run.runId}/EVALS-FULL-REPORT.md`);
      expect(ab.content).toContain(`run=${run.runId} `);
    }
    expect(ab.content).not.toContain("batch=");
    expect(ab.content).not.toContain("AF-EVAL:");

    // Every Results row of a run's own EVALS.md appears unchanged in the combined file.
    for (const run of [a, b]) {
      const own = (await renderRunExports(run.receiptPath, { repoUrl: REPO_URL })).summary!;
      const rows = own.split("\n").filter((line) => line.startsWith("| `network-config-01` |"));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(ab.content).toContain(row);
    }

    // Order follows the arguments.
    const ba = await renderCombinedExports({ receiptPaths: [b.receiptPath, a.receiptPath], repoUrl: REPO_URL });
    if (!ba.ok) throw new Error(ba.reason);
    expect(ba.fileName).toBe(`EVALS-${b.runId}+${a.runId}.md`);
    expect(ba.content.indexOf("Google Gemini 4 Argon")).toBeLessThan(ba.content.indexOf("Google Gemini 3.8 Flash"));
  });

  it("refuses fewer than two receipts and duplicate receipts", async () => {
    const { a } = await twoRuns();
    expect(await renderCombinedExports({ receiptPaths: [a.receiptPath], repoUrl: REPO_URL })).toEqual({
      ok: false,
      reason: "a combined EVALS.md needs at least two runs",
    });
    const duplicate = await renderCombinedExports({ receiptPaths: [a.receiptPath, a.receiptPath], repoUrl: REPO_URL });
    expect(duplicate).toMatchObject({ ok: false });
    expect(duplicate.ok ? "" : duplicate.reason).toMatch(/more than once/);
  });

  it("refuses runs of different cases", async () => {
    const runsRoot = await newRunsRoot();
    const a = await seal({ runsRoot, target: FLASH });
    const otherRoot = await caseRoot("other-case");
    const b = await seal({ runsRoot, target: ARGON, evalsRoot: otherRoot, caseSelector: "other-case" });
    const result = await renderCombinedExports({ receiptPaths: [a.receiptPath, b.receiptPath], repoUrl: REPO_URL });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toMatch(/different cases \(network-config-01, other-case\)/);
  });

  it("refuses runs in different runs folders", async () => {
    const a = await seal({ runsRoot: await newRunsRoot(), target: FLASH });
    const b = await seal({ runsRoot: await newRunsRoot(), target: ARGON });
    const result = await renderCombinedExports({ receiptPaths: [a.receiptPath, b.receiptPath], repoUrl: REPO_URL });
    expect(result.ok ? "" : result.reason).toMatch(/different runs folders/);
  });

  it("refuses runs that differ in skill, case version or prompt", async () => {
    const runsRoot = await newRunsRoot();
    const base = await seal({ runsRoot, target: FLASH });
    const otherSkill = await seal({ runsRoot, target: ARGON, skill: "src/test-fixtures/skills/plain-skill" });
    const skillResult = await renderCombinedExports({ receiptPaths: [base.receiptPath, otherSkill.receiptPath], repoUrl: REPO_URL });
    expect(skillResult.ok ? "" : skillResult.reason).toMatch(/runs differ in .*skill snapshot tree hash.*; the runs are not comparable/);

    const versioned = await seal({
      runsRoot,
      target: ARGON,
      evalsRoot: await caseRoot("network-config-01", (c) => {
        c.version = 12;
      }),
    });
    const versionResult = await renderCombinedExports({ receiptPaths: [base.receiptPath, versioned.receiptPath], repoUrl: REPO_URL });
    expect(versionResult.ok ? "" : versionResult.reason).toMatch(/runs differ in .*case version/);

    const prompted = await seal({
      runsRoot,
      target: ARGON,
      evalsRoot: await caseRoot("network-config-01", (c) => {
        c.prompt = `${String(c.prompt)} Be brief.`;
      }),
    });
    const promptResult = await renderCombinedExports({ receiptPaths: [base.receiptPath, prompted.receiptPath], repoUrl: REPO_URL });
    expect(promptResult.ok ? "" : promptResult.reason).toMatch(/runs differ in .*prompt hash/);
  });

  it("refuses when a run's own summary is refused, naming the run, the model and the reason", async () => {
    const runsRoot = await newRunsRoot();
    const a = await seal({ runsRoot, target: FLASH });
    let call = 0;
    const b = await seal({
      runsRoot,
      target: ARGON,
      repetitions: 2,
      script: (request) => {
        call += 1;
        const infra = call === 3;
        return { outcome: infra ? "infrastructure-failure" : "completed", assistantText: infra ? "guest died" : `call-${call} (${request.conditionId})` };
      },
    });
    // The single export of that run is refused too.
    expect((await renderRunExports(b.receiptPath, { repoUrl: REPO_URL })).summary).toBeNull();
    const result = await renderCombinedExports({ receiptPaths: [a.receiptPath, b.receiptPath], repoUrl: REPO_URL });
    expect(result.ok).toBe(false);
    const reason = result.ok ? "" : result.reason;
    expect(reason).toContain(`Google Gemini 4 Argon (run ${b.runId}): pair r002 has ungraded arm(s): baseline`);
    expect(reason).toContain("combined EVALS.md is not generated");
    expect(reason).not.toContain(a.runId);
  });
});

describe("writeCombinedExports and checkCombinedExports", () => {
  it("writes the file into runs/ atomically, leaves no debris, and checks fresh, stale and missing", async () => {
    const { runsRoot, a, b } = await twoRuns();
    const input = { receiptPaths: [a.receiptPath, b.receiptPath], repoUrl: REPO_URL };
    expect(await checkCombinedExports(input)).toMatchObject({ ok: false, problem: "missing" });

    const rendered = await renderCombinedExports(input);
    if (!rendered.ok) throw new Error(rendered.reason);
    const path = await writeCombinedExports(rendered);
    expect(path).toBe(join(runsRoot, `EVALS-${a.runId}+${b.runId}.md`));
    expect(await readFile(path, "utf8")).toBe(rendered.content);
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
    expect((await readdir(runsRoot)).sort()).toEqual([a.runId, b.runId, `EVALS-${a.runId}+${b.runId}.md`].sort());
    expect(await checkCombinedExports(input)).toEqual({ ok: true, path, problem: null });

    await writeFile(path, `${rendered.content}\nedited\n`);
    expect(await checkCombinedExports(input)).toMatchObject({ ok: false, problem: "stale" });
    await writeCombinedExports(rendered);
    expect(await checkCombinedExports(input)).toMatchObject({ ok: true });
  });

  it("never replaces a symlink or directory, and a refused check is never ok", async () => {
    const { runsRoot, a, b } = await twoRuns();
    const rendered = await renderCombinedExports({ receiptPaths: [a.receiptPath, b.receiptPath], repoUrl: REPO_URL });
    if (!rendered.ok) throw new Error(rendered.reason);
    await symlink(join(runsRoot, a.runId), join(runsRoot, rendered.fileName));
    await expect(writeCombinedExports(rendered)).rejects.toThrow(/not a regular file/);

    const refused = await checkCombinedExports({ receiptPaths: [a.receiptPath, a.receiptPath], repoUrl: REPO_URL });
    expect(refused.ok).toBe(false);
    expect(refused.problem).toMatch(/^refused \(/);
  });
});

describe("--all semantics (checkAllCombined / regenerateAllCombined)", () => {
  it("passes for fresh files, and ignores run folders and non-combined files", async () => {
    const { runsRoot, a, b } = await twoRuns();
    const cases = await casesRootWith(runsRoot);
    expect(await checkAllCombined({ casesRoot: cases, repoUrl: REPO_URL })).toEqual([]);

    // The copy keeps run ids, so receipts resolve inside the copied tree.
    const copiedRuns = join(cases, "network-config-01", "runs");
    const rendered = await renderCombinedExports({ receiptPaths: [join(copiedRuns, a.runId, "receipt.json"), join(copiedRuns, b.runId, "receipt.json")], repoUrl: REPO_URL });
    if (!rendered.ok) throw new Error(rendered.reason);
    const file = await writeCombinedExports(rendered);
    await writeFile(join(copiedRuns, "notes.md"), "not a combined file\n");
    expect(await listCombinedFiles(join(cases, "network-config-01"))).toEqual([file]);
    expect(await checkAllCombined({ casesRoot: cases, repoUrl: REPO_URL })).toEqual([{ ok: true, path: file, problem: null }]);
  });

  it("fails for stale, missing member, unparseable and refused combinations; regenerate restores, removes refused and fails on missing members", async () => {
    const { runsRoot, a, b } = await twoRuns();
    const cases = await casesRootWith(runsRoot);
    const copiedRuns = join(cases, "network-config-01", "runs");
    const receipts = [join(copiedRuns, a.runId, "receipt.json"), join(copiedRuns, b.runId, "receipt.json")];
    const rendered = await renderCombinedExports({ receiptPaths: receipts, repoUrl: REPO_URL });
    if (!rendered.ok) throw new Error(rendered.reason);
    const file = await writeCombinedExports(rendered);

    // Stale content: check fails, regenerate restores the exact bytes.
    await writeFile(file, "stale\n");
    expect((await checkAllCombined({ casesRoot: cases, repoUrl: REPO_URL }))[0]).toMatchObject({ ok: false, path: file, problem: "stale" });
    expect(await regenerateAllCombined({ casesRoot: cases, repoUrl: REPO_URL })).toEqual([{ path: file, ok: true, action: "written", detail: null }]);
    expect(await readFile(file, "utf8")).toBe(rendered.content);
    expect((await checkAllCombined({ casesRoot: cases, repoUrl: REPO_URL }))[0]).toMatchObject({ ok: true });

    // Unparseable name: both fail, nothing is touched.
    const bad = join(copiedRuns, "EVALS-garbage.md");
    await writeFile(bad, "x\n");
    const checked = await checkAllCombined({ casesRoot: cases, repoUrl: REPO_URL });
    expect(checked.find((r) => r.path === bad)).toMatchObject({ ok: false, problem: expect.stringMatching(/unparseable name/) });
    const regenerated = await regenerateAllCombined({ casesRoot: cases, repoUrl: REPO_URL });
    expect(regenerated.find((r) => r.path === bad)).toMatchObject({ ok: false, action: "failed" });
    expect(await readFile(bad, "utf8")).toBe("x\n");
    await rm(bad);

    // Missing member: both fail and the file is kept.
    const orphan = join(copiedRuns, combinedFileName([a.runId, "20261108T100099Z-abcdef99"]));
    await writeFile(orphan, "x\n");
    expect((await checkAllCombined({ casesRoot: cases, repoUrl: REPO_URL })).find((r) => r.path === orphan)).toMatchObject({
      ok: false,
      problem: "member run 20261108T100099Z-abcdef99 is missing",
    });
    expect((await regenerateAllCombined({ casesRoot: cases, repoUrl: REPO_URL })).find((r) => r.path === orphan)).toMatchObject({ ok: false, action: "failed" });
    expect(await readFile(orphan, "utf8")).toBe("x\n");
    await rm(orphan);

    // A combination that is now refused (same run twice cannot be named; use a run with a refused summary).
    let call = 0;
    const refusedRun = await seal({
      runsRoot,
      target: { provider: "google", model: "gemini-4-argon", thinking: "medium" },
      repetitions: 2,
      script: (request) => {
        call += 1;
        const infra = call === 3;
        return { outcome: infra ? "infrastructure-failure" : "completed", assistantText: infra ? "guest died" : `call-${call} (${request.conditionId})` };
      },
    });
    await cp(refusedRun.runDir, join(copiedRuns, refusedRun.runId), { recursive: true });
    const refusedFile = join(copiedRuns, combinedFileName([a.runId, refusedRun.runId]));
    await writeFile(refusedFile, "x\n");
    const refusedCheck = (await checkAllCombined({ casesRoot: cases, repoUrl: REPO_URL })).find((r) => r.path === refusedFile);
    expect(refusedCheck).toMatchObject({ ok: false, problem: expect.stringMatching(/^refused \(.*ungraded/) });
    const refusedWrite = (await regenerateAllCombined({ casesRoot: cases, repoUrl: REPO_URL })).find((r) => r.path === refusedFile);
    expect(refusedWrite).toMatchObject({ ok: true, action: "removed", detail: expect.stringMatching(/ungraded/) });
    await expect(lstat(refusedFile)).rejects.toThrow();
    // The good combination is still there and fresh.
    expect((await checkAllCombined({ casesRoot: cases, repoUrl: REPO_URL })).every((r) => r.ok)).toBe(true);
  });
});

describe("combined export guards", () => {
  it("refuses two runs with the same readable model label, naming the label", async () => {
    const runsRoot = await newRunsRoot();
    const a = await seal({ runsRoot, target: FLASH });
    const b = await seal({ runsRoot, target: { ...FLASH, thinking: "medium" } });
    const result = await renderCombinedExports({ receiptPaths: [a.receiptPath, b.receiptPath], repoUrl: REPO_URL });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain('labelled "Google Gemini 3.8 Flash"');
  });

  it("converts a renderer throw (differing frozen check lists) into a refusal", async () => {
    const runsRoot = await newRunsRoot();
    const a = await seal({ runsRoot, target: FLASH });
    const edited = await caseRoot("network-config-01", undefined, (rubric) => {
      rubric.topics[0]!.label = "Renamed topic";
    });
    const b = await seal({ runsRoot, target: ARGON, evalsRoot: edited });
    const result = await renderCombinedExports({ receiptPaths: [a.receiptPath, b.receiptPath], repoUrl: REPO_URL });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toMatch(/Outcome checks of case network-config-01 differ between/);
  });

  it("refuses a combination whose file name would exceed the file-name limit (with the staging prefix)", async () => {
    const runsRoot = await newRunsRoot();
    const sealed: Sealed[] = [];
    for (let i = 1; i <= 9; i += 1) sealed.push(await seal({ runsRoot, target: { provider: "google", model: `fake-model-${i}`, thinking: "low" } }));
    const result = await renderCombinedExports({ receiptPaths: sealed.map((r) => r.receiptPath), repoUrl: REPO_URL });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toMatch(/too long for a file name/);
    // Eight runs still fit.
    const eight = await renderCombinedExports({ receiptPaths: sealed.slice(0, 8).map((r) => r.receiptPath), repoUrl: REPO_URL });
    expect(eight.ok).toBe(true);
  });
});

describe("export.ts success paths (spawned, temp repo copy)", () => {
  /** A temp copy of the scripts and sources so `--all` walks a temp eval-cases tree, never the real one. */
  async function tempRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "eval-combined-repo-"));
    tempRoots.push(root);
    for (const name of ["scripts", "src", "container", "package.json"]) await cp(join(repoRoot, name), join(root, name), { recursive: true });
    await symlink(join(repoRoot, "node_modules"), join(root, "node_modules"));
    return root;
  }

  function exportCli(root: string, args: readonly string[]): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(process.execPath, ["--experimental-strip-types", join(root, "scripts/export.ts"), ...args], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: 120000,
        killSignal: "SIGKILL",
        env: buildAllowlistedEnv(tmpdir(), {}),
      });
      return { status: 0, stdout, stderr: "" };
    } catch (error: unknown) {
      const err = error as { status?: number; stdout?: string; stderr?: string };
      return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }

  it("reports a missing combined file with --check, writes it, checks it, and --all detects tampering and regenerates identical bytes", async () => {
    const root = await tempRepo();
    const runsRoot = join(root, "eval-cases", "network-config-01", "runs");
    const a = await seal({ runsRoot, target: FLASH });
    const b = await seal({ runsRoot, target: ARGON });
    const both = ["--receipt", a.receiptPath, "--receipt", b.receiptPath];
    const file = join(runsRoot, `EVALS-${a.runId}+${b.runId}.md`);

    // Absent file: --check exits 1 and says missing; nothing is created.
    const missing = exportCli(root, [...both, "--check"]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toMatch(/FAIL .*: missing/);
    await expect(lstat(file)).rejects.toThrow();

    // Write.
    const written = exportCli(root, both);
    expect(written.status, written.stderr).toBe(0);
    expect(written.stdout).toContain(`wrote ${file}`);
    const original = await readFile(file, "utf8");
    expect(original).toContain("Google Gemini 4 Argon");
    const fresh = exportCli(root, [...both, "--check"]);
    expect(fresh.status, fresh.stdout).toBe(0);
    expect(fresh.stdout).toContain(`ok     ${file}`);

    // Per-run exports so that `--all` has nothing else to complain about.
    for (const run of [a, b]) expect(exportCli(root, ["--receipt", run.receiptPath]).status).toBe(0);
    const allFresh = exportCli(root, ["--check", "--all"]);
    expect(allFresh.status, allFresh.stdout).toBe(0);
    expect(allFresh.stdout).toContain("EVALS-");

    // Tamper: --all fails and names the file as stale.
    await writeFile(file, `${original}tampered\n`);
    const stale = exportCli(root, ["--check", "--all"]);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toMatch(/FAIL .*EVALS-.*: stale/);

    // Regenerate restores the identical bytes; --all is clean again.
    const regenerated = exportCli(root, ["--regenerate", "--all"]);
    expect(regenerated.status, regenerated.stdout).toBe(0);
    expect(await readFile(file, "utf8")).toBe(original);
    const clean = exportCli(root, ["--check", "--all"]);
    expect(clean.status, clean.stdout).toBe(0);

    // A deleted file is invisible to --all (nothing records it) but not to the explicit check; the write form recreates it.
    await rm(file);
    expect(exportCli(root, ["--check", "--all"]).status).toBe(0);
    expect(exportCli(root, [...both, "--check"]).status).toBe(1);
    expect(exportCli(root, both).status).toBe(0);
    expect(await readFile(file, "utf8")).toBe(original);
  }, 180000);
});

describe("exportCombinedForRuns", () => {
  it("writes the file for complete runs and words a missing receipt by whether the model was started", async () => {
    const { runsRoot, a, b } = await twoRuns();
    const ok = await exportCombinedForRuns({
      runs: [
        { label: "Flash", receiptPath: a.receiptPath, notStarted: false },
        { label: "Argon", receiptPath: b.receiptPath, notStarted: false },
      ],
      repoUrl: REPO_URL,
    });
    expect(ok).toEqual({ ok: true, path: join(runsRoot, `EVALS-${a.runId}+${b.runId}.md`) });
    expect(await exportCombinedForRuns({ runs: [{ label: "Flash", receiptPath: a.receiptPath, notStarted: false }, { label: "Argon", receiptPath: null, notStarted: true }], repoUrl: REPO_URL })).toEqual({ ok: false, reason: "Argon was not run" });
    expect(await exportCombinedForRuns({ runs: [{ label: "Flash", receiptPath: null, notStarted: false }, { label: "Argon", receiptPath: b.receiptPath, notStarted: false }], repoUrl: REPO_URL })).toEqual({ ok: false, reason: "Flash did not produce a sealed receipt" });
    const unreadable = await exportCombinedForRuns({ runs: [{ label: "A", receiptPath: join(runsRoot, "nope", "receipt.json"), notStarted: false }, { label: "B", receiptPath: b.receiptPath, notStarted: false }], repoUrl: REPO_URL });
    expect(unreadable.ok).toBe(false);
  });
});
