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
import { buildRunReport, verifyRun } from "./queries.ts";
import { buildScoredReport } from "./scored-report.ts";
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
    .replace(/^\| Elapsed \| .* \|$/gm, "| Elapsed | <elapsed> |");
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
    expect(full).toContain(`| Run hash (manifest tree sha256) | \`${receipt.manifest.treeSha256}\` |`);
    expect(full).toContain(`| Receipt manifest file sha256 | \`${receipt.manifest.fileSha256}\` |`);
    expect(full).toContain("## Verify this report");
    expect(full).toContain(`pnpm eval:report -- --receipt eval-cases/network-config-01/runs/${result.runId}/receipt.json --checks`);
    expect(full).toContain("**`EVALS.md` is the file to export or copy into the skills repository.**");
    // The summary keeps the exact tree hash only in a non-visible, entry-bound comment.
    expect(summary).toContain(
      `<!-- EVALS-ENTRY case=network-config-01 run=${result.runId} selection=single pairs=${result.runId}-r001 treeSha256=${receipt.manifest.treeSha256} -->`,
    );
    expect(summary!.replace(/<!--[\s\S]*?-->/g, "")).not.toContain(receipt.manifest.treeSha256);
    expect(summary).not.toContain("Status:");
    expect(summary).not.toMatch(/Hash:|Run:|Agent:|AF-Evaluation|img\.shields/);
    expect(full).not.toContain("## Per-pair results");
    expect(full).toContain("## Pair explorer");
    expect(full).not.toMatch(/determinis|--from|guarantee/i);
  });

  it("lists every recorded pair once, for one, three and more than ten pairs, with no operational dump", async () => {
    for (const repetitions of [1, 3, 11]) {
      const result = await sealRun(undefined, repetitions);
      const report = await buildRunReport(result.receiptPath);
      const { full } = await renderRunExports(result.receiptPath, { repoUrl: REPO_URL });
      const labels = report.pairs.map((pair) => pair.pairId.slice(pair.pairId.lastIndexOf("-") + 1));
      expect(labels).toHaveLength(repetitions);
      const headings = full.split("\n").filter((line) => /^#{1,3} /.test(line));
      expect(headings).toEqual([
        "# Network configuration migration — Full evaluation report",
        "## Results",
        "### Execution status",
        "### Score composition",
        "### Outcome Checks",
        "### Cost and latency detail",
        "## Pair explorer",
        ...labels.map((label) => `### ${label}`),
        "## Task and rubric",
        "### Scoring rules and interpretation",
        "### Frozen checks and weights",
        "## Execution environment",
        "## Verify this report",
        "## Export and comparable runs",
        "### Export",
        "### Reproducibility",
      ]);
      expect([...full.matchAll(/^\| \[(r\d+)\]\(#(r\d+)\) \|/gm)].map((m) => [m[1], m[2]])).toEqual(labels.map((l) => [l, l]));
      for (const pair of report.pairs) expect(full.match(new RegExp(`Pair ID: \`${pair.pairId}\``, "g"))).toHaveLength(1);
      expect(full.match(/<details>/g)).toHaveLength(repetitions);
      expect(full.match(/<\/details>/g)).toHaveLength(repetitions);
      expect(full.match(/\*\*Score composition\*\*/g)).toHaveLength(repetitions);
      expect(full.match(/\*\*Outcome Checks\*\*/g)).toHaveLength(repetitions);
      expect(full.match(/\*\*Cost and latency\*\*/g)).toHaveLength(repetitions);
      expect(full).toContain(`| Pairs | ${labels.join(", ")} |`);
      expect(full).toContain(`--pair ${labels[0]}\n`);
      expect(full).toContain(`| Repetitions | ${repetitions} |`);
      // The runtime dump and its anchors are not part of this document.
      expect(full).not.toMatch(/Operational|Runtime r\d|#runtime|toolSteps|providerRequests|redactions=|cleanup=|stopCause/i);
      expect(full).not.toContain("AF-EVAL:");
    }
  });

  it("keeps every pair visible and withholds the aggregate Score change when grading is partial", async () => {
    const result = await sealRun(mixedScript(), 3);
    const { full, summary } = await renderRunExports(result.receiptPath, { repoUrl: REPO_URL });
    expect(summary).not.toBeNull();
    expect(full).not.toContain("EVALS.md was not generated");
    expect(full).toContain("Grading is incomplete: Baseline is graded in 1 of 3 pairs and Treatment in 1.");
    expect(full).not.toMatch(/All pairs are graded|Means across all/);
    expect(full).toMatch(/\| Score \| [^|]+ \| [^|]+ \| n\/a \|/);
    expect(full).not.toContain("percentage points");
    expect(full).toContain("| Baseline | Completed in 1 of 3 pairs; infrastructure failure in 1; not started in 1 | Graded in 1 of 3 pairs |");
    expect(full).toContain("| Treatment | Not started in 2 of 3 pairs; completed in 1 | Graded in 1 of 3 pairs |");
    expect(full).toContain("1 of 3 pairs have both arms graded");
    expect(full).toContain("| [r002](#r002) | n/a | n/a | Infrastructure failure (not graded) | Not started (not graded) |");
    expect(full).toContain("| [r003](#r003) | n/a | n/a | Not started (not graded) | Not started (not graded) |");
    // Every recorded pair keeps its own block, and an ungraded pair shows unavailable cells, never zero.
    for (const label of ["r001", "r002", "r003"]) expect(full).toContain(`### ${label}\n`);
    const r002 = full.slice(full.indexOf("### r002\n"), full.indexOf("### r003\n"));
    expect(r002).toContain("Not a valid comparison:");
    expect(r002).toContain("Status: Baseline: infrastructure failure, grading unavailable · Treatment: not started, grading unavailable");
    expect(r002).toContain("| **Score total** | **n/a** | **n/a** |");
    expect(r002).toContain("| **Outcome total** | **n/a** | **n/a** |");
  });

  it("explains the Score change in percentage points for a single pair", async () => {
    const result = await sealRun((request) => ({
      outcome: request.conditionId === "baseline" ? "task-limit" : "completed",
      assistantText: request.conditionId === "baseline" ? "limit" : "done",
    }));
    const { full } = await renderRunExports(result.receiptPath, { repoUrl: REPO_URL });
    expect(full).toContain("Results of the single pair r001.");
    expect(full).toContain("| Baseline | Task limit reached | Graded |");
    expect(full).toContain("| Treatment | Completed | Graded |");
    expect(full).toContain("Status: Baseline: task limit reached, graded · Treatment: completed, graded");
    expect(full).not.toMatch(/AF-Evaluation|AF--Evaluation|img\.shields/);
    expect(full).toMatch(/The Score change is \*\*0%\*\*, meaning \*\*0 percentage points\*\* \(\d+% − \d+%\)/);
  });

  it("detects a stale, missing, or non-regular export", async () => {
    const result = await sealRun();
    await writeRunExports(result.runDir, await renderRunExports(result.receiptPath, { repoUrl: REPO_URL }));
    const summaryPath = join(result.runDir, "EVALS.md");
    const original = await readFile(summaryPath, "utf8");

    await writeFile(summaryPath, original.replace("Outcome total", "Outcome totaI"));
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

  it("summary and full report agree on the metrics, outcome points, model and source hash", async () => {
    for (const repetitions of [1, 3]) {
      const result = await sealRun(undefined, repetitions);
      const { summary, full } = await renderRunExports(result.receiptPath, { repoUrl: REPO_URL });
      const report = await buildRunReport(result.receiptPath);
      const { pillars, treatmentAccuracy, baselineAccuracy } = report.scored!;
      // Metrics: the same cells as the full report's pillar table.
      expect(summary).toContain(`| ${pillars.cost.baseline} → ${pillars.cost.treatment}<br>${pillars.cost.change} |`);
      expect(summary).toContain(`| ${pillars.latency.baseline} → ${pillars.latency.treatment}<br>${pillars.latency.change} |`);
      expect(full).toContain(`| ${pillars.cost.label} | ${pillars.cost.baseline} | ${pillars.cost.treatment} | ${pillars.cost.change} |`);
      expect(summary).toContain(`| ${pillars.accuracy.baseline} → ${pillars.accuracy.treatment}<br>`);
      // Outcome points: every row of the full report's check table appears with the same points.
      const outcomeMax = treatmentAccuracy!.outcome.max;
      const totalB = `${baselineAccuracy!.outcome.got}/${outcomeMax}`;
      const totalT = `${treatmentAccuracy!.outcome.got}/${outcomeMax}`;
      expect(summary).toContain(`**${totalB === totalT ? totalT : `${totalB} → ${totalT}`}**`);
      for (const row of report.scored!.checksTable!.rows) {
        expect(summary).toContain(`| ${row.label} | ${row.baseline === row.treatment ? row.baseline : `${row.baseline} → ${row.treatment}`} |`);
        expect(full).toContain(`| ${row.label} | ${row.baseline} | ${row.treatment} |`);
      }
      expect(summary).toContain("Google Fake Model 0");
      expect(summary).toContain(`treeSha256=${report.receiptManifest!.treeSha256}`);
      expect(full).toContain(report.receiptManifest!.treeSha256);
      expect(summary!.trimEnd().split("\n").filter((l) => l !== "" && !l.startsWith("<!--")).at(-1)).toMatch(/^\| network-config-01 \| Google Fake Model 0 \| \[View full report\]\(/);
    }
  });

  it("labels test-double evidence in both files", async () => {
    const result = await sealRun();
    const { summary, full } = await renderRunExports(result.receiptPath, { repoUrl: REPO_URL });
    expect(summary!.split("\n")[0]).toBe("> **Warning:** TEST-DOUBLE EVIDENCE — synthetic scores, not a measured result");
    expect(full.split("\n")[0]).toBe(summary!.split("\n")[0]);
  });

  it("writes EVALS.md over the graded pairs of a partial run and the full report keeps every pair", async () => {
    const result = await sealRun(mixedScript(), 3);
    const exports = await renderRunExports(result.receiptPath, { repoUrl: REPO_URL });
    expect(exports.summary).not.toBeNull();
    expect(exports.summaryRefusal).toBeNull();
    expect(exports.full).toContain("## Pair explorer");
    expect(exports.full).toContain("Not a valid comparison:");
    await writeRunExports(result.runDir, exports);
    expect(await readFile(join(result.runDir, "EVALS.md"), "utf8")).toBe(exports.summary);
    expect((await checkRunExports(result.receiptPath, { repoUrl: REPO_URL })).ok).toBe(true);
  });

  it("computes every EVALS.md metric over the pairs graded in both arms only", async () => {
    // Pair 3's treatment fails (infrastructure) while its baseline completes with a broken file:
    // that baseline result must not enter the baseline mean.
    const counts = { baseline: 0, treatment: 0 };
    const script: FakeHarnessScript = (request) => {
      counts[request.conditionId as "baseline" | "treatment"] += 1;
      const n = counts[request.conditionId as "baseline" | "treatment"];
      if (n === 3 && request.conditionId === "treatment") return { outcome: "infrastructure-failure", assistantText: "guest died" };
      if (n === 3) return { outcome: "completed", assistantText: "broken", writes: [{ path: "config.json", text: "not json" }] };
      return { outcome: "completed", assistantText: "ok" };
    };
    const result = await sealRun(script, 3);
    const report = await buildRunReport(result.receiptPath);
    const ungraded = report.pairs.filter((pair) => pair.conditions.some((c) => !(c.gradeable && c.rubricScore != null)));
    expect(ungraded.map((pair) => pair.pairId)).toEqual([`${result.runId}-r003`]);
    const { summary } = await renderRunExports(result.receiptPath, { repoUrl: REPO_URL });
    expect(summary).not.toBeNull();

    // The same run restricted to its two graded pairs is the reference mean for both arms.
    const included = report.pairs.filter((pair) => !ungraded.includes(pair));
    const reference = buildScoredReport(report, report.scored!.rubric!, { mode: "mean", pairs: included });
    const all = report.scored!.pillars.accuracy;
    // Guard: including the ungraded pair's treatment would have changed the baseline score.
    expect(all.baseline).not.toBe(reference.pillars.accuracy.baseline);
    expect(summary).toContain(`| ${reference.pillars.accuracy.baseline} → ${reference.pillars.accuracy.treatment}<br>`);
    expect(summary).not.toContain(`| ${all.baseline} → ${all.treatment}<br>`);
    expect(summary).toContain("Metrics are means across two of three pairs; pair r003 is excluded because its treatment arm was not graded.");
    expect(summary).toContain(`selection=mean pairs=${included.map((pair) => pair.pairId).join(",")} `);
    expect(summary).not.toContain(`${result.runId}-r003`);
    const totalB = reference.baselineAccuracy!.outcome.got;
    const totalT = reference.treatmentAccuracy!.outcome.got;
    const max = reference.treatmentAccuracy!.outcome.max;
    expect(summary).toContain(`**${totalB === totalT ? `${totalT}/${max}` : `${totalB}/${max} → ${totalT}/${max}`}**`);
  });

  it("matches the partial-run summary golden", async () => {
    const counts = { baseline: 0, treatment: 0 };
    const script: FakeHarnessScript = (request) => {
      const id = request.conditionId as "baseline" | "treatment";
      counts[id] += 1;
      if (counts[id] === 3 && id === "treatment") return { outcome: "infrastructure-failure", assistantText: "guest died" };
      if (counts[id] === 3) return { outcome: "completed", assistantText: "broken", writes: [{ path: "config.json", text: "not json" }] };
      return { outcome: "completed", assistantText: "ok" };
    };
    const result = await sealRun(script, 3);
    const { summary } = await renderRunExports(result.receiptPath, { repoUrl: REPO_URL });
    golden("evals-summary.partial.md", normalize(summary!).replaceAll(result.runId, "<run-id>"));
  });

  it("refuses EVALS.md when no pair is graded in both arms, and removes a stale EVALS.md", async () => {
    const result = await sealRun((request) =>
      request.conditionId === "baseline"
        ? { outcome: "infrastructure-failure", assistantText: "guest died" }
        : { outcome: "completed", assistantText: "done" },
    );
    const exports = await renderRunExports(result.receiptPath, { repoUrl: REPO_URL });
    expect(exports.summary).toBeNull();
    expect(exports.summaryRefusal).toBe(`no pair of run ${result.runId} is graded in both arms; EVALS.md is not generated`);
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
