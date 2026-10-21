/**
 * Run-folder exports: EVALS.md and EVALS-FULL-REPORT.md next to receipt.json.
 * Fixture skills only; the repository URL is always injected.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runIdFor } from "../core/experiment.ts";
import type { FakeHarnessScript } from "../harnesses/fake.ts";
import { createFakeHarness } from "../harnesses/fake.ts";
import { createFakeSandbox } from "../sandboxes/fake.ts";
import { createInProcessValidatorRunner } from "../runner/validation.ts";
import { disposeRunWorkDir, runPairedEvaluation } from "../runner/run.ts";
import type { RunResult } from "../runner/run.ts";
import { verifyRun } from "./queries.ts";
import { checkRunExports, renderRunExports, runRepoRelativeDir, writeRunExports } from "./run-exports.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const REPO_URL = "https://github.com/example/evals";
const tempRoots: string[] = [];
const workDirs: string[] = [];

afterAll(async () => {
  for (const dir of workDirs) await disposeRunWorkDir(dir).catch(() => {});
  for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function sealRun(script?: FakeHarnessScript, repetitions = 1): Promise<RunResult> {
  const root = await mkdtemp(join(tmpdir(), "eval-run-exports-"));
  tempRoots.push(root);
  const workDir = await mkdtemp(join(tmpdir(), "eval-run-exports-work-"));
  workDirs.push(workDir);
  return runPairedEvaluation({
    evalsRoot: repoRoot,
    repoRoot,
    caseSelector: "network-config-01",
    skillPath: "src/test-fixtures/skills/mcp-skill",
    mode: "fake",
    repetitions,
    cliLimits: {},
    target: { provider: "google", model: "fake-model-0", thinking: "off" },
    runId: runIdFor(new Date(0), "abcdef12"),
    resourceNonce: "0a1b2c3d",
    createdAt: new Date(0).toISOString(),
    source: { revision: "0".repeat(40), dirty: false },
    evaluatorBuild: "evals-src@test",
    harness: createFakeHarness(script === undefined ? {} : { script }),
    sandbox: createFakeSandbox(),
    validatorRunner: createInProcessValidatorRunner(),
    workDir,
    runsRoot: join(root, "runs"),
    stateDir: join(root, ".state"),
  });
}

const golden = (name: string, actual: string): void => {
  const path = new URL(`./__golden__/${name}`, import.meta.url);
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(path, actual);
  expect(actual).toBe(readFileSync(path, "utf8"));
};

/** Stable placeholders for the values a fake run measures at run time. */
function normalize(text: string): string {
  return text
    .replace(/\b[0-9a-f]{64}\b/g, "<sha256>")
    .replace(/ · Hash: [0-9a-f]{64}/g, " · Hash: <hash>")
    .replace(/durationMs=(\d+|null)/g, "durationMs=<ms>")
    .replace(/^- Elapsed: .*$/gm, "- Elapsed: <elapsed>");
}

const mixedScript = (): FakeHarnessScript => {
  let call = 0;
  return (request) => {
    call += 1;
    const infra = call === 3; // pair 2's baseline
    return {
      outcome: infra ? "infrastructure-failure" : "completed",
      assistantText: infra ? "guest died" : `call-${call} (${request.conditionId})`,
    };
  };
};

describe("run-folder exports", () => {
  it("writes both files next to receipt.json, regenerates identical bytes, and keeps the run verifiable", async () => {
    const result = await sealRun(undefined, 3);
    const first = await renderRunExports(result.receiptPath, { repoUrl: REPO_URL });
    await writeRunExports(result.runDir, first);
    const summaryBytes = await readFile(join(result.runDir, "EVALS.md"), "utf8");
    const fullBytes = await readFile(join(result.runDir, "EVALS-FULL-REPORT.md"), "utf8");
    expect(summaryBytes).toBe(first.summary);
    expect(fullBytes).toBe(first.full);
    expect((await lstat(join(result.runDir, "EVALS.md"))).mode & 0o777).toBe(0o644);

    expect((await verifyRun(result.runDir)).ok).toBe(true);
    await writeRunExports(result.runDir, await renderRunExports(result.receiptPath, { repoUrl: REPO_URL }));
    expect(await readFile(join(result.runDir, "EVALS.md"), "utf8")).toBe(summaryBytes);
    expect(await readFile(join(result.runDir, "EVALS-FULL-REPORT.md"), "utf8")).toBe(fullBytes);
    expect(await checkRunExports(result.receiptPath, { repoUrl: REPO_URL })).toEqual({ ok: true, missing: [], stale: [], unexpected: [] });
    // No staging debris is left behind.
    expect((await readdir(join(result.runDir, "views"))).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
  });

  it("matches the mean full-report golden and links the summary to the full report", async () => {
    const result = await sealRun(undefined, 3);
    const exports = await renderRunExports(result.receiptPath, { repoUrl: REPO_URL });
    golden("evals-full-report.mean.md", normalize(exports.full));
    expect(exports.summary).toContain(
      `${REPO_URL}/blob/HEAD/eval-cases/network-config-01/runs/${result.runId}/EVALS-FULL-REPORT.md`,
    );
    expect(exports.summary).not.toContain("AF-EVAL");
  });

  it("embeds the sealed run-binding hashes, a verify section and the export guidance", async () => {
    const result = await sealRun();
    const receipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as { manifest: { treeSha256: string; fileSha256: string } };
    const { full, summary } = await renderRunExports(result.receiptPath, { repoUrl: REPO_URL });
    expect(full).toContain(`Run hash (manifest tree sha256): ${receipt.manifest.treeSha256}`);
    expect(full).toContain(`Receipt manifest file sha256: ${receipt.manifest.fileSha256}`);
    expect(full).toContain("## Verify this report");
    expect(full).toContain(`pnpm eval:report -- --receipt eval-cases/network-config-01/runs/${result.runId}/receipt.json --checks`);
    expect(full).toContain("**`EVALS.md` is the file to export or copy into the skills repository.**");
    expect(summary).toContain(` · Hash: ${receipt.manifest.treeSha256}  \n`);
    expect(summary).not.toContain("Status:");
    expect(full).not.toContain("## Per-pair results");
    expect(full).not.toMatch(/determinis|--from|guarantee/i);
  });

  it("detects a stale, missing, or non-regular export", async () => {
    const result = await sealRun();
    await writeRunExports(result.runDir, await renderRunExports(result.receiptPath, { repoUrl: REPO_URL }));
    const summaryPath = join(result.runDir, "EVALS.md");
    const original = await readFile(summaryPath, "utf8");

    await writeFile(summaryPath, original.replace("Accuracy", "Accuracv"));
    expect(await checkRunExports(result.receiptPath, { repoUrl: REPO_URL })).toMatchObject({ ok: false, stale: ["EVALS.md"] });

    await rm(summaryPath);
    expect(await checkRunExports(result.receiptPath, { repoUrl: REPO_URL })).toMatchObject({ ok: false, missing: ["EVALS.md"] });

    // A different repository URL changes the link, so the files are stale for it.
    await writeFile(summaryPath, original);
    expect((await checkRunExports(result.receiptPath, { repoUrl: "https://github.com/other/repo" })).stale).toContain("EVALS.md");

    await rm(summaryPath);
    await mkdir(join(result.runDir, "views"), { recursive: true });
    await writeFile(join(result.runDir, "views", "elsewhere.md"), original);
    await symlink(join(result.runDir, "views", "elsewhere.md"), summaryPath);
    // A symlinked export breaks verification itself, so the check refuses outright.
    await expect(checkRunExports(result.receiptPath, { repoUrl: REPO_URL })).rejects.toThrow(/verification failed/);
  });

  it("refuses to write over a symlink or directory", async () => {
    const result = await sealRun();
    const exports = await renderRunExports(result.receiptPath, { repoUrl: REPO_URL });
    const elsewhere = join(result.runDir, "views", "elsewhere.md");
    await mkdir(join(result.runDir, "views"), { recursive: true });
    await writeFile(elsewhere, "x");
    await symlink(elsewhere, join(result.runDir, "EVALS.md"));
    await expect(writeRunExports(result.runDir, exports)).rejects.toThrow(/not a regular file/);
    await rm(join(result.runDir, "EVALS.md"));
    await rm(join(result.runDir, "EVALS-FULL-REPORT.md"), { force: true });
    await mkdir(join(result.runDir, "EVALS-FULL-REPORT.md"));
    await expect(writeRunExports(result.runDir, exports)).rejects.toThrow(/not a regular file/);
    expect(await readFile(elsewhere, "utf8")).toBe("x");
  });

  it("every non-heading, non-link line of EVALS.md appears in order in the full report", async () => {
    for (const repetitions of [1, 3]) {
      const result = await sealRun(undefined, repetitions);
      const { summary, full } = await renderRunExports(result.receiptPath, { repoUrl: REPO_URL });
      let cursor = 0;
      const fullLines = full.split("\n");
      for (const line of summary!.split("\n")) {
        if (line.trim() === "" || line.startsWith("#") || line.includes("http")) continue;
        const at = fullLines.indexOf(line, cursor);
        expect(at, `missing in full report: ${line}`).toBeGreaterThanOrEqual(0);
        cursor = at + 1;
      }
    }
  });

  it("labels test-double evidence in both files", async () => {
    const result = await sealRun();
    const { summary, full } = await renderRunExports(result.receiptPath, { repoUrl: REPO_URL });
    expect(summary!.split("\n")[0]).toBe("> **Warning:** TEST-DOUBLE EVIDENCE — synthetic scores, not a measured result");
    expect(full.split("\n")[0]).toBe(summary!.split("\n")[0]);
  });

  it("writes the full report only, with the reason, when an arm is ungraded; removes a stale EVALS.md", async () => {
    const result = await sealRun(mixedScript(), 3);
    const exports = await renderRunExports(result.receiptPath, { repoUrl: REPO_URL });
    expect(exports.summary).toBeNull();
    expect(exports.summaryRefusal).toMatch(/pair r002 has ungraded arm\(s\): baseline/);
    expect(exports.full).toContain("EVALS.md was not generated: pair r002 has ungraded arm(s): baseline");
    expect(exports.full).toContain("## Per-pair results");
    expect(exports.full).toContain("Not gradeable:");

    await writeFile(join(result.runDir, "EVALS.md"), "stale\n");
    expect(await checkRunExports(result.receiptPath, { repoUrl: REPO_URL })).toMatchObject({ ok: false, unexpected: ["EVALS.md"], missing: ["EVALS-FULL-REPORT.md"] });
    await writeRunExports(result.runDir, exports);
    await expect(lstat(join(result.runDir, "EVALS.md"))).rejects.toThrow();
    expect((await checkRunExports(result.receiptPath, { repoUrl: REPO_URL })).ok).toBe(true);
  });

  it("refuses to render exports over broken evidence", async () => {
    const result = await sealRun();
    await mkdir(join(result.runDir, "EVALS.md"));
    await expect(renderRunExports(result.receiptPath, { repoUrl: REPO_URL })).rejects.toThrow(/verification failed/);
  });

  it("contains no host paths in either file", async () => {
    for (const repetitions of [1, 3]) {
      const result = await sealRun(undefined, repetitions);
      const { summary, full } = await renderRunExports(result.receiptPath, { repoUrl: REPO_URL });
      const runsRoot = dirname(result.runDir);
      for (const text of [summary!, full]) {
        expect(text).not.toContain(tmpdir());
        expect(text).not.toContain(homedir());
        expect(text).not.toContain(runsRoot);
        expect(text).not.toContain(repoRoot);
        expect(text).not.toContain(result.receiptPath);
        expect(text).not.toMatch(/(^|[\s"'(`=])\/(Users|home|tmp|private|var|opt)\//m);
      }
    }
  });

  it("runRepoRelativeDir fails closed on a mismatched directory name", () => {
    expect(runRepoRelativeDir({ caseId: "c", runId: "r1", runDir: "/x/runs/r1" })).toBe("eval-cases/c/runs/r1");
    expect(() => runRepoRelativeDir({ caseId: "c", runId: "r1", runDir: "/x/runs/other" })).toThrow();
  });
});

describe("eval:export --regenerate / --check subprocess", () => {
  it("regenerates then checks a run folder and fails --check after tampering", async () => {
    const result = await sealRun();
    const script = join(repoRoot, "scripts", "export.ts");
    const run = (...args: string[]): string =>
      execFileSync(process.execPath, ["--experimental-strip-types", script, "--receipt", result.receiptPath, "--repo-url", REPO_URL, ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    expect(() => run("--check")).toThrow();
    expect(run("--regenerate")).toContain("EVALS.md, EVALS-FULL-REPORT.md");
    expect(run("--check")).toContain("ok");
    await writeFile(join(result.runDir, "EVALS-FULL-REPORT.md"), "tampered\n");
    expect(() => run("--check")).toThrow(/not fresh|stale/);
  });
});
