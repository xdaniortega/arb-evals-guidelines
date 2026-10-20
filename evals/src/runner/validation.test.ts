/**
 * Candidate projection modes and validator dispatch.
 *
 * The projected candidate is exactly what gets graded, so its bounds decide what a
 * guest can push into scoring. These tests pin both modes, every skip reason, the
 * duplicate-path failure, and the deterministic workspace budget.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EvalError } from "../core/types.ts";
import { sha256Hex } from "../core/experiment.ts";
import { createInProcessValidatorRunner, fixtureFileMap, projectCandidate } from "./validation.ts";
import type { ExportedFile } from "./validation.ts";

function file(path: string, text: string): ExportedFile {
  const bytes = Buffer.from(text, "utf8");
  return { path, bytes: bytes.byteLength, sha256: sha256Hex(bytes), base64: bytes.toString("base64") };
}

const big = (path: string, size: number): ExportedFile => file(path, "x".repeat(size));

describe("projectCandidate file mode", () => {
  it("projects only the requested output path", () => {
    const projection = projectCandidate({
      exportedFiles: [file("config.json", "{}"), file("notes.md", "hi"), file("a/b.txt", "z")],
      outputPath: "config.json",
      maxFileBytes: 1_000,
      mode: "file",
    });
    expect(projection.includedPaths).toEqual(["config.json"]);
    expect(Object.keys(projection.candidateFiles)).toEqual(["config.json"]);
    expect(projection.skipped.map((entry) => entry.reason)).toEqual(["not-requested", "not-requested"]);
  });

  it("is not an error when the requested output is missing", () => {
    const projection = projectCandidate({
      exportedFiles: [file("notes.md", "hi")],
      outputPath: "config.json",
      maxFileBytes: 1_000,
      mode: "file",
    });
    expect(projection.includedPaths).toEqual([]);
  });

  it("skips an oversize requested output as too-large", () => {
    const projection = projectCandidate({
      exportedFiles: [big("config.json", 50)],
      outputPath: "config.json",
      maxFileBytes: 10,
      mode: "file",
    });
    expect(projection.includedPaths).toEqual([]);
    expect(projection.skipped).toEqual([{ path: "config.json", reason: "too-large" }]);
  });

  it("skips an unsafe exported path", () => {
    const projection = projectCandidate({
      exportedFiles: [file("config.json", "{}"), { ...file("x", "y"), path: "../escape.txt" }],
      outputPath: "config.json",
      maxFileBytes: 1_000,
      mode: "file",
    });
    expect(projection.skipped).toContainEqual({ path: "../escape.txt", reason: "unsafe-path" });
    expect(projection.includedPaths).toEqual(["config.json"]);
  });

  it("ignores maxTotalBytes in file mode", () => {
    const projection = projectCandidate({
      exportedFiles: [big("config.json", 100)],
      outputPath: "config.json",
      maxFileBytes: 1_000,
      maxTotalBytes: 1,
      mode: "file",
    });
    expect(projection.includedPaths).toEqual(["config.json"]);
  });
});

describe("projectCandidate workspace mode", () => {
  it("projects every eligible file in sorted order", () => {
    const projection = projectCandidate({
      exportedFiles: [file("z.txt", "z"), file("a.txt", "a"), file("m/n.txt", "n")],
      outputPath: "a.txt",
      maxFileBytes: 1_000,
      maxTotalBytes: 1_000,
      mode: "workspace",
    });
    expect(projection.includedPaths).toEqual(["a.txt", "m/n.txt", "z.txt"]);
    expect(projection.skipped).toEqual([]);
  });

  it("still skips an oversize file while including the rest", () => {
    const projection = projectCandidate({
      exportedFiles: [file("a.txt", "a"), big("b.txt", 50)],
      outputPath: "a.txt",
      maxFileBytes: 10,
      maxTotalBytes: 1_000,
      mode: "workspace",
    });
    expect(projection.includedPaths).toEqual(["a.txt"]);
    expect(projection.skipped).toEqual([{ path: "b.txt", reason: "too-large" }]);
  });

  it("still skips an unsafe path", () => {
    const projection = projectCandidate({
      exportedFiles: [{ ...file("x", "y"), path: "/etc/passwd" }, file("a.txt", "a")],
      outputPath: "a.txt",
      maxFileBytes: 100,
      maxTotalBytes: 100,
      mode: "workspace",
    });
    expect(projection.skipped).toEqual([{ path: "/etc/passwd", reason: "unsafe-path" }]);
    expect(projection.includedPaths).toEqual(["a.txt"]);
  });

  it("enforces the aggregate budget deterministically in sorted path order", () => {
    const files = [big("c.txt", 10), big("a.txt", 10), big("b.txt", 10)];
    const forward = projectCandidate({
      exportedFiles: files,
      outputPath: "a.txt",
      maxFileBytes: 100,
      maxTotalBytes: 25,
      mode: "workspace",
    });
    const reversed = projectCandidate({
      exportedFiles: [...files].reverse(),
      outputPath: "a.txt",
      maxFileBytes: 100,
      maxTotalBytes: 25,
      mode: "workspace",
    });
    expect(forward.includedPaths).toEqual(["a.txt", "b.txt"]);
    expect(forward.skipped).toEqual([{ path: "c.txt", reason: "workspace-budget-exhausted" }]);
    expect(reversed.includedPaths).toEqual(forward.includedPaths);
    expect(reversed.skipped).toEqual(forward.skipped);
  });

  it("includes nothing when the budget is smaller than the first file", () => {
    const projection = projectCandidate({
      exportedFiles: [big("a.txt", 10)],
      outputPath: "a.txt",
      maxFileBytes: 100,
      maxTotalBytes: 1,
      mode: "workspace",
    });
    expect(projection.includedPaths).toEqual([]);
    expect(projection.skipped).toEqual([{ path: "a.txt", reason: "workspace-budget-exhausted" }]);
  });

  it("is unbounded only when no budget is supplied", () => {
    const projection = projectCandidate({
      exportedFiles: [big("a.txt", 10_000)],
      outputPath: "a.txt",
      maxFileBytes: 100_000,
      mode: "workspace",
    });
    expect(projection.includedPaths).toEqual(["a.txt"]);
  });
});

describe("projectCandidate shared rules", () => {
  it.each(["file", "workspace"] as const)("throws evidence-invalid on a duplicate path in %s mode", (mode) => {
    let caught: unknown;
    try {
      projectCandidate({
        exportedFiles: [file("config.json", "{}"), file("config.json", "{\"a\":1}")],
        outputPath: "config.json",
        maxFileBytes: 1_000,
        maxTotalBytes: 1_000,
        mode,
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EvalError);
    expect((caught as EvalError).code).toBe("evidence-invalid");
  });

  it("rejects an unsafe requested output path outright", () => {
    expect(() =>
      projectCandidate({ exportedFiles: [], outputPath: "../out.json", maxFileBytes: 10, mode: "file" }),
    ).toThrow(EvalError);
  });
});

describe("fixtureFileMap", () => {
  it("maps relative paths to base64 content", () => {
    const map = fixtureFileMap([
      { path: "config.json", bytes: 2, sha256: "x", base64: Buffer.from("{}").toString("base64") },
    ]);
    expect(map).toEqual({ "config.json": "e30=" });
  });
});

describe("createInProcessValidatorRunner", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  async function writeValidator(source: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "eval-validator-"));
    dirs.push(dir);
    const path = join(dir, "validator.mjs");
    await writeFile(path, source, "utf8");
    return path;
  }

  const input = { outputPath: "config.json", fixtureFiles: {}, candidateFiles: {}, oracle: null };

  it("self-labels as a test double", () => {
    const runner = createInProcessValidatorRunner();
    expect(runner.id).toBe("in-process");
    expect(runner.testDouble).toBe(true);
  });

  it("returns a decoded graded outcome", async () => {
    const path = await writeValidator(
      'export function validateSnapshot() { return { status: "graded", score: 1, fullPass: true, checks: [{ id: "a", passed: true, message: "" }] }; }',
    );
    const run = await createInProcessValidatorRunner().run({ validatorPath: path, input });
    expect(run.outcome.status).toBe("graded");
    expect(run.failure).toBeNull();
  });

  it("reports validator output drift as an infrastructure outcome, never a score", async () => {
    const path = await writeValidator(
      'export function validateSnapshot() { return { status: "graded", score: null, fullPass: true, checks: [{ id: "a", passed: true, message: "" }] }; }',
    );
    const run = await createInProcessValidatorRunner().run({ validatorPath: path, input });
    expect(run.outcome.status).toBe("infrastructure-failure");
    expect(run.outcome.score).toBeNull();
    expect(run.failure?.code).toBe("protocol-drift");
  });

  it("reports a structurally incomplete validator result as an input failure", async () => {
    const path = await writeValidator('export function validateSnapshot() { return { status: "graded" }; }');
    const run = await createInProcessValidatorRunner().run({ validatorPath: path, input });
    expect(run.outcome.status).toBe("infrastructure-failure");
    expect(run.failure?.code).toBe("input-invalid");
  });

  it("reports a missing validateSnapshot export as validator infrastructure", async () => {
    const path = await writeValidator("export const nothing = 1;");
    const run = await createInProcessValidatorRunner().run({ validatorPath: path, input });
    expect(run.failure?.code).toBe("validator-infrastructure");
  });

  it("refuses a validator that exceeds its bounded deadline, as infrastructure and never a score", async () => {
    // A module whose top-level await never settles: the import itself hangs, which is the
    // shape a pathological validator takes. Without a deadline this would hang the run.
    const path = await writeValidator(
      "await new Promise(() => {});\nexport function validateSnapshot() { return null; }\n",
    );
    const run = await createInProcessValidatorRunner().run({ validatorPath: path, input, deadlineMs: 25 });
    expect(run.outcome.status).toBe("infrastructure-failure");
    expect(run.outcome.score).toBeNull();
    expect(run.outcome.fullPass).toBeNull();
    expect(run.failure?.code).toBe("validator-infrastructure");
    expect(run.failure?.failureClass).toBe("infrastructure");
    expect(run.failure?.message).toContain("deadline");
  });

  it("still grades normally inside a generous deadline", async () => {
    const path = await writeValidator(
      'export function validateSnapshot() { return { status: "graded", score: 1, fullPass: true, checks: [{ id: "a", passed: true, message: "" }] }; }',
    );
    const run = await createInProcessValidatorRunner().run({
      validatorPath: path,
      input,
      deadlineMs: 600_000,
    });
    expect(run.outcome.status).toBe("graded");
    expect(run.failure).toBeNull();
  });

  it("honours an abort signal", async () => {
    const path = await writeValidator(
      'export function validateSnapshot() { return { status: "graded", score: 1, fullPass: true, checks: [{ id: "a", passed: true, message: "" }] }; }',
    );
    const controller = new AbortController();
    controller.abort();
    const run = await createInProcessValidatorRunner().run({ validatorPath: path, input, signal: controller.signal });
    expect(run.failure?.code).toBe("interrupted");
    expect(run.outcome.score).toBeNull();
  });
});
