/** Argument handling of scripts/export.ts for the combined (several --receipt) forms (spawned; reads no real evidence). */

import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAllowlistedEnv } from "../test-guards.ts";

const EXPORT_SCRIPT = resolve(process.cwd(), "scripts/export.ts");
const RA = "no-such-dir-a/receipt.json";
const RB = "no-such-dir-b/receipt.json";

function runExport(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--experimental-strip-types", EXPORT_SCRIPT, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 60000,
      killSignal: "SIGKILL",
      env: buildAllowlistedEnv(tmpdir(), {}),
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error: unknown) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("eval:export with several --receipt (scripts/export.ts)", () => {
  it("documents the combined form in --help and no batch form", () => {
    const { status, stdout } = runExport(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Several --receipt flags write");
    expect(stdout).toContain("EVALS-<run-id>+<run-id>[+...].md");
    expect(stdout).not.toContain("--batch");
    expect(stdout).not.toContain("batches/");
  });

  it.each([
    [["--receipt", RA, "--receipt", RB, "--pair", "r001"], /--all, --to and --pair cannot be combined with several --receipt/],
    [["--receipt", RA, "--receipt", RB, "--to", "out.md"], /--all, --to and --pair cannot be combined with several --receipt/],
    [["--receipt", RA, "--receipt", RB, "--all", "--check"], /--all, --to and --pair cannot be combined with several --receipt/],
    [["--receipt", RA, "--receipt", RB, "--check", "--regenerate"], /mutually exclusive/],
    [["--batch", "20991231T235959Z-deadbeef"], /unknown argument: --batch/],
  ] as const)("refuses %j", (args, pattern) => {
    const result = runExport(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(pattern);
    expect(result.stdout).toBe("");
  });

  it("fails clearly when a receipt does not exist, for write and check forms, and writes nothing", () => {
    for (const extra of [[], ["--check"]]) {
      const result = runExport(["--receipt", RA, "--receipt", RB, ...extra]);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("wrote");
      expect(result.stdout).not.toContain("ok ");
    }
  });
});
