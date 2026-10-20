import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvalError } from "../../core/types.ts";
import { EVAL_AMBIENT_TOOLS } from "../../runner/run.ts";
import {
  buildAmbientTools,
  compileGlobPattern,
  createGlobTool,
  EVAL_AMBIENT_TOOL_NAMES,
  GLOB_MAX_ENTRIES,
  GLOB_MAX_PATTERN_LENGTH,
  GLOB_MAX_RESULT_BYTES,
  GLOB_MAX_VISITED,
  GLOB_TRUNCATION_MARKER,
} from "./ambient-tools.ts";

function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function execGlob(
  tool: ReturnType<typeof createGlobTool>,
  callId: string,
  params: any,
  signal?: AbortSignal,
): Promise<any> {
  return (tool as any).execute(callId, params, signal, undefined, {} as any);
}

describe("ambient glob tool", () => {
  describe("compileGlobPattern grammar", () => {
    it("handles '*' as any run of characters except '/'", () => {
      const regex = compileGlobPattern("*.ts");
      expect(regex.test("foo.ts")).toBe(true);
      expect(regex.test("bar.ts")).toBe(true);
      expect(regex.test("src/foo.ts")).toBe(false);
      expect(regex.test("foo.js")).toBe(false);
    });

    it("handles '?' as exactly one character except '/'", () => {
      const regex = compileGlobPattern("file?.txt");
      expect(regex.test("file1.txt")).toBe(true);
      expect(regex.test("fileA.txt")).toBe(true);
      expect(regex.test("file.txt")).toBe(false);
      expect(regex.test("file12.txt")).toBe(false);
      expect(regex.test("file/.txt")).toBe(false);
    });

    it("handles '**/' as zero or more whole segments", () => {
      const regex = compileGlobPattern("**/target.json");
      expect(regex.test("target.json")).toBe(true);
      expect(regex.test("src/target.json")).toBe(true);
      expect(regex.test("a/b/c/target.json")).toBe(true);
      expect(regex.test("target_other.json")).toBe(false);

      const nestedRegex = compileGlobPattern("packages/**/dist/index.js");
      expect(nestedRegex.test("packages/dist/index.js")).toBe(true);
      expect(nestedRegex.test("packages/core/dist/index.js")).toBe(true);
      expect(nestedRegex.test("packages/a/b/c/dist/index.js")).toBe(true);
    });

    it("handles trailing '/**' as directory and everything under it", () => {
      const regex = compileGlobPattern("src/**");
      expect(regex.test("src/index.ts")).toBe(true);
      expect(regex.test("src/components/button.tsx")).toBe(true);
      expect(regex.test("src/a/b/c/d.ts")).toBe(true);
      expect(regex.test("srcextra/index.ts")).toBe(false);
      expect(regex.test("other/src/index.ts")).toBe(false);
    });

    it("handles '**' elsewhere as any characters including '/'", () => {
      const regex = compileGlobPattern("**");
      expect(regex.test("a")).toBe(true);
      expect(regex.test("a/b/c")).toBe(true);
      expect(regex.test("a/b/c.txt")).toBe(true);
    });
  });

  describe("refusals (never throwing, returning error results)", () => {
    it("refuses non-string pattern", async () => {
      const ws = makeTempDir("glob-refusal");
      try {
        const tool = createGlobTool(ws);
        const res = await execGlob(tool, "call_1", { pattern: 123 as any });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain("pattern must be a string");
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it("refuses empty pattern", async () => {
      const ws = makeTempDir("glob-refusal");
      try {
        const tool = createGlobTool(ws);
        const res = await execGlob(tool, "call_1", { pattern: "" });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain("pattern cannot be empty");
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it("refuses over-length pattern", async () => {
      const ws = makeTempDir("glob-refusal");
      try {
        const tool = createGlobTool(ws);
        const longPattern = "a".repeat(GLOB_MAX_PATTERN_LENGTH + 1);
        const res = await execGlob(tool, "call_1", { pattern: longPattern });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain("exceeds maximum length");
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it("refuses NUL byte in pattern", async () => {
      const ws = makeTempDir("glob-refusal");
      try {
        const tool = createGlobTool(ws);
        const res = await execGlob(tool, "call_1", { pattern: "src\0/*.ts" });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain("NUL byte");
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it("refuses absolute pattern (leading / or Windows drive)", async () => {
      const ws = makeTempDir("glob-refusal");
      try {
        const tool = createGlobTool(ws);
        const res1 = await execGlob(tool, "call_1", { pattern: "/etc/passwd" });
        expect(res1.isError).toBe(true);
        expect(res1.content[0].text).toContain("absolute pattern not allowed");

        const res2 = await execGlob(tool, "call_2", { pattern: "C:/Windows" });
        expect(res2.isError).toBe(true);
        expect(res2.content[0].text).toContain("absolute pattern not allowed");
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it("refuses any '..'", async () => {
      const ws = makeTempDir("glob-refusal");
      try {
        const tool = createGlobTool(ws);
        const res = await execGlob(tool, "call_1", { pattern: "../secret.txt" });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain("path traversal '..'");
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it("refuses backslash", async () => {
      const ws = makeTempDir("glob-refusal");
      try {
        const tool = createGlobTool(ws);
        const res = await execGlob(tool, "call_1", { pattern: "src\\file.ts" });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain("backslash not allowed");
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it.each(["{", "}", "[", "]", "!", "(", ")", "|"])(
      "refuses unsupported glob metacharacter '%s'",
      async (char) => {
        const ws = makeTempDir("glob-refusal");
        try {
          const tool = createGlobTool(ws);
          const res = await execGlob(tool, "call_1", { pattern: `test${char}.ts` });
          expect(res.isError).toBe(true);
          expect(res.content[0].text).toContain("unsupported glob metacharacter");
        } finally {
          rmSync(ws, { recursive: true, force: true });
        }
      },
    );

    it.each([0, -1, 501, 1.5, "50" as any])("refuses invalid limit: %s", async (badLimit) => {
      const ws = makeTempDir("glob-refusal");
      try {
        const tool = createGlobTool(ws);
        const res = await execGlob(tool, "call_1", { pattern: "*.ts", limit: badLimit });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain("limit must be an integer between 1 and 500");
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it("refuses aborted signal", async () => {
      const ws = makeTempDir("glob-refusal");
      try {
        const tool = createGlobTool(ws);
        const controller = new AbortController();
        controller.abort();
        const res = await execGlob(tool, "call_1", { pattern: "*.ts" }, controller.signal);
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain("Operation aborted");
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it("returns error result for unreadable workspace root", async () => {
      const tool = createGlobTool("/nonexistent/path/that/does/not/exist");
      const res = await execGlob(tool, "call_1", { pattern: "*.ts" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("unreadable workspace root");
    });
  });

  describe("execution and traversal behavior", () => {
    it("returns zero matches as 'no files matched' without error", async () => {
      const ws = makeTempDir("glob-zero");
      try {
        const tool = createGlobTool(ws);
        const res = await execGlob(tool, "call_1", { pattern: "*.ts" });
        expect(res.content[0].text).toBe("no files matched");
        expect(res.isError).toBeFalsy();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it("returns byte-sorted deterministic list of regular files", async () => {
      const ws = makeTempDir("glob-sort");
      try {
        mkdirSync(join(ws, "src/nested"), { recursive: true });
        writeFileSync(join(ws, "z.ts"), "z");
        writeFileSync(join(ws, "a.ts"), "a");
        writeFileSync(join(ws, "src/b.ts"), "b");
        writeFileSync(join(ws, "src/nested/c.ts"), "c");

        const tool = createGlobTool(ws);
        const res = await execGlob(tool, "call_1", { pattern: "**/*.ts" });
        expect(res.content[0].text).toBe("a.ts\nsrc/b.ts\nsrc/nested/c.ts\nz.ts");
        expect(res.isError).toBeFalsy();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it("never follows or returns symlinks, counts them and appends [skipped N symlink(s)]", async () => {
      const ws = makeTempDir("glob-symlink");
      try {
        mkdirSync(join(ws, "src"), { recursive: true });
        writeFileSync(join(ws, "src/real.ts"), "real");
        symlinkSync(join(ws, "src/real.ts"), join(ws, "src/link1.ts"));
        symlinkSync(join(ws, "src"), join(ws, "src_link"));

        const tool = createGlobTool(ws);
        const res = await execGlob(tool, "call_1", { pattern: "**" });
        const lines = res.content[0].text.split("\n");
        expect(lines).toContain("src/real.ts");
        expect(lines).not.toContain("src/link1.ts");
        expect(lines).not.toContain("src_link");
        expect(lines).toContain("[skipped 2 symlink(s)]");
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it("caps results at user-specified limit after sorting and marks [truncated]", async () => {
      const ws = makeTempDir("glob-cap-limit");
      try {
        writeFileSync(join(ws, "a.txt"), "a");
        writeFileSync(join(ws, "b.txt"), "b");
        writeFileSync(join(ws, "c.txt"), "c");
        writeFileSync(join(ws, "d.txt"), "d");

        const tool = createGlobTool(ws);
        const res = await execGlob(tool, "call_1", { pattern: "*.txt", limit: 2 });
        expect(res.content[0].text).toBe(`a.txt\nb.txt\n${GLOB_TRUNCATION_MARKER}`);
        expect(res.isError).toBeFalsy();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it("caps results at GLOB_MAX_VISITED visited entries and marks [truncated]", async () => {
      const ws = makeTempDir("glob-cap-visited");
      try {
        // Create 20 files
        for (let i = 0; i < 20; i++) {
          writeFileSync(join(ws, `file-${String(i).padStart(3, "0")}.txt`), "data");
        }
        const tool = createGlobTool(ws);
        const res = await execGlob(tool, "call_1", { pattern: "*.txt", limit: 5 });
        const lines = res.content[0].text.split("\n");
        expect(lines.length).toBe(6); // 5 items + [truncated]
        expect(lines[lines.length - 1]).toBe(GLOB_TRUNCATION_MARKER);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it("caps results at GLOB_MAX_RESULT_BYTES, drops whole lines, and ends with [truncated]", async () => {
      const ws = makeTempDir("glob-cap-bytes");
      try {
        // Create files with long paths that will exceed GLOB_MAX_RESULT_BYTES
        const sub = join(ws, "very/deep/nested/directory/structure/with/long/path/name");
        mkdirSync(sub, { recursive: true });
        for (let i = 0; i < 400; i++) {
          writeFileSync(join(sub, `file-with-a-very-long-file-name-padding-${String(i).padStart(4, "0")}.txt`), "x");
        }

        const tool = createGlobTool(ws);
        const res = await execGlob(tool, "call_1", { pattern: "**/*.txt" });
        const output = res.content[0].text;
        expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(GLOB_MAX_RESULT_BYTES);
        const lines = output.split("\n");
        expect(lines[lines.length - 1]).toBe(GLOB_TRUNCATION_MARKER);
        expect(res.isError).toBeFalsy();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe("buildAmbientTools", () => {
    it("returns ambient tools in EVAL_AMBIENT_TOOL_NAMES order", () => {
      const ws = makeTempDir("ambient-order");
      try {
        const tools = buildAmbientTools(["glob"], ws);
        expect(tools.length).toBe(1);
        expect(tools[0]!.name).toBe("glob");
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it("throws EvalError input-invalid for unknown ambient tool", () => {
      expect(() => buildAmbientTools(["unknown-tool"], "/tmp")).toThrow(EvalError);
      try {
        buildAmbientTools(["unknown-tool"], "/tmp");
      } catch (err: any) {
        expect(err.code).toBe("input-invalid");
      }
    });

    it("returns empty array when no ambient tools requested", () => {
      const tools = buildAmbientTools([], "/tmp");
      expect(tools).toEqual([]);
    });

    it("declares the same ambient set the runner requests", () => {
      // Two constants name this set; a divergence would either leave a requested tool
      // unbuilt or hash a capability the guest never registers.
      expect([...EVAL_AMBIENT_TOOLS]).toEqual([...EVAL_AMBIENT_TOOL_NAMES]);
    });
  });

  describe("hardening", () => {
    it("collapses repeated ** segments instead of backtracking catastrophically", () => {
      const pathological = `${"**/".repeat(60)}needle.txt`;
      const collapsed = compileGlobPattern(pathological);
      // One quantifier group, not sixty.
      expect(collapsed.source).toBe("^(?:[^/]+\\/)*needle\\.txt$");
      const deep = `${Array.from({ length: 40 }, (_, i) => `d${i}`).join("/")}/other.txt`;
      const started = Date.now();
      expect(collapsed.test(deep)).toBe(false);
      expect(Date.now() - started).toBeLessThan(1_000);
      // Collapsing must not change what matches.
      expect(collapsed.test("a/b/c/needle.txt")).toBe(true);
      expect(collapsed.test("needle.txt")).toBe(true);
    });

    it("marks truncation when the depth cap prunes directories", async () => {
      const ws = makeTempDir("glob-depth");
      try {
        let dir = ws;
        for (let depth = 0; depth < 15; depth += 1) {
          dir = join(dir, `d${depth}`);
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(join(dir, "deep.txt"), "x");
        const tool = createGlobTool(ws);
        const result = (await execGlob(tool, "call-depth", { pattern: "**/deep.txt" })) as {
          content: readonly { readonly text: string }[];
        };
        expect(result.content[0]?.text).toContain(GLOB_TRUNCATION_MARKER);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it("keeps the symlink disclosure when the byte cap drops result lines", async () => {
      const ws = makeTempDir("glob-suffix");
      try {
        const wide = "w".repeat(200);
        for (let index = 0; index < 400; index += 1) {
          writeFileSync(join(ws, `${wide}-${String(index).padStart(4, "0")}.txt`), "x");
        }
        symlinkSync(join(ws, "missing-target"), join(ws, "a-link.txt"));
        const tool = createGlobTool(ws);
        const result = (await execGlob(tool, "call-suffix", { pattern: "*.txt" })) as {
          content: readonly { readonly text: string }[];
        };
        const text = result.content[0]?.text ?? "";
        expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(GLOB_MAX_RESULT_BYTES);
        expect(text).toContain(GLOB_TRUNCATION_MARKER);
        expect(text).toContain("[skipped 1 symlink(s)]");
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });
});
