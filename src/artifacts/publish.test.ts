import { execFileSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { runIdFor } from "../core/experiment.ts";
import { createFakeHarness } from "../harnesses/fake.ts";
import type { FakeHarnessScript } from "../harnesses/fake.ts";
import { createFakeSandbox } from "../sandboxes/fake.ts";
import { createInProcessValidatorRunner } from "../runner/validation.ts";
import { disposeRunWorkDir, runPairedEvaluation } from "../runner/run.ts";
import type { RunResult } from "../runner/run.ts";
import { buildRunReport, formatRunReport, inspectCondition } from "./queries.ts";
import {
  EVAL_BEGIN_MARKER,
  EVAL_END_MARKER,
  exportRun,
  replaceGeneratedSection,
} from "./publish.ts";
import { createSkillSnapshot } from "../runner/skill-snapshot.ts";
import { EvalError } from "../core/types.ts";
import { buildRunReportUrl } from "../core/report-links.ts";
import { renderRunExports, writeRunExports } from "./run-exports.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const evalsRoot = repoRoot;
const REPO_URL = "https://github.com/example/evals";

const tempRoots: string[] = [];
const workDirs: string[] = [];

afterAll(async () => {
  for (const dir of workDirs) {
    await disposeRunWorkDir(dir).catch(() => {});
  }
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

async function sealRun(script?: FakeHarnessScript, repetitions: number = 1, withExports: boolean = true): Promise<RunResult> {
  const result = await sealRunRaw(script, repetitions);
  if (withExports) await writeRunExports(result.runDir, await renderRunExports(result.receiptPath, { repoUrl: REPO_URL }));
  return result;
}

async function sealRunRaw(script?: FakeHarnessScript, repetitions: number = 1): Promise<RunResult> {
  const root = await mkdtemp(join(tmpdir(), "eval-publish-test-"));
  tempRoots.push(root);
  const workDir = await mkdtemp(join(tmpdir(), "eval-publish-work-"));
  workDirs.push(workDir);
  const nonce = randomBytes(4).toString("hex");
  // Recorded sourcePath stays `skills/arbitrum-docs`, copied from the synthetic fixture so
  // the test never depends on the real skills repository.
  const skillRepo = await mkdtemp(join(tmpdir(), "eval-publish-skill-"));
  tempRoots.push(skillRepo);
  await cp(join(repoRoot, "src", "test-fixtures", "skills", "mcp-skill"), join(skillRepo, "skills", "arbitrum-docs"), { recursive: true });
  return runPairedEvaluation({
    evalsRoot,
    repoRoot: skillRepo,
    caseSelector: "network-config-01",
    skillPath: "skills/arbitrum-docs",
    mode: "fake",
    target: { provider: "google", model: "fake-model-0", thinking: "off" },
    runId: runIdFor(new Date(), nonce),
    resourceNonce: nonce,
    createdAt: new Date().toISOString(),
    source: { revision: "0".repeat(40), dirty: false },
    evaluatorBuild: "evals-src@test",
    harness: createFakeHarness(script === undefined ? {} : { script }),
    sandbox: createFakeSandbox(),
    validatorRunner: createInProcessValidatorRunner(),
    repetitions,
    cliLimits: {},
    workDir,
    runsRoot: join(root, "runs"),
    stateDir: join(root, ".state"),
  });
}

describe("replaceGeneratedSection", () => {
  it("replaces existing generated section between markers without altering authored notes before or after", () => {
    const original = `# arbitrum-docs — evaluation results

Introductory note before markers.

${EVAL_BEGIN_MARKER}
Old generated results to be replaced
${EVAL_END_MARKER}

## Authored coverage notes
These authored notes must remain intact.
`;
    const newMarkdown = "## New Report\nNew score table";
    const result = replaceGeneratedSection(original, newMarkdown);

    expect(result).toContain("# arbitrum-docs — evaluation results\n\nIntroductory note before markers.");
    expect(result).toContain(EVAL_BEGIN_MARKER);
    expect(result).toContain("## New Report\nNew score table");
    expect(result).toContain(EVAL_END_MARKER);
    expect(result).toContain("## Authored coverage notes\nThese authored notes must remain intact.");
    expect(result).not.toContain("Old generated results to be replaced");

    // Exactly one begin marker and one end marker
    expect(result.split(EVAL_BEGIN_MARKER).length - 1).toBe(1);
    expect(result.split(EVAL_END_MARKER).length - 1).toBe(1);
  });

  it("is idempotent: replacing twice produces identical content", () => {
    const original = `# arbitrum-docs — evaluation results

Author notes.

${EVAL_BEGIN_MARKER}
Initial content
${EVAL_END_MARKER}

Footer notes.
`;
    const newMarkdown = "# EVALS.MD: Network Config\nScore: 100%";
    const first = replaceGeneratedSection(original, newMarkdown);
    const second = replaceGeneratedSection(first, newMarkdown);
    expect(second).toBe(first);
  });

  it("inserts generated section after top H1 title when markers are absent, preserving all authored text", () => {
    const original = `# arbitrum-docs — evaluation results

The current case asks an agent to migrate configuration.

## Capability-to-case map
Some capability notes.
`;
    const newMarkdown = "# EVALS.MD: Network Config\nScore: 100%";
    const result = replaceGeneratedSection(original, newMarkdown);

    expect(result.startsWith("# arbitrum-docs — evaluation results\n\n" + EVAL_BEGIN_MARKER)).toBe(true);
    expect(result).toContain(EVAL_END_MARKER);
    expect(result).toContain("The current case asks an agent to migrate configuration.");
    expect(result).toContain("## Capability-to-case map\nSome capability notes.");

    // Subsequent call replaces in-place idempotently
    const second = replaceGeneratedSection(result, newMarkdown);
    expect(second).toBe(result);
  });

  it("prepends generated section when original content has no leading H1 title and no markers", () => {
    const original = "Just some notes without a top title.\n";
    const newMarkdown = "New Report";
    const result = replaceGeneratedSection(original, newMarkdown);

    expect(result.startsWith(EVAL_BEGIN_MARKER)).toBe(true);
    expect(result).toContain("Just some notes without a top title.");
  });

  it("creates clean section when original content is empty", () => {
    const result = replaceGeneratedSection("", "New Report");
    expect(result).toBe(`${EVAL_BEGIN_MARKER}\nNew Report\n${EVAL_END_MARKER}\n`);
  });

  it("rejects duplicate BEGIN markers with input-invalid EvalError", () => {
    const original = `# Title

<!-- AF-EVAL:BEGIN generated -->
First
<!-- AF-EVAL:BEGIN generated -->
Second
<!-- AF-EVAL:END generated -->
`;
    expect(() => replaceGeneratedSection(original, "Report")).toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "input-invalid",
        message: expect.stringContaining("duplicate markers detected"),
      }),
    );
  });

  it("rejects duplicate END markers with input-invalid EvalError", () => {
    const original = `# Title

<!-- AF-EVAL:BEGIN generated -->
First
<!-- AF-EVAL:END generated -->
Second
<!-- AF-EVAL:END generated -->
`;
    expect(() => replaceGeneratedSection(original, "Report")).toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "input-invalid",
        message: expect.stringContaining("duplicate markers detected"),
      }),
    );
  });

  it("rejects duplicate marker sections with input-invalid EvalError", () => {
    const original = `# Title

<!-- AF-EVAL:BEGIN generated -->
First
<!-- AF-EVAL:END generated -->

<!-- AF-EVAL:BEGIN generated -->
Second
<!-- AF-EVAL:END generated -->
`;
    expect(() => replaceGeneratedSection(original, "Report")).toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "input-invalid",
        message: expect.stringContaining("duplicate markers detected"),
      }),
    );
  });

  it("rejects unpaired BEGIN marker with input-invalid EvalError", () => {
    const original = `# Title

<!-- AF-EVAL:BEGIN generated -->
First without end
`;
    expect(() => replaceGeneratedSection(original, "Report")).toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "input-invalid",
        message: expect.stringContaining("unpaired BEGIN marker"),
      }),
    );
  });

  it("rejects unpaired END marker with input-invalid EvalError", () => {
    const original = `# Title

First without begin
<!-- AF-EVAL:END generated -->
`;
    expect(() => replaceGeneratedSection(original, "Report")).toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "input-invalid",
        message: expect.stringContaining("unpaired END marker"),
      }),
    );
  });

  it("rejects reversed markers (END before BEGIN) with input-invalid EvalError", () => {
    const original = `# Title

<!-- AF-EVAL:END generated -->
Middle
<!-- AF-EVAL:BEGIN generated -->
`;
    expect(() => replaceGeneratedSection(original, "Report")).toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "input-invalid",
        message: expect.stringContaining("reversed markers"),
      }),
    );
  });

  it("rejects malformed or unrecognized AF-EVAL comment markers with input-invalid EvalError", () => {
    const malformed1 = `# Title\n<!-- AF-EVAL:BEGIN -->\n<!-- AF-EVAL:END -->`;
    expect(() => replaceGeneratedSection(malformed1, "Report")).toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "input-invalid",
        message: expect.stringContaining("malformed or unrecognized AF-EVAL"),
      }),
    );

    const malformed2 = `# Title\n<!-- AF-EVAL:UNKNOWN -->`;
    expect(() => replaceGeneratedSection(malformed2, "Report")).toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "input-invalid",
      }),
    );
  });

  it("preserves prefix and suffix byte-for-byte around valid markers", () => {
    const prefix = "# Title with UTF-8 ⚡\n\n\t  Special indent & leading bytes:\n\n";
    const oldSection = `${EVAL_BEGIN_MARKER}\nOld Section\n${EVAL_END_MARKER}`;
    const suffix = "\n\n## Trailing Code\n    def do_not_touch():\n        return True\n\n/* EOF comment */";

    const original = `${prefix}${oldSection}${suffix}`;
    const report = "## New Report\nContent";
    const result = replaceGeneratedSection(original, report);

    // Byte-for-byte prefix check
    expect(result.slice(0, prefix.length)).toBe(prefix);
    // Byte-for-byte suffix check
    expect(result.slice(result.length - suffix.length)).toBe(suffix);
    // Bounded section replaced
    expect(result).toContain(`${EVAL_BEGIN_MARKER}\n${report}\n${EVAL_END_MARKER}`);
  });

  it("preserves authored content byte-for-byte with zero markers without trimming leading whitespace", () => {
    const heading = "# Title\n";
    const authoredRemainder = "\n    def code_block():\n        return 123\n";
    const original = `${heading}${authoredRemainder}`;
    const report = "New Report";
    const result = replaceGeneratedSection(original, report);

    // Heading preserved
    expect(result.startsWith("# Title\n\n" + EVAL_BEGIN_MARKER)).toBe(true);
    // Authored remainder preserved verbatim, including code indentation
    expect(result).toContain(authoredRemainder);
    // Indentation not trimmed
    expect(result).toContain("    def code_block():");

    // Idempotency: second call produces identical string
    const second = replaceGeneratedSection(result, report);
    expect(second).toBe(result);
  });

  it("handles whitespace-tolerant markers", () => {
    const original = `# Title\n<!--   AF-EVAL:BEGIN   generated   -->\nOld\n<!--   AF-EVAL:END   generated   -->\nSuffix\n`;
    const result = replaceGeneratedSection(original, "New Report");
    expect(result).toContain(EVAL_BEGIN_MARKER);
    expect(result).toContain(EVAL_END_MARKER);
    expect(result).toContain("Suffix\n");
    expect(result).not.toContain("Old");
  });
});

describe("exportRun", () => {
  it("successfully publishes to EVALS.md and is idempotent on repeat calls", async () => {
    const runResult = await sealRun();
    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);

    const initialAuthored = `# arbitrum-docs — evaluation results

Authored note at the top.

<!-- AF-EVAL:BEGIN generated -->
Placeholder
<!-- AF-EVAL:END generated -->

## Authored coverage notes
Coverage note survives verbatim.
`;
    const evalsPath = join(tempSkillDir, "EVALS.md");
    await writeFile(evalsPath, initialAuthored, "utf8");

    // First publish
    const pubResult1 = await exportRun({
      receiptPath: runResult.receiptPath,
      to: tempSkillDir, repoUrl: REPO_URL,
    });
    expect(pubResult1.runId).toBe(runResult.runId);

    const contentAfterFirst = await readFile(evalsPath, "utf8");
    expect(contentAfterFirst).toContain("Authored note at the top.");
    expect(contentAfterFirst).toContain("## Authored coverage notes\nCoverage note survives verbatim.");
    expect(contentAfterFirst).toContain(EVAL_BEGIN_MARKER);
    expect(contentAfterFirst).toContain(EVAL_END_MARKER);
    expect(contentAfterFirst).toContain("— Evaluation cases\n\n## Case index");
    expect(contentAfterFirst).not.toContain("Status:");
    expect(contentAfterFirst).not.toContain("Placeholder");

    // Second publish (idempotency test)
    const pubResult2 = await exportRun({
      receiptPath: runResult.receiptPath,
      to: tempSkillDir, repoUrl: REPO_URL,
    });
    const contentAfterSecond = await readFile(evalsPath, "utf8");

    expect(contentAfterSecond).toBe(contentAfterFirst);
    // Must not append duplicate sections
    expect(contentAfterSecond.split(EVAL_BEGIN_MARKER).length - 1).toBe(1);
    expect(contentAfterSecond.split(EVAL_END_MARKER).length - 1).toBe(1);
  });

  it("inserts generated section when markers are absent while preserving authored notes", async () => {
    const runResult = await sealRun();
    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);

    const initialAuthored = `# arbitrum-docs — evaluation results

Authored introductory text.

## Historical notes
Some historical notes.
`;
    const evalsPath = join(tempSkillDir, "EVALS.md");
    await writeFile(evalsPath, initialAuthored, "utf8");

    await exportRun({
      receiptPath: runResult.receiptPath,
      to: tempSkillDir, repoUrl: REPO_URL,
    });

    const content = await readFile(evalsPath, "utf8");
    expect(content).toContain(EVAL_BEGIN_MARKER);
    expect(content).toContain(EVAL_END_MARKER);
    expect(content).toContain("Authored introductory text.");
    expect(content).toContain("## Historical notes\nSome historical notes.");

    // Republishing replaces within markers idempotently
    await exportRun({
      receiptPath: runResult.receiptPath,
      to: tempSkillDir, repoUrl: REPO_URL,
    });
    const content2 = await readFile(evalsPath, "utf8");
    expect(content2).toBe(content);
  });

  it("refuses to publish when evidence verification fails and does not mutate destination file", async () => {
    const runResult = await sealRun();
    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);

    const initialContent = "# Untouched\nMust not change.\n";
    const evalsPath = join(tempSkillDir, "EVALS.md");
    await writeFile(evalsPath, initialContent, "utf8");

    // Tamper with one sealed evidence file
    const pairId = `${runResult.runId}-r001`;
    const validationFile = join(runResult.runDir, "pairs", pairId, "treatment", "validation.json");
    const raw = await readFile(validationFile, "utf8");
    await chmod(validationFile, 0o644);
    await writeFile(validationFile, raw + " ", "utf8");

    await expect(
      exportRun({
        receiptPath: runResult.receiptPath,
        to: tempSkillDir, repoUrl: REPO_URL,
      }),
    ).rejects.toThrow(/Export refused: evidence verification failed/);

    // Destination file must not be modified
    const currentContent = await readFile(evalsPath, "utf8");
    expect(currentContent).toBe(initialContent);
  });

  it("refuses an explicit skill directory that is missing or a symlink", async () => {
    const runResult = await sealRun();
    const base = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(base);
    await expect(exportRun({ receiptPath: runResult.receiptPath, to: join(base, "absent"), repoUrl: REPO_URL }))
      .rejects.toThrow(/destination directory does not exist/);
    const real = join(base, "real");
    await mkdir(real);
    const link = join(base, "link");
    await symlink(real, link);
    await expect(exportRun({ receiptPath: runResult.receiptPath, to: link, repoUrl: REPO_URL }))
      .rejects.toThrow(/real directory, not a symlink/);
  });

  it("refuses to publish a legacy run that has no frozen rubric v0.2", async () => {
    const runResult = await sealRun();
    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);

    // Remove inputs/rubric.json to simulate a legacy run
    await rm(join(runResult.runDir, "inputs", "rubric.json"), { force: true });

    await expect(
      exportRun({
        receiptPath: runResult.receiptPath,
        to: tempSkillDir, repoUrl: REPO_URL,
      }),
    ).rejects.toThrow(/Export refused/);
  });

  it("publishes a verified task-limit run as a summary with its graded scores and no execution status or badge", async () => {
    // Run where treatment stops on task-limit
    const runResult = await sealRun(() => ({
      outcome: "task-limit",
      assistantText: "task limit reached",
    }));

    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);

    const pubResult = await exportRun({
      receiptPath: runResult.receiptPath,
      to: tempSkillDir, repoUrl: REPO_URL,
    });

    const evalsPath = join(tempSkillDir, "EVALS.md");
    const content = await readFile(evalsPath, "utf8");

    // No execution status or badge in the summary; the scores are the real graded ones.
    expect(content).not.toContain("Status:");
    expect(content).not.toMatch(/AF-Evaluation|img\.shields/);
    expect(content).toContain("| Score | Google Fake Model 0 |");
    // Must NOT claim certification
    expect(content).not.toContain("certified");
    expect(content).not.toContain("guaranteed");
    expect(content).not.toContain("approved");

    // Receipt path and operational footer must remain outside EVALS.md
    expect(content).not.toContain(runResult.receiptPath);
  });

  it("keeps execution status out of EVALS.md for a baseline task-limit and treatment completed run, and still publishes its scores", async () => {
    const runResult = await sealRun((request) => ({
      outcome: request.conditionId === "baseline" ? "task-limit" : "completed",
      assistantText: request.conditionId === "baseline" ? "baseline task limit" : "treatment completed",
    }));

    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);

    await exportRun({
      receiptPath: runResult.receiptPath,
      to: tempSkillDir, repoUrl: REPO_URL,
    });

    const evalsPath = join(tempSkillDir, "EVALS.md");
    const content = await readFile(evalsPath, "utf8");

    expect(content).not.toMatch(/Status:|task limit|Task limit|completed/);
    expect(content).toContain("| Score | Google Fake Model 0 |");
    expect(content).toContain("### Outcome Checks");
  });

  it("refuses to publish a run with an ungraded arm instead of publishing n/a", async () => {
    const runResult = await sealRun((request) =>
      request.conditionId === "baseline"
        ? { outcome: "infrastructure-failure", assistantText: "guest died" }
        : { outcome: "completed", assistantText: "done" },
    );
    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);
    await expect(exportRun({ receiptPath: runResult.receiptPath, to: tempSkillDir, repoUrl: REPO_URL }))
      .rejects.toThrow(/Export refused: .* has ungraded arm\(s\): baseline/);
    await expect(stat(join(tempSkillDir, "EVALS.md"))).rejects.toThrow();
  });

  it("publishes the mean of every pair when a multi-pair run has no --pair, with an unchanged table shape", async () => {
    const runResult = await sealRun(undefined, 3);
    const report = await buildRunReport(runResult.receiptPath);
    expect(report.pairs).toHaveLength(3);
    const labels = report.pairs.map((pair) => pair.pairId.slice(pair.pairId.lastIndexOf("-") + 1));

    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);

    const result = await exportRun({ receiptPath: runResult.receiptPath, to: tempSkillDir, repoUrl: REPO_URL });
    expect(result.mode).toBe("mean");
    expect(result.pairIds).toEqual(report.pairs.map((pair) => pair.pairId));

    const content = await readFile(join(tempSkillDir, "EVALS.md"), "utf8");
    // The note counts every pair; the hidden provenance names them all.
    expect(content).toContain("Metrics are means across all three pairs.");
    expect(content).toContain(`selection=mean pairs=${report.pairs.map((pair) => pair.pairId).join(",")}`);
    expect(labels).toHaveLength(3);
    // Same table headers as a single-pair export.
    expect(content).toContain("| Metric | LLM model | Baseline | Treatment | Change |");
    expect(content).toContain("| Eval case | Check | LLM model | Baseline | Treatment |");
    expect(content).not.toContain("| Pillar |");
  });

  it("--pair on a multi-pair run publishes only that pair, unaffected by an ungraded pair elsewhere", async () => {
    let call = 0;
    const script: FakeHarnessScript = (request) => {
      call += 1;
      // Calls run in pair order, baseline then treatment: pair 2's baseline (call 3) fails.
      const infra = call === 3;
      return {
        outcome: infra ? "infrastructure-failure" : "completed",
        assistantText: infra ? "guest died" : `call-${call} (${request.conditionId})`,
      };
    };
    const runResult = await sealRun(script, 3);
    const report = await buildRunReport(runResult.receiptPath);
    const pair1Id = report.pairs[0]!.pairId;

    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);

    const result = await exportRun({ receiptPath: runResult.receiptPath, pairId: pair1Id, to: tempSkillDir, repoUrl: REPO_URL });
    expect(result.mode).toBe("single");
    expect(result.pairIds).toEqual([pair1Id]);

    const content = await readFile(join(tempSkillDir, "EVALS.md"), "utf8");
    expect(content).toContain("Metrics are from the explicitly selected pair r001 of 3.");
    expect(content).toContain(`selection=single pairs=${pair1Id} `);
    expect(content).not.toContain("means across");
  });

  it("refuses to publish the mean when any pair is ungraded, and names that pair", async () => {
    let call = 0;
    const script: FakeHarnessScript = (request) => {
      call += 1;
      const infra = call === 3; // pair 2's baseline
      return {
        outcome: infra ? "infrastructure-failure" : "completed",
        assistantText: infra ? "guest died" : `call-${call} (${request.conditionId})`,
      };
    };
    const runResult = await sealRun(script, 3);
    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);

    await expect(exportRun({ receiptPath: runResult.receiptPath, to: tempSkillDir, repoUrl: REPO_URL }))
      .rejects.toThrow(/Export refused: pair r002 of run .* has ungraded arm\(s\): baseline/);
    await expect(stat(join(tempSkillDir, "EVALS.md"))).rejects.toThrow();
  });

  it("has no badge or operational header and does not claim certification", async () => {
    const runResult = await sealRun();
    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);

    await exportRun({
      receiptPath: runResult.receiptPath,
      to: tempSkillDir, repoUrl: REPO_URL,
    });

    const content = await readFile(join(tempSkillDir, "EVALS.md"), "utf8");
    expect(content).not.toMatch(/AF-Evaluation|img\.shields|certif|guarantee|approved/i);
    expect(content).not.toMatch(/^(Agent|Skill|Run|Status):/m);
  });

  it("ordinary eval:report does not write or modify EVALS.md", async () => {
    const runResult = await sealRun();
    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);

    const evalsPath = join(tempSkillDir, "EVALS.md");

    // Report generation
    const report = await buildRunReport(runResult.receiptPath);
    formatRunReport(report, { format: "table" });
    formatRunReport(report, { format: "markdown" });
    formatRunReport(report, { format: "json" });

    // EVALS.md must NOT have been created
    await expect(readFile(evalsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writing EVALS.md does not disturb createSkillSnapshot treeSha256 parity", async () => {
    const tempSkillRoot = await mkdtemp(join(tmpdir(), "eval-skill-parity-"));
    tempRoots.push(tempSkillRoot);

    const skillDir = join(tempSkillRoot, "skills", "test-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Test Skill\nInstructions.\n", "utf8");

    const snap1 = await createSkillSnapshot({
      repoRoot: tempSkillRoot,
      skillPath: "skills/test-skill",
      snapshotDir: join(tempSkillRoot, "snap1"),
    });

    // Write EVALS.md at the skill root
    await writeFile(join(skillDir, "EVALS.md"), "# Results\nSome results.\n", "utf8");

    const snap2 = await createSkillSnapshot({
      repoRoot: tempSkillRoot,
      skillPath: "skills/test-skill",
      snapshotDir: join(tempSkillRoot, "snap2"),
    });

    // Parity hash and file list must be identical
    expect(snap2.treeSha256).toBe(snap1.treeSha256);
    expect(snap2.totalBytes).toBe(snap1.totalBytes);
    expect(snap2.files).toEqual(snap1.files);
  });

  it("refuses a destination directory that does not exist and does NOT create it", async () => {
    const runResult = await sealRun();
    const base = await mkdtemp(join(tmpdir(), "eval-no-mkdir-"));
    tempRoots.push(base);
    const missing = join(base, "skills", "arbitrum-docs");
    await expect(exportRun({ receiptPath: runResult.receiptPath, to: missing, repoUrl: REPO_URL })).rejects.toThrowError(
      expect.objectContaining({ name: "EvalError", code: "evidence-invalid", message: expect.stringContaining("does not exist") }),
    );
    expect(existsSync(join(base, "skills"))).toBe(false);
  });

  it("refuses to export when destination EVALS.md is a symlink and leaves target untouched", async () => {
    const runResult = await sealRun();
    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-targetdir-symlink-"));
    tempRoots.push(tempSkillDir);

    const outsideTarget = join(tempSkillDir, "outside-target.md");
    const originalContent = "# Untouched Seam Target\n";
    await writeFile(outsideTarget, originalContent, "utf8");

    await symlink(outsideTarget, join(tempSkillDir, "EVALS.md"));

    await expect(
      exportRun({
        receiptPath: runResult.receiptPath,
        to: tempSkillDir, repoUrl: REPO_URL,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "evidence-invalid",
        message: expect.stringContaining("destination file is a symlink"),
      }),
    );

    expect(await readFile(outsideTarget, "utf8")).toBe(originalContent);
  });

  it("refuses to export when destination EVALS.md has malformed/duplicate/reversed markers and leaves file byte-for-byte unchanged", async () => {
    const runResult = await sealRun();
    const skillDir = await mkdtemp(join(tmpdir(), "eval-malformed-marker-"));
    tempRoots.push(skillDir);
    const evalsPath = join(skillDir, "EVALS.md");

    // 1. Duplicate begins
    const duplicateBegins = `# Title\n\n${EVAL_BEGIN_MARKER}\nFirst\n${EVAL_BEGIN_MARKER}\nSecond\n${EVAL_END_MARKER}\nAuthored\n`;
    await writeFile(evalsPath, duplicateBegins, "utf8");

    await expect(
      exportRun({
        receiptPath: runResult.receiptPath,
        to: skillDir,
        repoUrl: REPO_URL,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "input-invalid",
      }),
    );
    expect(await readFile(evalsPath, "utf8")).toBe(duplicateBegins);

    // 2. Reversed markers
    const reversedMarkers = `# Title\n\n${EVAL_END_MARKER}\nContent\n${EVAL_BEGIN_MARKER}\nAuthored\n`;
    await writeFile(evalsPath, reversedMarkers, "utf8");

    await expect(
      exportRun({
        receiptPath: runResult.receiptPath,
        to: skillDir,
        repoUrl: REPO_URL,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "input-invalid",
        message: expect.stringContaining("reversed markers"),
      }),
    );
    expect(await readFile(evalsPath, "utf8")).toBe(reversedMarkers);

    // 3. Unpaired BEGIN marker
    const unpairedBegin = `# Title\n\n${EVAL_BEGIN_MARKER}\nAuthored without end\n`;
    await writeFile(evalsPath, unpairedBegin, "utf8");

    await expect(
      exportRun({
        receiptPath: runResult.receiptPath,
        to: skillDir,
        repoUrl: REPO_URL,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "input-invalid",
        message: expect.stringContaining("unpaired BEGIN marker"),
      }),
    );
    expect(await readFile(evalsPath, "utf8")).toBe(unpairedBegin);
  });

  describe("eval:export CLI subprocess execution", () => {
    const exportScript = resolve(repoRoot, "scripts/export.ts");

    it("exports via CLI subprocess with an injected --repo-url", async () => {
      const runResult = await sealRun();
      const skillDir = await mkdtemp(join(tmpdir(), "eval-cli-skill-"));
      tempRoots.push(skillDir);
      await writeFile(join(skillDir, "EVALS.md"), "# arbitrum-docs — evaluation results\n\nAuthored text\n", "utf8");

      const stdout = execFileSync(
        process.execPath,
        ["--experimental-strip-types", exportScript, "--receipt", runResult.receiptPath, "--to", skillDir, "--repo-url", REPO_URL],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(stdout).toContain(`Exported evaluation results for run ${runResult.runId}`);

      const content = await readFile(join(skillDir, "EVALS.md"), "utf8");
      expect(content).toContain(EVAL_BEGIN_MARKER);
      expect(content).toContain(EVAL_END_MARKER);
      expect(content).toContain("Authored text");
      expect(content).toContain("### Outcome Checks");
      expect(content).toContain("Correct network identities");
      expect(content).toContain(
        `[View full report](${REPO_URL}/blob/HEAD/eval-cases/${(await buildRunReport(runResult.receiptPath)).caseId}/runs/${runResult.runId}/EVALS-FULL-REPORT.md)`,
      );
    });

    it("refuses with non-zero exit when verification fails", async () => {
      const runResult = await sealRun();
      const skillDir = await mkdtemp(join(tmpdir(), "eval-cli-skill-"));
      tempRoots.push(skillDir);

      const pairId = `${runResult.runId}-r001`;
      const validationFile = join(runResult.runDir, "pairs", pairId, "treatment", "validation.json");
      const raw = await readFile(validationFile, "utf8");
      await chmod(validationFile, 0o644);
      await writeFile(validationFile, raw + " ", "utf8");

      expect(() =>
        execFileSync(
          process.execPath,
          ["--experimental-strip-types", exportScript, "--receipt", runResult.receiptPath, "--to", skillDir, "--repo-url", REPO_URL],
          { cwd: repoRoot, encoding: "utf8", stdio: "pipe" },
        ),
      ).toThrow();
    });

    it("refuses when --receipt or --to is missing", () => {
      for (const args of [[], ["--receipt", "x"], ["--to", "y"]]) {
        expect(() =>
          execFileSync(process.execPath, ["--experimental-strip-types", exportScript, ...args], {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: "pipe",
          }),
        ).toThrow();
      }
    });

    it("eval:publish no longer exists", async () => {
      const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
      expect(pkg.scripts["eval:publish"]).toBeUndefined();
      expect(pkg.scripts["eval:export"]).toBeDefined();
      expect(existsSync(join(repoRoot, "scripts", "publish.ts"))).toBe(false);
    });
  });

  it("creates a missing destination file with markers, writes to a named .md file, and records the run hash and link", async () => {
    const runResult = await sealRun();
    const report = await buildRunReport(runResult.receiptPath);
    const dir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(dir);

    await exportRun({ receiptPath: runResult.receiptPath, to: dir, repoUrl: REPO_URL });
    const created = await readFile(join(dir, "EVALS.md"), "utf8");
    expect(created.startsWith(`${EVAL_BEGIN_MARKER}\n> **Warning:** TEST-DOUBLE EVIDENCE`)).toBe(true);
    expect(created).toContain("— Evaluation cases\n\n## Case index");
    expect(created.endsWith(`${EVAL_END_MARKER}\n`)).toBe(true);
    expect(created).not.toContain("### Accuracy\n");
    expect(created).not.toContain("### Cost and latency");
    // The exact verified tree hash survives in the hidden, entry-bound comment inside the block.
    const receipt = JSON.parse(await readFile(runResult.receiptPath, "utf8")) as { manifest: { treeSha256: string } };
    expect(created).toContain(
      `<!-- EVALS-ENTRY case=${report.caseId} run=${report.runId} selection=single pairs=${report.pairs[0]!.pairId} treeSha256=${receipt.manifest.treeSha256} -->\n${EVAL_END_MARKER}`,
    );
    expect(created.indexOf("EVALS-ENTRY")).toBeGreaterThan(created.indexOf(EVAL_BEGIN_MARKER));
    const url = buildRunReportUrl({
      repoUrl: REPO_URL,
      runRelativeDir: `eval-cases/${report.caseId}/runs/${report.runId}`,
      target: "full-report",
    });
    expect(created).toContain(`| ${report.caseId} | [View full report](${url}) |\n`);
    expect(created.replace(/<!--[\s\S]*?-->/g, "").trimEnd().endsWith(`[View full report](${url}) |`)).toBe(true);

    const named = join(dir, "OUT.md");
    await exportRun({ receiptPath: runResult.receiptPath, to: named, repoUrl: REPO_URL });
    expect(await readFile(named, "utf8")).toBe(created);
    // Neither file leaks host paths.
    expect(created).not.toContain(runResult.receiptPath);
    expect(created).not.toContain(tmpdir());
  });

  it("exports a body equal to the run-folder EVALS.md and refuses a stale or missing run-folder file", async () => {
    const runResult = await sealRun();
    const dir = await mkdtemp(join(tmpdir(), "eval-export-fresh-"));
    tempRoots.push(dir);
    await exportRun({ receiptPath: runResult.receiptPath, to: dir, repoUrl: REPO_URL });
    const folderSummary = await readFile(join(runResult.runDir, "EVALS.md"), "utf8");
    const exported = await readFile(join(dir, "EVALS.md"), "utf8");
    expect(exported).toBe(`${EVAL_BEGIN_MARKER}\n${folderSummary.trim()}\n${EVAL_END_MARKER}\n`);

    await writeFile(join(runResult.runDir, "EVALS.md"), `${folderSummary}tampered\n`);
    await expect(exportRun({ receiptPath: runResult.receiptPath, to: dir, repoUrl: REPO_URL })).rejects.toThrow(/missing or stale.*--regenerate/s);
    // A named pair does not depend on the run-folder EVALS.md, only on the full report.
    await exportRun({ receiptPath: runResult.receiptPath, to: dir, repoUrl: REPO_URL, pairId: "r001" });
    await rm(join(runResult.runDir, "EVALS-FULL-REPORT.md"));
    await expect(
      exportRun({ receiptPath: runResult.receiptPath, to: dir, repoUrl: REPO_URL, pairId: "r001" }),
    ).rejects.toThrow(/EVALS-FULL-REPORT\.md.*missing or stale/s);
  });

  it("eval:inspect --pair accepts the short rNNN label and lists available pairs on a miss (B1)", async () => {
    const runResult = await sealRun(undefined, 2);
    const report = await buildRunReport(runResult.receiptPath);
    const short = await inspectCondition({ receiptPath: runResult.receiptPath, conditionId: "treatment", view: "condition", pairId: "r002" });
    expect(short.pairId).toBe(report.pairs[1]!.pairId);
    const full = await inspectCondition({ receiptPath: runResult.receiptPath, conditionId: "treatment", view: "condition", pairId: report.pairs[1]!.pairId });
    expect(full.pairId).toBe(short.pairId);
    await expect(
      inspectCondition({ receiptPath: runResult.receiptPath, conditionId: "treatment", view: "condition", pairId: "r009" }),
    ).rejects.toThrow(/receipt has no pair r009\. Available: .*-r001, .*-r002/);
  });
});
