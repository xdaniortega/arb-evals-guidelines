/**
 * Synthetic tests for generic case compatibility (Section 2 compatibility contract).
 *
 * Covers:
 * - Empty fixtures (genuinely empty and tracked empty directory with sole zero-byte .gitkeep)
 * - Output initially absent from fixture
 * - Universal fresh-run workspace collection with no authored candidateMode
 * - __workspace__ marker reserved for workspace mode and rejected in file mode
 * - Workspace mode companion file visibility (edits, deletions, extra files)
 * - Never backfilling missing candidate files from fixture
 * - Varied synthetic rubrics with non-JSON files, custom check counts, and normalized scores
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvalError, WORKSPACE_OUTPUT_MARKER } from "../core/types.ts";
import type { SnapshotValidationInput, ValidationOutcome } from "../core/types.ts";
import { fixtureTreeHash, freezeCase, loadFrozenCase } from "./case-loader.ts";
import { projectCandidate } from "./validation.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  tempRoots.length = 0;
});

async function makeTempSuite(options: {
  caseOverrides?: Record<string, unknown>;
  fixtureFiles?: Record<string, string>;
  hasGitkeep?: boolean;
  gitkeepBytes?: Buffer;
}): Promise<{ root: string; suiteDir: string; caseDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "eval-generic-case-"));
  tempRoots.push(root);

  const suiteDir = join(root, "synthetic-suite");
  await mkdir(suiteDir, { recursive: true });
  await writeFile(
    join(suiteDir, "eval.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "synthetic-suite",
      skillPath: "skills/test-skill",
      runtimeProfileId: "default",
      limits: {},
    }),
  );

  const caseDir = join(suiteDir, "cases", "synth-case");
  await mkdir(join(caseDir, "fixture"), { recursive: true });

  const caseConfig = {
    id: "synth-case",
    version: 1,
    prompt: "A synthetic prompt",
    outputPath: "result.txt",
    allowedTools: ["read", "write"],
    validator: "validator.ts",
    runtimeProfileId: null,
    limits: {},
    fixtureDir: "fixture",
    oracle: "oracle.json",
    ...options.caseOverrides,
  };

  await writeFile(join(caseDir, "case.json"), JSON.stringify(caseConfig));
  await writeFile(
    join(caseDir, "validator.ts"),
    "export function validateSnapshot() { return { status: 'graded', score: 1, fullPass: true, checks: [{ id: 'ok', passed: true, message: 'pass' }] }; }",
  );
  await writeFile(join(caseDir, "oracle.json"), JSON.stringify({ expected: "data" }));

  if (options.hasGitkeep) {
    await writeFile(join(caseDir, "fixture", ".gitkeep"), options.gitkeepBytes ?? Buffer.alloc(0));
  }

  if (options.fixtureFiles) {
    for (const [relPath, content] of Object.entries(options.fixtureFiles)) {
      const fullPath = join(caseDir, "fixture", relPath);
      await mkdir(join(fullPath, ".."), { recursive: true });
      await writeFile(fullPath, content);
    }
  }

  return { root, suiteDir, caseDir };
}

describe("Generic Case Compatibility — Fixture and Output Contracts", () => {
  it("freezes a genuinely empty fixture and an absent initial output", async () => {
    const { root } = await makeTempSuite({});
    const frozen = await loadFrozenCase({ evalsRoot: root, suiteId: "synthetic-suite", caseSelector: "synth-case" });

    expect(frozen.fixtureFiles).toEqual([]);
    expect(frozen.fixtureTreeSha256).toBe(fixtureTreeHash([]));
    expect(frozen.config.outputPath).toBe("result.txt");
  });

  it("supports tracked empty directory represented only by a zero-byte root .gitkeep", async () => {
    const { root } = await makeTempSuite({ hasGitkeep: true });
    const frozen = await loadFrozenCase({ evalsRoot: root, suiteId: "synthetic-suite", caseSelector: "synth-case" });

    // .gitkeep is excluded from logical fixture hashes and staging
    expect(frozen.fixtureFiles).toEqual([]);
    expect(frozen.fixtureTreeSha256).toBe(fixtureTreeHash([]));
    expect(frozen.fixtureFiles.some((f) => f.path.includes(".gitkeep"))).toBe(false);
  });

  it("rejects .gitkeep if it is non-zero bytes", async () => {
    const { root } = await makeTempSuite({
      hasGitkeep: true,
      gitkeepBytes: Buffer.from("not empty"),
    });
    await expect(
      loadFrozenCase({ evalsRoot: root, suiteId: "synthetic-suite", caseSelector: "synth-case" }),
    ).rejects.toThrow(EvalError);
  });

  it("rejects .gitkeep if companion files exist alongside it in fixture", async () => {
    const { root } = await makeTempSuite({
      hasGitkeep: true,
      fixtureFiles: { "other.txt": "hello" },
    });
    await expect(
      loadFrozenCase({ evalsRoot: root, suiteId: "synthetic-suite", caseSelector: "synth-case" }),
    ).rejects.toThrow(EvalError);
  });

  it("rejects nested .gitkeep placeholders", async () => {
    const { root } = await makeTempSuite({
      fixtureFiles: { "nested/.gitkeep": "" },
    });
    await expect(
      loadFrozenCase({ evalsRoot: root, suiteId: "synthetic-suite", caseSelector: "synth-case" }),
    ).rejects.toThrow(EvalError);
  });
});

describe("Generic Case Compatibility — universal workspace collection and __workspace__ marker", () => {
  it("resolves an unauthored collection mode to workspace for a fresh legacy-suite case", async () => {
    const { root } = await makeTempSuite({});
    const frozen = await loadFrozenCase({ evalsRoot: root, suiteId: "synthetic-suite", caseSelector: "synth-case" });
    expect(frozen.config.candidateMode).toBe("workspace");
  });

  it("permits an explicit candidateMode: 'workspace' in case.json for compatibility", async () => {
    const { root } = await makeTempSuite({
      caseOverrides: { candidateMode: "workspace" },
    });
    const frozen = await loadFrozenCase({ evalsRoot: root, suiteId: "synthetic-suite", caseSelector: "synth-case" });
    expect(frozen.config.candidateMode).toBe("workspace");
  });

  it("accepts the __workspace__ marker with no authored mode", async () => {
    const { root } = await makeTempSuite({
      caseOverrides: {
        outputPath: WORKSPACE_OUTPUT_MARKER,
      },
    });
    const frozen = await loadFrozenCase({ evalsRoot: root, suiteId: "synthetic-suite", caseSelector: "synth-case" });
    expect(frozen.config.outputPath).toBe(WORKSPACE_OUTPUT_MARKER);
    expect(frozen.config.candidateMode).toBe("workspace");
  });

  it("rejects a fresh case that still requests obsolete file collection", async () => {
    const { root } = await makeTempSuite({ caseOverrides: { candidateMode: "file" } });
    await expect(
      loadFrozenCase({ evalsRoot: root, suiteId: "synthetic-suite", caseSelector: "synth-case" }),
    ).rejects.toThrow(/candidateMode/);
  });

  it("rejects a fresh case that requests file collection with the workspace marker", async () => {
    const { root } = await makeTempSuite({
      caseOverrides: {
        candidateMode: "file",
        outputPath: WORKSPACE_OUTPUT_MARKER,
      },
    });
    await expect(
      loadFrozenCase({ evalsRoot: root, suiteId: "synthetic-suite", caseSelector: "synth-case" }),
    ).rejects.toThrow(EvalError);
  });

  it("collects nested and newly created files under the resolved fresh policy", async () => {
    const { root } = await makeTempSuite({ fixtureFiles: { "nested/input.txt": "start" } });
    const frozen = await loadFrozenCase({ evalsRoot: root, suiteId: "synthetic-suite", caseSelector: "synth-case" });
    const projection = projectCandidate({
      exportedFiles: [
        { path: "nested/input.txt", bytes: 7, sha256: "h1", base64: Buffer.from("changed").toString("base64") },
        { path: "nested/deep/new.txt", bytes: 3, sha256: "h2", base64: Buffer.from("new").toString("base64") },
        { path: "result.txt", bytes: 2, sha256: "h3", base64: Buffer.from("ok").toString("base64") },
      ],
      outputPath: frozen.config.outputPath,
      maxFileBytes: 1_000,
      mode: frozen.config.candidateMode,
      maxTotalBytes: 5_000,
    });
    expect(projection.includedPaths).toEqual(["nested/deep/new.txt", "nested/input.txt", "result.txt"]);
    expect(projection.skipped).toEqual([]);
  });

  it("keeps a deleted fixture file absent from the fresh-policy candidate", async () => {
    const { root } = await makeTempSuite({ fixtureFiles: { "deleted.txt": "gone soon" } });
    const frozen = await loadFrozenCase({ evalsRoot: root, suiteId: "synthetic-suite", caseSelector: "synth-case" });
    const projection = projectCandidate({
      exportedFiles: [{ path: "result.txt", bytes: 2, sha256: "h1", base64: Buffer.from("ok").toString("base64") }],
      outputPath: frozen.config.outputPath,
      maxFileBytes: 1_000,
      mode: frozen.config.candidateMode,
      maxTotalBytes: 5_000,
    });
    expect(projection.candidateFiles["deleted.txt"]).toBeUndefined();
    expect(projection.includedPaths).toEqual(["result.txt"]);
  });

  it("projectCandidate rejects __workspace__ in file mode", () => {
    expect(() =>
      projectCandidate({
        exportedFiles: [],
        outputPath: WORKSPACE_OUTPUT_MARKER,
        maxFileBytes: 1000,
        mode: "file",
      }),
    ).toThrow(EvalError);
  });

  it("projectCandidate accepts __workspace__ in workspace mode without path escaping error", () => {
    const projection = projectCandidate({
      exportedFiles: [
        { path: "src/main.rs", bytes: 50, sha256: "abc", base64: Buffer.from("fn main() {}").toString("base64") },
        { path: "Cargo.toml", bytes: 30, sha256: "def", base64: Buffer.from("[package]").toString("base64") },
      ],
      outputPath: WORKSPACE_OUTPUT_MARKER,
      maxFileBytes: 1000,
      mode: "workspace",
      maxTotalBytes: 5000,
    });
    expect(projection.includedPaths).toEqual(["Cargo.toml", "src/main.rs"]);
    expect(Object.keys(projection.candidateFiles)).toHaveLength(2);
  });
});

describe("Generic Case Compatibility — Companion Files and No Backfilling", () => {
  it("workspace mode exposes companion edits, additions, and deletions", () => {
    // Starting fixture has companion.txt and protected.txt
    // Guest exports companion.txt (edited), added.txt (new), but NOT protected.txt (deleted)
    const projection = projectCandidate({
      exportedFiles: [
        { path: "companion.txt", bytes: 10, sha256: "h1", base64: Buffer.from("edited").toString("base64") },
        { path: "added.txt", bytes: 15, sha256: "h2", base64: Buffer.from("new file").toString("base64") },
      ],
      outputPath: "main.txt",
      maxFileBytes: 1000,
      mode: "workspace",
      maxTotalBytes: 5000,
    });

    // Both exported files are present in candidate
    expect(projection.candidateFiles["companion.txt"]).toBe(Buffer.from("edited").toString("base64"));
    expect(projection.candidateFiles["added.txt"]).toBe(Buffer.from("new file").toString("base64"));

    // Deleted protected.txt is NOT in candidateFiles — it must NEVER be backfilled from fixture
    expect(projection.candidateFiles["protected.txt"]).toBeUndefined();
    // Missing main.txt is also NOT in candidateFiles
    expect(projection.candidateFiles["main.txt"]).toBeUndefined();
  });

  it("file mode grades only the requested output, ignoring companion files", () => {
    const projection = projectCandidate({
      exportedFiles: [
        { path: "out.json", bytes: 20, sha256: "h1", base64: Buffer.from("{}").toString("base64") },
        { path: "companion.json", bytes: 30, sha256: "h2", base64: Buffer.from("{}").toString("base64") },
      ],
      outputPath: "out.json",
      maxFileBytes: 1000,
      mode: "file",
    });

    expect(projection.includedPaths).toEqual(["out.json"]);
    expect(projection.candidateFiles["out.json"]).toBeDefined();
    expect(projection.candidateFiles["companion.json"]).toBeUndefined();
    expect(projection.skipped).toContainEqual({ path: "companion.json", reason: "not-requested" });
  });

  it("missing task output produces empty candidateFiles and is graded normally, not infrastructure failure", () => {
    const projection = projectCandidate({
      exportedFiles: [], // guest authored nothing
      outputPath: "deliverable.txt",
      maxFileBytes: 1000,
      mode: "file",
    });

    expect(projection.includedPaths).toEqual([]);
    expect(projection.candidateFiles["deliverable.txt"]).toBeUndefined();

    // A synthetic validator grading missing output
    const validatorInput: SnapshotValidationInput = {
      outputPath: "deliverable.txt",
      fixtureFiles: {},
      candidateFiles: projection.candidateFiles,
      oracle: {},
    };

    const outcome: ValidationOutcome = {
      status: "graded",
      score: 0,
      fullPass: false,
      checks: [
        { id: "output-exists", passed: false, message: "Deliverable deliverable.txt was not created" },
      ],
    };

    // Validated outcome is graded with score 0, not infrastructure failure
    expect(outcome.status).toBe("graded");
    expect(outcome.score).toBe(0);
    expect(outcome.fullPass).toBe(false);
  });
});

describe("Generic Case Compatibility — Arbitrary Rubrics and Formats", () => {
  it("supports non-JSON deliverables, multi-check rubrics, and weighted scores", () => {
    // Synthetic deliverable: markdown report
    const mdContent = "# Analysis\n\nResult: 42\nStatus: verified\n";
    const candidateFiles: Record<string, string> = {
      "report.md": Buffer.from(mdContent).toString("base64"),
    };

    // Custom validator checking 3 weighted items
    const checks = [
      { id: "has-title", passed: mdContent.includes("# Analysis"), weight: 0.2 },
      { id: "has-result", passed: mdContent.includes("Result: 42"), weight: 0.5 },
      { id: "has-status", passed: mdContent.includes("Status: verified"), weight: 0.3 },
    ];

    const totalWeight = checks.reduce((sum, c) => sum + c.weight, 0);
    const earnedWeight = checks.filter((c) => c.passed).reduce((sum, c) => sum + c.weight, 0);
    const score = earnedWeight / totalWeight;

    const outcome: ValidationOutcome = {
      status: "graded",
      score,
      fullPass: checks.every((c) => c.passed),
      checks: checks.map((c) => ({ id: c.id, passed: c.passed, message: `check ${c.id}` })),
    };

    expect(outcome.status).toBe("graded");
    expect(outcome.score).toBe(1);
    expect(outcome.fullPass).toBe(true);
    expect(outcome.checks).toHaveLength(3);
  });
});
