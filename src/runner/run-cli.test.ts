/**
 * Tests for the CLI process boundary in scripts/run.ts.
 *
 * Verifies that:
 * - `--harness fake|pi` is parsed at the process boundary.
 * - Measured production implementations are the default; fake mode is explicit.
 * - `--harness invalid` fails with input-invalid.
 * - `--mode measured` gate refuses when any test double is present and enumerates the doubles.
 * - No provider request is ever made during CLI checks.
 */

import { execFile, execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAllowlistedEnv } from "../test-guards.ts";
import { resolveTargetConfiguration } from "./models.ts";
import { parseArgs } from "../../scripts/run.ts";
import { checkCombinedExports } from "../artifacts/combined-exports.ts";
import { resolveRepositoryUrl } from "../core/report-links.ts";

const RUN_SCRIPT = resolve(process.cwd(), "scripts/run.ts");

// The CLI always writes under eval-cases/<case>/runs. Fake-mode runs started by this file are
// test debris, so remove exactly the new test-double run folders afterwards (never sealed real runs).
const RUNS_DIR = resolve(process.cwd(), "eval-cases/network-config-01/runs");
const runsBefore = new Set<string>();
beforeAll(() => {
  if (existsSync(RUNS_DIR)) for (const name of readdirSync(RUNS_DIR)) runsBefore.add(name);
});
afterAll(() => {
  if (!existsSync(RUNS_DIR)) return;
  // Combined EVALS-<a>+<b>.md files written by this file's multi-model commands are test debris too.
  for (const name of readdirSync(RUNS_DIR)) {
    if (!runsBefore.has(name) && /^EVALS-.*\.md$/.test(name)) rmSync(resolve(RUNS_DIR, name), { force: true });
  }
  for (const name of readdirSync(RUNS_DIR)) {
    if (runsBefore.has(name)) continue;
    const dir = resolve(RUNS_DIR, name);
    try {
      const receipt = JSON.parse(readFileSync(resolve(dir, "receipt.json"), "utf8")) as { testDouble?: boolean };
      if (receipt.testDouble !== true) continue;
    } catch {
      continue;
    }
    execFileSync("chmod", ["-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

const execFileAsync = promisify(execFile);

/**
 * Spawns scripts/run.ts asynchronously. A synchronous spawn blocks the vitest worker's event loop for
 * the whole file, so on a slow CI runner its "onTaskUpdate" RPC times out (60 s) and fails the run.
 */
async function runCli(
  args: readonly string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const pending = execFileAsync(
    process.execPath,
    ["--experimental-strip-types", RUN_SCRIPT, ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60000,
      killSignal: "SIGKILL",
      env: buildAllowlistedEnv(tmpdir(), extraEnv),
    },
  );
  // Match the former stdin "ignore": the child sees EOF instead of an open pipe.
  pending.child.stdin?.end();
  try {
    const { stdout } = await pending;
    return { status: 0, stdout, stderr: "" };
  } catch (error: unknown) {
    const err = error as { code?: number | string | null; stdout?: string; stderr?: string };
    return {
      status: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

describe("CLI process boundary (scripts/run.ts)", () => {
  it("requires one explicit treatment skill and rejects duplicate or conflicting setup selectors", async () => {
    for (const args of [
      ["--case", "network-config-01", "--mode", "fake"],
      ["--case", "network-config-01", "--mode", "fake", "--skill", "src/test-fixtures/skills/mcp-skill", "--skill", "src/test-fixtures/skills/mcp-skill"],
      ["--case", "network-config-01", "--mode", "fake", "--suite", "old", "--skill", "src/test-fixtures/skills/mcp-skill"],
    ]) {
      const result = await runCli(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--skill");
      expect(result.stdout).not.toContain("receipt");
    }
  });

  it("prints usage with --harness options on --help", async () => {
    const { status, stdout } = await runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("--harness fake|pi");
    expect(stdout).toContain("--mode measured|fake");
    expect(stdout).toContain("UNLIMITED by default");
    expect(stdout).toContain("none (or 0) to keep it");
    expect(stdout).toContain("--capture-reasoning");
    expect(stdout).toContain("analyze the model's reasoning");
  });

  it("rejects an invalid --harness value", async () => {
    const { status, stderr } = await runCli([
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "fake",
      "--harness", "unknown-harness",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("FAIL [input-invalid] at --harness: --harness must be one of: fake, pi");
  });

  it("resolves the simplified measured command identically to compatible explicit flags", () => {
    const command = ["--case", "network-config-01", "--skill", "src/test-fixtures/skills/mcp-skill", "--model", "gemini-3.8-flash"];
    const simplified = parseArgs(command);
    const explicit = parseArgs([...command, "--mode", "measured", "--harness", "pi", "--sandbox", "apple-container", "--validator-runner", "isolated-container", "--provider", "google", "--thinking", "low"]);
    expect(simplified).toMatchObject({ mode: "measured", harnessId: "pi", sandboxId: "apple-container", validatorRunnerId: "isolated-container", captureReasoning: false });
    expect({ ...simplified, provider: "google", thinking: "low" }).toEqual(explicit);
    expect(resolveTargetConfiguration({ model: simplified.model!, provider: simplified.provider, thinking: simplified.thinking }))
      .toEqual(resolveTargetConfiguration({ model: explicit.model!, provider: explicit.provider, thinking: explicit.thinking }));
    expect(parseArgs(["--suite", "legacy", "--case", "case-a", "--model", "gemini-3.8-flash"]).suiteId).toBe("legacy");

    const withReasoning = parseArgs([...command, "--capture-reasoning"]);
    expect(withReasoning.captureReasoning).toBe(true);
  });

  it("refuses --mode measured with explicit --harness fake", async () => {
    const { status, stderr } = await runCli([
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "measured",
      "--harness", "fake",
      "--sandbox", "apple-container",
      "--validator-runner", "isolated-container",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("FAIL [not-implemented] at --mode: --mode measured refuses test doubles: harness:fake");
  });

  it("refuses --mode measured with --harness pi and --sandbox fake", async () => {
    const { status, stderr } = await runCli([
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "measured",
      "--harness", "pi",
      "--sandbox", "fake",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("FAIL [not-implemented] at --mode: --mode measured refuses test doubles: sandbox:fake");
  });

  it("refuses --mode measured with --harness pi, --sandbox apple-container, and explicit in-process validator", async () => {
    const { status, stderr } = await runCli([
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "measured",
      "--harness", "pi",
      "--sandbox", "apple-container",
      "--validator-runner", "in-process",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("FAIL [not-implemented] at --mode: --mode measured refuses test doubles: validator-runner:in-process");
  });

  it("rejects invalid combinations BEFORE any container probe or credential load, regardless of container runtime status", async () => {
    // Provide a stripped PATH that has node but no container executable
    const nodeBinDir = dirname(process.execPath);
    const strippedPath = `${nodeBinDir}:/usr/bin:/bin`;
    const { status, stderr } = await runCli(
      [
        "--skill", "src/test-fixtures/skills/mcp-skill",
        "--case", "network-config-01",
        "--mode", "measured",
        "--harness", "pi",
        "--sandbox", "fake",
      ],
      { PATH: strippedPath },
    );
    expect(status).toBe(1);
    // Must fail at argument parsing with not-implemented at --mode, NOT a probe failure or credential load error
    expect(stderr).toContain("FAIL [not-implemented] at --mode: --mode measured refuses test doubles: sandbox:fake");
  });

  it("rejects malformed arguments BEFORE any container probe or credential load", async () => {
    const nodeBinDir = dirname(process.execPath);
    const strippedPath = `${nodeBinDir}:/usr/bin:/bin`;
    const { status, stderr } = await runCli(
      [
        "--skill", "src/test-fixtures/skills/mcp-skill",
        "--case", "network-config-01",
        "--mode", "fake",
        "--repetitions", "-5",
      ],
      { PATH: strippedPath },
    );
    expect(status).toBe(1);
    expect(stderr).toContain("FAIL [input-invalid] at --repetitions: --repetitions must be a positive integer");
  });

  it("requires a model before any probe or credential load", async () => {
    const nodeBinDir = dirname(process.execPath);
    const strippedPath = `${nodeBinDir}:/usr/bin:/bin`;
    const { status, stderr } = await runCli(
      [
        "--skill", "src/test-fixtures/skills/mcp-skill",
        "--case", "network-config-01",
        "--mode", "measured",
        "--harness", "pi",
        "--sandbox", "apple-container",
        "--validator-runner", "isolated-container",
      ],
      { PATH: strippedPath },
    );
    expect(status).toBe(1);
    expect(stderr).toContain("FAIL [input-invalid] at --model: --model is required");
  });

  it("rejects --mode measured when missing --model, even when --provider and --thinking are specified", async () => {
    const nodeBinDir = dirname(process.execPath);
    const strippedPath = `${nodeBinDir}:/usr/bin:/bin`;
    const { status, stderr } = await runCli(
      [
        "--skill", "src/test-fixtures/skills/mcp-skill",
        "--case", "network-config-01",
        "--mode", "measured",
        "--harness", "pi",
        "--sandbox", "apple-container",
        "--validator-runner", "isolated-container",
        "--provider", "google",
        "--thinking", "low",
      ],
      { PATH: strippedPath },
    );
    expect(status).toBe(1);
    expect(stderr).toContain("FAIL [input-invalid] at --model: --model is required");
  });

  it("rejects an unknown model, contradictory provider, and unsupported thinking before credentials", async () => {
    for (const [flags, expected] of [
      [["--model", "gemini-unknown-9.9"], "target.model"],
      [["--model", "gemini-3.8-flash", "--provider", "anthropic"], "Anthropic catalog"],
      [["--model", "gemini-3.8-flash", "--thinking", "minimal"], "target.thinking"],
    ] as const) {
      const result = await runCli(["--case", "network-config-01", "--skill", "src/test-fixtures/skills/mcp-skill", ...flags]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expected);
      expect(result.stderr).not.toContain("credential");
    }
  });

  it("resolves actual case and skill inputs before loading credentials", async () => {
    for (const [caseId, skillPath, expected] of [
      ["absent-case", "src/test-fixtures/skills/mcp-skill", "--case"],
      ["network-config-01", "src/test-fixtures/skills/absent-skill", "--skill"],
    ]) {
      const result = await runCli(["--case", caseId!, "--skill", skillPath!, "--model", "gemini-3.8-flash"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expected);
      expect(result.stderr).not.toContain("credential");
    }
  });

  it("refuses unguarded Pi in fake mode before credentials or provider transport", async () => {
    const result = await runCli(["--case", "network-config-01", "--skill", "src/test-fixtures/skills/mcp-skill", "--mode", "fake", "--harness", "pi", "--model", "gemini-3.8-flash"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("guarded scripted test composition");
    expect(result.stderr).not.toContain("credential-missing");
  });

  it("treats an unlimited (none) per-arm wall clock as null in the frozen policy, arming no finite arm cap", async () => {
    const { status, stdout } = await runCli([
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "fake",
      "--limit", "wallClockMs=none",
      "--format", "json",
    ]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    const policy = JSON.parse(readFileSync(resolve(dirname(parsed.receipt), "inputs/policy.json"), "utf8"));
    // Unlimited is represented explicitly as null, never a huge finite sentinel.
    expect(policy.limits.wallClockMs).toBeNull();
  });

  it("honors an explicit longer finite per-arm wall clock above the former fixed maximum", async () => {
    const { status, stdout } = await runCli([
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "fake",
      "--limit", "wallClockMs=600001",
      "--format", "json",
    ]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    const policy = JSON.parse(readFileSync(resolve(dirname(parsed.receipt), "inputs/policy.json"), "utf8"));
    expect(policy.limits.wallClockMs).toBe(600001);
  });

  it("accepts long finite wallClockMs and explicit unlimited time via CLI", async () => {
    const overflow = await runCli([
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "fake",
      "--limit", "wallClockMs=2147483648",
    ]);
    expect(overflow.status, overflow.stderr).toBe(0);

    const unlimited = await runCli([
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "fake",
      "--limit", "wallClockMs=0",
      "--format", "json",
    ]);
    expect(unlimited.status).toBe(0);
    const parsed = JSON.parse(unlimited.stdout);
    const policy = JSON.parse(readFileSync(resolve(dirname(parsed.receipt), "inputs/policy.json"), "utf8"));
    expect(policy.limits.wallClockMs).toBeNull();
  });

  it("preserves explicit test-double defaults for --mode fake without requiring provider/model", async () => {
    const { status, stdout } = await runCli([
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "fake",
      "--format", "json",
    ]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.target.provider).toBe("google");
    expect(parsed.target.model).toBe("fake-model-0");
    expect(parsed.target.thinking).toBe("off");
    expect(parsed.testDouble).toBe(true);
    // A single-model command writes no combined file and no sealed grouping.
    expect(existsSync(resolve(dirname(parsed.receipt), "inputs/batch.json"))).toBe(false);
    const singleRunId = dirname(parsed.receipt).split("/").pop() as string;
    expect(readdirSync(RUNS_DIR).filter((name) => name.startsWith("EVALS-") && name.includes(singleRunId))).toEqual([]);
    expect(stdout).not.toContain("combined");
    // A verified run also gets both generated exports next to its receipt (outside the hash chain).
    expect(existsSync(resolve(dirname(parsed.receipt), "EVALS.md"))).toBe(true);
    expect(existsSync(resolve(dirname(parsed.receipt), "EVALS-FULL-REPORT.md"))).toBe(true);
    const policy = JSON.parse(readFileSync(resolve(dirname(parsed.receipt), "inputs/policy.json"), "utf8"));
    // Fresh runs are unlimited across all four task budgets, represented explicitly as null.
    expect(policy.limits.wallClockMs).toBeNull();
    expect(policy.limits.maxOutputTokens).toBeNull();
    expect(policy.limits.maxToolSteps).toBeNull();
    expect(policy.limits.maxProviderRequests).toBeNull();
    // Resource/isolation bounds remain finite.
    expect(policy.limits.cpus).toBeGreaterThan(0);
    expect(policy.limits.memoryMiB).toBeGreaterThan(0);
  });

  it("normalizes none/0 to null for every task budget and honors finite opt-ins via CLI", async () => {
    const { status, stdout } = await runCli([
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "fake",
      "--limit", "maxOutputTokens=none",
      "--limit", "maxToolSteps=0",
      "--limit", "maxProviderRequests=250",
      "--limit", "wallClockMs=300000",
      "--format", "json",
    ]);
    expect(status, stdout).toBe(0);
    const parsed = JSON.parse(stdout);
    const policy = JSON.parse(readFileSync(resolve(dirname(parsed.receipt), "inputs/policy.json"), "utf8"));
    expect(policy.limits.maxOutputTokens).toBeNull();
    expect(policy.limits.maxToolSteps).toBeNull();
    expect(policy.limits.maxProviderRequests).toBe(250);
    expect(policy.limits.wallClockMs).toBe(300000);
  });

  it.each(["maxOutputTokens", "maxToolSteps", "maxProviderRequests", "cpus", "pids"])(
    "rejects a fractional/negative --limit %s",
    async (key) => {
      const { status, stderr } = await runCli([
        "--skill", "src/test-fixtures/skills/mcp-skill",
        "--case", "network-config-01",
        "--mode", "fake",
        "--limit", `${key}=1.5`,
      ]);
      expect(status).not.toBe(0);
      expect(stderr).toContain("--limit");
    },
  );

  it.each(["cpus", "memoryMiB", "pids", "diskMiB"])(
    "refuses to disable resource bound %s via none",
    async (key) => {
      const { status, stderr } = await runCli([
        "--skill", "src/test-fixtures/skills/mcp-skill",
        "--case", "network-config-01",
        "--mode", "fake",
        "--limit", `${key}=none`,
      ]);
      expect(status).not.toBe(0);
      expect(stderr).toContain("--limit");
    },
  );

  it("preserves fake mode compatibility when --thinking is passed without provider/model", async () => {
    const { status, stdout } = await runCli([
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "fake",
      "--thinking", "high",
      "--format", "json",
    ]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.target.provider).toBe("google");
    expect(parsed.target.model).toBe("fake-model-0");
    expect(parsed.target.thinking).toBe("high");
  });

  it("accepts repeated --model, in argument order, and refuses a duplicate model", async () => {
    const command = ["--case", "network-config-01", "--skill", "src/test-fixtures/skills/mcp-skill"];
    const parsed = parseArgs([...command, "--model", "gemini-3.8-flash", "--model", "gemini-4-argon"]);
    expect(parsed.models).toEqual(["gemini-3.8-flash", "gemini-4-argon"]);
    expect(parseArgs([...command, "--model", "gemini-3.8-flash"]).models).toEqual(["gemini-3.8-flash"]);
    expect(() => parseArgs([...command, "--model", "gemini-3.8-flash", "--model", "gemini-3.8-flash"])).toThrow(/more than once/);

    // Refused by the real process before any probe, credential or run.
    const nodeBinDir = dirname(process.execPath);
    const result = await runCli(
      [...command, "--model", "gemini-3.8-flash", "--model", "gemini-3.8-flash"],
      { PATH: `${nodeBinDir}:/usr/bin:/bin` },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FAIL [input-invalid] at --model:");
    expect(result.stderr).not.toContain("credential");
  });

  it("refuses --format json with more than one --model", async () => {
    const args = ["--case", "network-config-01", "--skill", "src/test-fixtures/skills/mcp-skill", "--mode", "fake", "--model", "gemini-3.8-flash", "--model", "gemini-4-argon"];
    expect(() => parseArgs([...args, "--format", "json"])).toThrow(/--format json supports exactly one --model/);
    const result = await runCli([...args, "--format", "json"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"success": false');
    expect(result.stdout).not.toContain("receipt.json");
  });

  it("runs two models as independent sealed runs and writes one combined EVALS.md in runs/ (fake mode)", async () => {
    const { status, stdout, stderr } = await runCli([
      "--skill", "src/test-fixtures/skills/mcp-skill",
      "--case", "network-config-01",
      "--mode", "fake",
      "--model", "gemini-3.8-flash",
      "--model", "gemini-4-argon",
      "--limit", "wallClockMs=300000",
      "--quiet",
    ]);
    expect(status, `${stdout}\n${stderr}`).toBe(0);

    // The two runs are the ones printed in the per-model summary lines (other tests may add runs concurrently).
    const fresh = [...stdout.matchAll(/^ {2}\d\. .* {2}run (\S+) {2}receipt /gm)].map((m) => m[1]!);
    expect(fresh).toHaveLength(2);
    for (const name of fresh) expect(runsBefore.has(name)).toBe(false);
    const members = fresh.map((name) => {
      const dir = resolve(RUNS_DIR, name);
      const target = JSON.parse(readFileSync(resolve(dir, "inputs/target.json"), "utf8")) as { model: string };
      const policy = JSON.parse(readFileSync(resolve(dir, "inputs/policy.json"), "utf8")) as { limits: { wallClockMs: number } };
      // No sealed grouping: each run is fully independent and keeps its own exports.
      expect(existsSync(resolve(dir, "inputs/batch.json"))).toBe(false);
      expect(existsSync(resolve(dir, "EVALS.md"))).toBe(true);
      expect(existsSync(resolve(dir, "EVALS-FULL-REPORT.md"))).toBe(true);
      // Per-run limits and clock: the second run is not cut short by the first run's elapsed time.
      expect(policy.limits.wallClockMs).toBe(300000);
      return { name, target };
    });
    expect(members.map((m) => m.target.model)).toEqual(["gemini-3.8-flash", "gemini-4-argon"]);

    // No batch folder and no batch output.
    expect(existsSync(resolve(process.cwd(), "eval-cases/network-config-01/batches"))).toBe(false);
    expect(stdout).not.toMatch(/^batch /m);

    const combinedName = `EVALS-${members[0]!.name}+${members[1]!.name}.md`;
    const combinedRel = `eval-cases/network-config-01/runs/${combinedName}`;
    expect(stdout).toContain(`combined  ${combinedRel}`);
    const text = readFileSync(resolve(process.cwd(), combinedRel), "utf8");
    expect(text).toContain("Google Gemini 3.8 Flash");
    expect(text).toContain("Google Gemini 4 Argon");
    for (const member of members) expect(text).toContain(`runs/${member.name}/EVALS-FULL-REPORT.md`);
    // It is fresh by the same semantics as `eval:export --check` (same repository URL as the CLI).
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as { repository?: string | { url?: string } };
    const repoUrl = resolveRepositoryUrl(undefined, typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url);
    const check = await checkCombinedExports({ receiptPaths: members.map((m) => resolve(RUNS_DIR, m.name, "receipt.json")), repoUrl });
    expect(check, JSON.stringify(check)).toMatchObject({ ok: true, problem: null });
    // The combined file is not a run: history ignores it, and it is the only new non-run entry.
    expect(readdirSync(RUNS_DIR)).toContain(combinedName);
  });
});
