/**
 * Tests for the CLI process boundary in evals/scripts/run.ts.
 *
 * Verifies that:
 * - `--harness fake|pi` is parsed at the process boundary.
 * - Measured production implementations are the default; fake mode is explicit.
 * - `--harness invalid` fails with input-invalid.
 * - `--mode measured` gate refuses when any test double is present and enumerates the doubles.
 * - No provider request is ever made during CLI checks.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildAllowlistedEnv } from "../test-guards.ts";
import { resolveTargetConfiguration } from "./models.ts";
import { parseArgs } from "../../scripts/run.ts";

const RUN_SCRIPT = resolve(process.cwd(), "evals/scripts/run.ts");

function runCli(
  args: readonly string[],
  extraEnv: Record<string, string | undefined> = {},
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--experimental-strip-types", RUN_SCRIPT, ...args],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: 15000,
        killSignal: "SIGKILL",
        env: buildAllowlistedEnv(tmpdir(), extraEnv),
      },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (error: unknown) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

describe("CLI process boundary (evals/scripts/run.ts)", () => {
  it("requires one explicit treatment skill and rejects duplicate or conflicting setup selectors", () => {
    for (const args of [
      ["--case", "network-config-01", "--mode", "fake"],
      ["--case", "network-config-01", "--mode", "fake", "--skill", "skills/arbitrum-docs", "--skill", "skills/arbitrum-docs"],
      ["--case", "network-config-01", "--mode", "fake", "--suite", "old", "--skill", "skills/arbitrum-docs"],
    ]) {
      const result = runCli(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--skill");
      expect(result.stdout).not.toContain("receipt");
    }
  });

  it("prints usage with --harness options on --help", () => {
    const { status, stdout } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("--harness fake|pi");
    expect(stdout).toContain("--mode measured|fake");
    expect(stdout).toContain("UNLIMITED by default");
    expect(stdout).toContain("none (or 0) to keep it");
    expect(stdout).toContain("--capture-reasoning");
    expect(stdout).toContain("analyze the model's reasoning");
  });

  it("rejects an invalid --harness value", () => {
    const { status, stderr } = runCli([
      "--skill", "skills/arbitrum-docs",
      "--case", "network-config-01",
      "--mode", "fake",
      "--harness", "unknown-harness",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("FAIL [input-invalid] at --harness: --harness must be one of: fake, pi");
  });

  it("resolves the simplified measured command identically to compatible explicit flags", () => {
    const command = ["--case", "network-config-01", "--skill", "skills/arbitrum-docs", "--model", "gemini-3.8-flash"];
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

  it("refuses --mode measured with explicit --harness fake", () => {
    const { status, stderr } = runCli([
      "--skill", "skills/arbitrum-docs",
      "--case", "network-config-01",
      "--mode", "measured",
      "--harness", "fake",
      "--sandbox", "apple-container",
      "--validator-runner", "isolated-container",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("FAIL [not-implemented] at --mode: --mode measured refuses test doubles: harness:fake");
  });

  it("refuses --mode measured with --harness pi and --sandbox fake", () => {
    const { status, stderr } = runCli([
      "--skill", "skills/arbitrum-docs",
      "--case", "network-config-01",
      "--mode", "measured",
      "--harness", "pi",
      "--sandbox", "fake",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("FAIL [not-implemented] at --mode: --mode measured refuses test doubles: sandbox:fake");
  });

  it("refuses --mode measured with --harness pi, --sandbox apple-container, and explicit in-process validator", () => {
    const { status, stderr } = runCli([
      "--skill", "skills/arbitrum-docs",
      "--case", "network-config-01",
      "--mode", "measured",
      "--harness", "pi",
      "--sandbox", "apple-container",
      "--validator-runner", "in-process",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("FAIL [not-implemented] at --mode: --mode measured refuses test doubles: validator-runner:in-process");
  });

  it("rejects invalid combinations BEFORE any container probe or credential load, regardless of container runtime status", () => {
    // Provide a stripped PATH that has node but no container executable
    const nodeBinDir = dirname(process.execPath);
    const strippedPath = `${nodeBinDir}:/usr/bin:/bin`;
    const { status, stderr } = runCli(
      [
        "--skill", "skills/arbitrum-docs",
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

  it("rejects malformed arguments BEFORE any container probe or credential load", () => {
    const nodeBinDir = dirname(process.execPath);
    const strippedPath = `${nodeBinDir}:/usr/bin:/bin`;
    const { status, stderr } = runCli(
      [
        "--skill", "skills/arbitrum-docs",
        "--case", "network-config-01",
        "--mode", "fake",
        "--repetitions", "-5",
      ],
      { PATH: strippedPath },
    );
    expect(status).toBe(1);
    expect(stderr).toContain("FAIL [input-invalid] at --repetitions: --repetitions must be a positive integer");
  });

  it("requires a model before any probe or credential load", () => {
    const nodeBinDir = dirname(process.execPath);
    const strippedPath = `${nodeBinDir}:/usr/bin:/bin`;
    const { status, stderr } = runCli(
      [
        "--skill", "skills/arbitrum-docs",
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

  it("rejects --mode measured when missing --model, even when --provider and --thinking are specified", () => {
    const nodeBinDir = dirname(process.execPath);
    const strippedPath = `${nodeBinDir}:/usr/bin:/bin`;
    const { status, stderr } = runCli(
      [
        "--skill", "skills/arbitrum-docs",
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

  it("rejects an unknown model, contradictory provider, and unsupported thinking before credentials", () => {
    for (const [flags, expected] of [
      [["--model", "gemini-unknown-9.9"], "target.model"],
      [["--model", "gemini-3.8-flash", "--provider", "anthropic"], "Anthropic catalog"],
      [["--model", "gemini-3.8-flash", "--thinking", "minimal"], "target.thinking"],
    ] as const) {
      const result = runCli(["--case", "network-config-01", "--skill", "skills/arbitrum-docs", ...flags]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expected);
      expect(result.stderr).not.toContain("credential");
    }
  });

  it("resolves actual case and skill inputs before loading credentials", () => {
    for (const [caseId, skillPath, expected] of [
      ["absent-case", "skills/arbitrum-docs", "--case"],
      ["network-config-01", "skills/absent-skill", "--skill"],
    ]) {
      const result = runCli(["--case", caseId!, "--skill", skillPath!, "--model", "gemini-3.8-flash"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expected);
      expect(result.stderr).not.toContain("credential");
    }
  });

  it("refuses unguarded Pi in fake mode before credentials or provider transport", () => {
    const result = runCli(["--case", "network-config-01", "--skill", "skills/arbitrum-docs", "--mode", "fake", "--harness", "pi", "--model", "gemini-3.8-flash"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("guarded scripted test composition");
    expect(result.stderr).not.toContain("credential-missing");
  });

  it("treats an unlimited (none) per-arm wall clock as null in the frozen policy, arming no finite arm cap", () => {
    const { status, stdout } = runCli([
      "--skill", "skills/arbitrum-docs",
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

  it("honors an explicit longer finite per-arm wall clock above the former fixed maximum", () => {
    const { status, stdout } = runCli([
      "--skill", "skills/arbitrum-docs",
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

  it("accepts long finite wallClockMs and explicit unlimited time via CLI", () => {
    const overflow = runCli([
      "--skill", "skills/arbitrum-docs",
      "--case", "network-config-01",
      "--mode", "fake",
      "--limit", "wallClockMs=2147483648",
    ]);
    expect(overflow.status, overflow.stderr).toBe(0);

    const unlimited = runCli([
      "--skill", "skills/arbitrum-docs",
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

  it("preserves explicit test-double defaults for --mode fake without requiring provider/model", () => {
    const { status, stdout } = runCli([
      "--skill", "skills/arbitrum-docs",
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

  it("normalizes none/0 to null for every task budget and honors finite opt-ins via CLI", () => {
    const { status, stdout } = runCli([
      "--skill", "skills/arbitrum-docs",
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
    (key) => {
      const { status, stderr } = runCli([
        "--skill", "skills/arbitrum-docs",
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
    (key) => {
      const { status, stderr } = runCli([
        "--skill", "skills/arbitrum-docs",
        "--case", "network-config-01",
        "--mode", "fake",
        "--limit", `${key}=none`,
      ]);
      expect(status).not.toBe(0);
      expect(stderr).toContain("--limit");
    },
  );

  it("preserves fake mode compatibility when --thinking is passed without provider/model", () => {
    const { status, stdout } = runCli([
      "--skill", "skills/arbitrum-docs",
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
});
