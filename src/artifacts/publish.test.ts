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
  publishRun,
  replaceGeneratedSection,
  resolveDefaultRepoRoot,
  resolvePublicationTarget,
  validateAndResolveDestination,
} from "./publish.ts";
import { createSkillSnapshot } from "../runner/skill-snapshot.ts";
import { EvalError } from "../core/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const evalsRoot = join(repoRoot, "evals");

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

async function sealRun(script?: FakeHarnessScript, repetitions: number = 1): Promise<RunResult> {
  const root = await mkdtemp(join(tmpdir(), "eval-publish-test-"));
  tempRoots.push(root);
  const workDir = await mkdtemp(join(tmpdir(), "eval-publish-work-"));
  workDirs.push(workDir);
  const nonce = randomBytes(4).toString("hex");
  return runPairedEvaluation({
    evalsRoot,
    repoRoot,
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

describe("default repo root and pure target resolver (Blocker 1)", () => {
  it("resolveDefaultRepoRoot resolves the actual repository root (three parent traversals)", () => {
    const root = resolveDefaultRepoRoot();
    expect(root).toBe(repoRoot);
    expect(existsSync(join(root, "package.json"))).toBe(true);
    expect(existsSync(join(root, "evals"))).toBe(true);
    expect(existsSync(join(root, "skills"))).toBe(true);
  });

  it("pure resolver resolvePublicationTarget targets <repo>/skills/<recorded-skill>/EVALS.md without --repo-root and without mutating", () => {
    const target = resolvePublicationTarget({ skillSourcePath: "skills/arbitrum-docs" });
    expect(target.repoRoot).toBe(repoRoot);
    expect(target.targetDir).toBe(join(repoRoot, "skills", "arbitrum-docs"));
    expect(target.targetPath).toBe(join(repoRoot, "skills", "arbitrum-docs", "EVALS.md"));
    expect(target.relativeTargetPath).toBe("skills/arbitrum-docs/EVALS.md");
  });
});

describe("validateAndResolveDestination path safety (Blocker 2)", () => {
  it("rejects absolute skillSourcePath", async () => {
    await expect(
      validateAndResolveDestination("/etc/passwd", { repoRoot }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "evidence-invalid",
        message: expect.stringContaining("must be repository-relative"),
      }),
    );
  });

  it("rejects traversal skillSourcePath (.. segments)", async () => {
    await expect(
      validateAndResolveDestination("../skills/arbitrum-docs", { repoRoot }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "evidence-invalid",
        message: expect.stringContaining("traversal segments"),
      }),
    );

    await expect(
      validateAndResolveDestination("skills/arbitrum-docs/../../etc", { repoRoot }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "evidence-invalid",
        message: expect.stringContaining("traversal segments"),
      }),
    );
  });

  it("rejects empty or dot skillSourcePath", async () => {
    await expect(
      validateAndResolveDestination(".", { repoRoot }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "evidence-invalid",
      }),
    );

    await expect(
      validateAndResolveDestination("", { repoRoot }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "evidence-invalid",
      }),
    );
  });

  it("rejects unnormalized skillSourcePath", async () => {
    await expect(
      validateAndResolveDestination("skills//arbitrum-docs", { repoRoot }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "evidence-invalid",
      }),
    );

    await expect(
      validateAndResolveDestination("skills/./arbitrum-docs", { repoRoot }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "evidence-invalid",
      }),
    );
  });

  it("rejects non-existent skill directory and does not create it (no mkdir)", async () => {
    const tempRepo = await mkdtemp(join(tmpdir(), "eval-dest-test-"));
    tempRoots.push(tempRepo);

    await expect(
      validateAndResolveDestination("skills/nonexistent-skill", { repoRoot: tempRepo }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "evidence-invalid",
        message: expect.stringContaining("does not exist"),
      }),
    );

    expect(existsSync(join(tempRepo, "skills", "nonexistent-skill"))).toBe(false);
  });

  it("rejects symlinked skill directory", async () => {
    const tempRepo = await mkdtemp(join(tmpdir(), "eval-dest-test-"));
    tempRoots.push(tempRepo);

    const realSkillDir = await mkdtemp(join(tmpdir(), "eval-real-skill-"));
    tempRoots.push(realSkillDir);

    const skillsDir = join(tempRepo, "skills");
    await mkdir(skillsDir, { recursive: true });
    await symlink(realSkillDir, join(skillsDir, "symlinked-skill"));

    await expect(
      validateAndResolveDestination("skills/symlinked-skill", { repoRoot: tempRepo }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "evidence-invalid",
        message: expect.stringContaining("symlink"),
      }),
    );
  });

  it("rejects symlink in parent path component of skill directory", async () => {
    const tempRepo = await mkdtemp(join(tmpdir(), "eval-dest-test-"));
    tempRoots.push(tempRepo);

    const realTargetDir = await mkdtemp(join(tmpdir(), "eval-real-target-"));
    tempRoots.push(realTargetDir);
    await mkdir(join(realTargetDir, "nested-skill"), { recursive: true });

    await symlink(realTargetDir, join(tempRepo, "symlink-parent"));

    await expect(
      validateAndResolveDestination("symlink-parent/nested-skill", { repoRoot: tempRepo }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "evidence-invalid",
        message: expect.stringContaining("symlink"),
      }),
    );
  });

  it("rejects symlinked destination EVALS.md", async () => {
    const tempRepo = await mkdtemp(join(tmpdir(), "eval-dest-test-"));
    tempRoots.push(tempRepo);

    const skillDir = join(tempRepo, "skills", "arbitrum-docs");
    await mkdir(skillDir, { recursive: true });

    const outsideFile = join(tempRepo, "outside.md");
    await writeFile(outsideFile, "# Outside", "utf8");
    await symlink(outsideFile, join(skillDir, "EVALS.md"));

    await expect(
      validateAndResolveDestination("skills/arbitrum-docs", { repoRoot: tempRepo }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "evidence-invalid",
        message: expect.stringContaining("destination EVALS.md is a symlink"),
      }),
    );
  });

  it("rejects non-regular file destination EVALS.md (directory)", async () => {
    const tempRepo = await mkdtemp(join(tmpdir(), "eval-dest-test-"));
    tempRoots.push(tempRepo);

    const skillDir = join(tempRepo, "skills", "arbitrum-docs");
    await mkdir(join(skillDir, "EVALS.md"), { recursive: true });

    await expect(
      validateAndResolveDestination("skills/arbitrum-docs", { repoRoot: tempRepo }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "evidence-invalid",
        message: expect.stringContaining("destination EVALS.md is not a regular file"),
      }),
    );
  });

  it("accepts valid real skill directory inside repo root", async () => {
    const tempRepo = await mkdtemp(join(tmpdir(), "eval-dest-test-"));
    tempRoots.push(tempRepo);

    const skillDir = join(tempRepo, "skills", "arbitrum-docs");
    await mkdir(skillDir, { recursive: true });

    const resolved = await validateAndResolveDestination("skills/arbitrum-docs", { repoRoot: tempRepo });
    expect(resolved.repoRoot).toBe(tempRepo);
    expect(resolved.targetDir).toBe(skillDir);
    expect(resolved.targetPath).toBe(join(skillDir, "EVALS.md"));
    expect(resolved.relativeTargetPath).toBe(join("skills", "arbitrum-docs", "EVALS.md"));
  });
});

describe("publishRun", () => {
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
    const pubResult1 = await publishRun({
      receiptPath: runResult.receiptPath,
      targetSkillDir: tempSkillDir,
    });
    expect(pubResult1.runId).toBe(runResult.runId);

    const contentAfterFirst = await readFile(evalsPath, "utf8");
    expect(contentAfterFirst).toContain("Authored note at the top.");
    expect(contentAfterFirst).toContain("## Authored coverage notes\nCoverage note survives verbatim.");
    expect(contentAfterFirst).toContain(EVAL_BEGIN_MARKER);
    expect(contentAfterFirst).toContain(EVAL_END_MARKER);
    expect(contentAfterFirst).toContain("# EVALS.MD:");
    expect(contentAfterFirst).toContain("Status: Completed; graded\n");
    expect(contentAfterFirst).not.toContain("Placeholder");

    // Second publish (idempotency test)
    const pubResult2 = await publishRun({
      receiptPath: runResult.receiptPath,
      targetSkillDir: tempSkillDir,
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

    await publishRun({
      receiptPath: runResult.receiptPath,
      targetSkillDir: tempSkillDir,
    });

    const content = await readFile(evalsPath, "utf8");
    expect(content).toContain(EVAL_BEGIN_MARKER);
    expect(content).toContain(EVAL_END_MARKER);
    expect(content).toContain("Authored introductory text.");
    expect(content).toContain("## Historical notes\nSome historical notes.");

    // Republishing replaces within markers idempotently
    await publishRun({
      receiptPath: runResult.receiptPath,
      targetSkillDir: tempSkillDir,
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
      publishRun({
        receiptPath: runResult.receiptPath,
        targetSkillDir: tempSkillDir,
      }),
    ).rejects.toThrow(/Publication refused: evidence verification failed/);

    // Destination file must not be modified
    const currentContent = await readFile(evalsPath, "utf8");
    expect(currentContent).toBe(initialContent);
  });

  it("refuses to publish a legacy run that has no frozen rubric v0.2", async () => {
    const runResult = await sealRun();
    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);

    // Remove inputs/rubric.json to simulate a legacy run
    await rm(join(runResult.runDir, "inputs", "rubric.json"), { force: true });

    await expect(
      publishRun({
        receiptPath: runResult.receiptPath,
        targetSkillDir: tempSkillDir,
      }),
    ).rejects.toThrow(/Publication refused/);
  });

  it("refuses when destination skill cannot be derived from skill-snapshot", async () => {
    const runResult = await sealRun();
    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);

    // Overwrite skill-snapshot.json to remove sourcePath
    const snapshotPath = join(runResult.runDir, "inputs", "skill-snapshot.json");
    await chmod(snapshotPath, 0o644);
    await writeFile(snapshotPath, JSON.stringify({ schemaVersion: 2, files: [] }), "utf8");

    await expect(
      publishRun({
        receiptPath: runResult.receiptPath,
        targetSkillDir: tempSkillDir,
      }),
    ).rejects.toThrow(/Publication refused/);
  });

  it("publishes verified task-limit run with actual status and n/a measurements (no mock scores)", async () => {
    // Run where treatment stops on task-limit
    const runResult = await sealRun(() => ({
      outcome: "task-limit",
      assistantText: "task limit reached",
    }));

    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);

    const pubResult = await publishRun({
      receiptPath: runResult.receiptPath,
      targetSkillDir: tempSkillDir,
    });

    const evalsPath = join(tempSkillDir, "EVALS.md");
    const content = await readFile(evalsPath, "utf8");

    // Must show task-limit status
    expect(content).toContain("Status: Task limit reached; graded\n");
    // Badge must reflect task-limit status
    expect(content).toMatch(/AF--Evaluation-task%20limit%20%C2%B7%20\d+%25-yellow/);
    // Badge must NOT claim certification
    expect(content).not.toContain("certified");
    expect(content).not.toContain("guaranteed");
    expect(content).not.toContain("approved");

    // Receipt path and operational footer must remain outside EVALS.md
    expect(content).not.toContain(runResult.receiptPath);
  });

  it("renders both-arm status in EVALS.md for mixed case baseline task-limit and treatment completed", async () => {
    const runResult = await sealRun((request) => ({
      outcome: request.conditionId === "baseline" ? "task-limit" : "completed",
      assistantText: request.conditionId === "baseline" ? "baseline task limit" : "treatment completed",
    }));

    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);

    await publishRun({
      receiptPath: runResult.receiptPath,
      targetSkillDir: tempSkillDir,
    });

    const evalsPath = join(tempSkillDir, "EVALS.md");
    const content = await readFile(evalsPath, "utf8");

    expect(content).toContain("Status: Without this skill: task limit reached, graded · With this skill: completed, graded\n");
  });

  it("refuses to publish a run with an ungraded arm instead of publishing n/a", async () => {
    const runResult = await sealRun((request) =>
      request.conditionId === "baseline"
        ? { outcome: "infrastructure-failure", assistantText: "guest died" }
        : { outcome: "completed", assistantText: "done" },
    );
    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);
    await expect(publishRun({ receiptPath: runResult.receiptPath, targetSkillDir: tempSkillDir }))
      .rejects.toThrow(/Publication refused: .* has ungraded arm\(s\): baseline/);
    await expect(stat(join(tempSkillDir, "EVALS.md"))).rejects.toThrow();
  });

  it("publishes the mean of every pair when a multi-pair run has no --pair, with an unchanged table shape", async () => {
    const runResult = await sealRun(undefined, 3);
    const report = await buildRunReport(runResult.receiptPath);
    expect(report.pairs).toHaveLength(3);
    const labels = report.pairs.map((pair) => pair.pairId.slice(pair.pairId.lastIndexOf("-") + 1));

    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);

    const result = await publishRun({ receiptPath: runResult.receiptPath, targetSkillDir: tempSkillDir });
    expect(result.mode).toBe("mean");
    expect(result.pairIds).toEqual(report.pairs.map((pair) => pair.pairId));

    const content = await readFile(join(tempSkillDir, "EVALS.md"), "utf8");
    // Header names every pair; nothing else about the table shape changes.
    expect(content).toContain(`Run: ${report.runId} · Pairs ${labels.join(", ")}`);
    expect(content).not.toContain("Pair r001  \n");
    expect(content).not.toContain("repetitions)");
    // Same table headers as a single-pair publication: no extra columns or notes.
    expect(content).toContain("| Pillar | Without this skill | With this skill | Change |");
    expect(content).toContain("| Check | Without this skill | With this skill |");
    expect(content).toContain("| Metric | Without this skill | With this skill |");
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

    const result = await publishRun({ receiptPath: runResult.receiptPath, pairId: pair1Id, targetSkillDir: tempSkillDir });
    expect(result.mode).toBe("single");
    expect(result.pairIds).toEqual([pair1Id]);

    const content = await readFile(join(tempSkillDir, "EVALS.md"), "utf8");
    expect(content).toContain(`Run: ${report.runId} · Pair r001`);
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

    await expect(publishRun({ receiptPath: runResult.receiptPath, targetSkillDir: tempSkillDir }))
      .rejects.toThrow(/Publication refused: pair r002 of run .* has ungraded arm\(s\): baseline/);
    await expect(stat(join(tempSkillDir, "EVALS.md"))).rejects.toThrow();
  });

  it("badge reflects status without claiming certification", async () => {
    const runResult = await sealRun();
    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-skill-dest-"));
    tempRoots.push(tempSkillDir);

    await publishRun({
      receiptPath: runResult.receiptPath,
      targetSkillDir: tempSkillDir,
    });

    const evalsPath = join(tempSkillDir, "EVALS.md");
    const content = await readFile(evalsPath, "utf8");

    // Check badge URL presence
    expect(content).toMatch(/!\[AF-Evaluation: completed · \d+%\]\(https:\/\/img\.shields\.io\/badge\/AF--Evaluation-/);

    // Non-certifying checks: badge should not claim certification or guaranteed improvement
    expect(content).not.toMatch(/badge\/AF--Evaluation.*certif/i);
    expect(content).not.toMatch(/badge\/AF--Evaluation.*guarantee/i);
    expect(content).not.toMatch(/badge\/AF--Evaluation.*approved/i);
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

  it("refuses to publish when derived skill directory does not exist and does NOT create it", async () => {
    const runResult = await sealRun();
    const tempRepoRoot = await mkdtemp(join(tmpdir(), "eval-no-mkdir-repo-"));
    tempRoots.push(tempRepoRoot);

    // tempRepoRoot does NOT have skills/arbitrum-docs
    await expect(
      publishRun({
        receiptPath: runResult.receiptPath,
        repoRoot: tempRepoRoot,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "evidence-invalid",
        message: expect.stringContaining("does not exist"),
      }),
    );

    // Ensure no outside directory was created
    expect(existsSync(join(tempRepoRoot, "skills"))).toBe(false);
  });

  it("refuses to publish when derived skill directory is a symlink and leaves target untouched", async () => {
    const runResult = await sealRun();
    const tempRepoRoot = await mkdtemp(join(tmpdir(), "eval-symlink-repo-"));
    tempRoots.push(tempRepoRoot);

    const outsideSkillDir = await mkdtemp(join(tmpdir(), "eval-outside-skill-"));
    tempRoots.push(outsideSkillDir);
    const outsideEvals = join(outsideSkillDir, "EVALS.md");
    const originalContent = "# Untouched Outside File\n";
    await writeFile(outsideEvals, originalContent, "utf8");

    const skillsDir = join(tempRepoRoot, "skills");
    await mkdir(skillsDir, { recursive: true });
    await symlink(outsideSkillDir, join(skillsDir, "arbitrum-docs"));

    await expect(
      publishRun({
        receiptPath: runResult.receiptPath,
        repoRoot: tempRepoRoot,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "evidence-invalid",
        message: expect.stringContaining("symlink"),
      }),
    );

    // Outside file must remain untouched
    expect(await readFile(outsideEvals, "utf8")).toBe(originalContent);
  });

  it("refuses to publish when destination EVALS.md is a symlink and leaves target untouched", async () => {
    const runResult = await sealRun();
    const tempRepoRoot = await mkdtemp(join(tmpdir(), "eval-symlink-file-repo-"));
    tempRoots.push(tempRepoRoot);

    const skillDir = join(tempRepoRoot, "skills", "arbitrum-docs");
    await mkdir(skillDir, { recursive: true });

    const outsideTarget = join(tempRepoRoot, "outside-target.md");
    const originalContent = "# Untouched Target\n";
    await writeFile(outsideTarget, originalContent, "utf8");

    await symlink(outsideTarget, join(skillDir, "EVALS.md"));

    await expect(
      publishRun({
        receiptPath: runResult.receiptPath,
        repoRoot: tempRepoRoot,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "evidence-invalid",
        message: expect.stringContaining("destination EVALS.md is a symlink"),
      }),
    );

    expect(await readFile(outsideTarget, "utf8")).toBe(originalContent);
  });

  it("refuses to publish when test-only targetSkillDir has a symlinked EVALS.md and leaves target untouched", async () => {
    const runResult = await sealRun();
    const tempSkillDir = await mkdtemp(join(tmpdir(), "eval-targetdir-symlink-"));
    tempRoots.push(tempSkillDir);

    const outsideTarget = join(tempSkillDir, "outside-target.md");
    const originalContent = "# Untouched Seam Target\n";
    await writeFile(outsideTarget, originalContent, "utf8");

    await symlink(outsideTarget, join(tempSkillDir, "EVALS.md"));

    await expect(
      publishRun({
        receiptPath: runResult.receiptPath,
        targetSkillDir: tempSkillDir,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "EvalError",
        code: "evidence-invalid",
        message: expect.stringContaining("destination EVALS.md is a symlink"),
      }),
    );

    expect(await readFile(outsideTarget, "utf8")).toBe(originalContent);
  });

  it("refuses to publish when destination EVALS.md has malformed/duplicate/reversed markers and leaves file byte-for-byte unchanged", async () => {
    const runResult = await sealRun();
    const tempRepoRoot = await mkdtemp(join(tmpdir(), "eval-malformed-marker-repo-"));
    tempRoots.push(tempRepoRoot);

    const skillDir = join(tempRepoRoot, "skills", "arbitrum-docs");
    await mkdir(skillDir, { recursive: true });
    const evalsPath = join(skillDir, "EVALS.md");

    // 1. Duplicate begins
    const duplicateBegins = `# Title\n\n${EVAL_BEGIN_MARKER}\nFirst\n${EVAL_BEGIN_MARKER}\nSecond\n${EVAL_END_MARKER}\nAuthored\n`;
    await writeFile(evalsPath, duplicateBegins, "utf8");

    await expect(
      publishRun({
        receiptPath: runResult.receiptPath,
        repoRoot: tempRepoRoot,
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
      publishRun({
        receiptPath: runResult.receiptPath,
        repoRoot: tempRepoRoot,
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
      publishRun({
        receiptPath: runResult.receiptPath,
        repoRoot: tempRepoRoot,
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

  describe("eval:publish CLI subprocess execution", () => {
    const publishScript = resolve(repoRoot, "evals/scripts/publish.ts");

    it("publishes via CLI subprocess and honors --checks", async () => {
      const runResult = await sealRun();
      const tempRepoRoot = await mkdtemp(join(tmpdir(), "eval-cli-repo-"));
      tempRoots.push(tempRepoRoot);

      const skillDir = join(tempRepoRoot, "skills", "arbitrum-docs");
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "EVALS.md"), "# arbitrum-docs — evaluation results\n\nAuthored text\n", "utf8");

      const stdout = execFileSync(
        process.execPath,
        ["--experimental-strip-types", publishScript, "--receipt", runResult.receiptPath, "--repo-root", tempRepoRoot, "--checks"],
        { cwd: repoRoot, encoding: "utf8" },
      );

      expect(stdout).toContain(`Published evaluation results for run ${runResult.runId}`);

      const content = await readFile(join(skillDir, "EVALS.md"), "utf8");
      expect(content).toContain(EVAL_BEGIN_MARKER);
      expect(content).toContain(EVAL_END_MARKER);
      expect(content).toContain("Authored text");
      // --checks was passed, so the outcome checks table must be present
      expect(content).toContain("### Outcome checks");
      expect(content).toContain("Correct network identities");
    });

    it("refuses with non-zero exit when verification fails", async () => {
      const runResult = await sealRun();
      const tempRepoRoot = await mkdtemp(join(tmpdir(), "eval-cli-repo-"));
      tempRoots.push(tempRepoRoot);

      // Tamper with receipt
      const pairId = `${runResult.runId}-r001`;
      const validationFile = join(runResult.runDir, "pairs", pairId, "treatment", "validation.json");
      const raw = await readFile(validationFile, "utf8");
      await chmod(validationFile, 0o644);
      await writeFile(validationFile, raw + " ", "utf8");

      expect(() =>
        execFileSync(
          process.execPath,
          ["--experimental-strip-types", publishScript, "--receipt", runResult.receiptPath, "--repo-root", tempRepoRoot],
          { cwd: repoRoot, encoding: "utf8", stdio: "pipe" },
        ),
      ).toThrow();
    });

    it("refuses when --receipt argument is missing", () => {
      expect(() =>
        execFileSync(
          process.execPath,
          ["--experimental-strip-types", publishScript],
          { cwd: repoRoot, encoding: "utf8", stdio: "pipe" },
        ),
      ).toThrow();
    });
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
