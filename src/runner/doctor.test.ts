import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDoctorArgs } from "../../scripts/doctor.ts";
import { readRunJournal } from "../artifacts/store.ts";
import { createFakeSandbox } from "../sandboxes/fake.ts";
import type { Sandbox } from "../sandboxes/sandbox.ts";
import { buildAllowlistedEnv } from "../test-guards.ts";
import { formatDoctorReport, runReadinessDoctor } from "./doctor.ts";
import { EVAL_NETWORK_POLICY } from "./run.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === "container"
      ? "status running\n"
      : actual.execFileSync(...args),
  };
});

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function syntheticSetup(credentials: string): Promise<{ repoRoot: string; evalsRoot: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), "eval-doctor-"));
  tempDirs.push(repoRoot);
  const evalsRoot = join(repoRoot, "setup");
  await mkdir(join(evalsRoot, "container"), { recursive: true });
  await Promise.all([
    writeFile(join(repoRoot, ".gitignore"), "/setup/.env\n"),
    writeFile(join(evalsRoot, ".env"), credentials),
    ...["Containerfile", "image-lock.json"].map((name) => copyFile(
      join(process.cwd(), "container", name), join(evalsRoot, "container", name),
    )),
  ]);
  execFileSync("git", ["init", "-q", repoRoot], { env: buildAllowlistedEnv(repoRoot), stdio: "pipe" });
  return { repoRoot, evalsRoot };
}

describe("no-request readiness doctor", () => {
  it("runs readiness doctor and structurally guarantees 0 provider requests", async () => {
    const evalsRoot = process.cwd();
    const repoRoot = process.cwd();

    const report = await runReadinessDoctor({
      evalsRoot,
      repoRoot,
      skipGuestReadiness: true, // skip real guest startup for fast unit test
    });

    expect(report.providerRequests).toBe(0);
    expect(report.provider).toBe("google");
    expect(report.model).toBe("gemini-3.8-flash");
    expect(report.thinking).toBe("low");

    // Check that all required checks are present
    const checkIds = report.checks.map((c) => c.id);
    expect(checkIds).toContain("platform");
    expect(checkIds).toContain("apple-container");
    expect(checkIds).toContain("image-pi-pinned");
    expect(checkIds).toContain("credential-present");
    expect(checkIds).not.toContain("model-compatibility");
    expect(checkIds).toContain("guest-readiness");
    expect(checkIds).toContain("zero-request-guard");

    // Verify zero request check passes
    const zeroGuard = report.checks.find((c) => c.id === "zero-request-guard");
    expect(zeroGuard?.passed).toBe(true);
    expect(zeroGuard?.detail).toContain("0 provider completion requests");

    const formatted = formatDoctorReport(report);
    expect(formatted).toContain("Evaluation Subsystem Readiness Doctor");
    expect(formatted).toContain("gemini-3.8-flash");
    expect(formatted).toContain("[PASS]");
  });

  it("verifies the actual pinned pi install line, whatever npm flags it carries", async () => {
    // Regression: the check previously required the exact substring
    // `npm install -g @earendil-works/pi-coding-agent@1.5.0`, so adding npm's
    // `--save-exact` flag to the Containerfile made a correctly pinned image report
    // NOT READY and skipped guest readiness behind it.
    const containerfile = await readFile(`${process.cwd()}/container/Containerfile`, "utf8");
    expect(containerfile).toMatch(/npm install -g[^\n]*@earendil-works\/pi-coding-agent@1\.5\.0/);

    const report = await runReadinessDoctor({
      evalsRoot: process.cwd(),
      repoRoot: process.cwd(),
      skipGuestReadiness: true,
    });
    const pinned = report.checks.find((check) => check.id === "image-pi-pinned");
    expect(pinned?.passed).toBe(true);
    expect(pinned?.detail).toContain("@earendil-works/pi-coding-agent@1.5.0 pinned");
  });

  it("checks a selected Anthropic target using only its synthetic credential", async () => {
    const setup = await syntheticSetup("ANTHROPIC_API_KEY=synthetic-anthropic-doctor-key\n");
    const command = parseDoctorArgs(["--doctor", "--model", "claude-opus-5", "--thinking", "high"]);
    expect(command.mode).toBe("doctor");
    if (command.mode !== "doctor") throw new Error("expected readiness request");
    const report = await runReadinessDoctor({ ...setup, ...command, skipGuestReadiness: true });

    expect(report).toMatchObject({ provider: "anthropic", model: "claude-opus-5", thinking: "high", providerRequests: 0 });
    expect(report.checks.find((check) => check.id === "credential-present")).toMatchObject({ passed: true });
    const formatted = formatDoctorReport(report);
    expect(formatted).toContain("Target: anthropic / claude-opus-5 (thinking: high)");
    expect(formatted).toContain("Target configuration validated against the pinned Pi catalog; live provider compatibility is untested.");
    expect(formatted).toContain("ANTHROPIC_API_KEY present");
    expect(formatted).not.toContain("GEMINI_API_KEY");
    expect(formatted).not.toContain("synthetic-anthropic-doctor-key");
    expect(formatted).not.toContain("Phase 4");
  });

  it("reports a missing selected-provider credential without falling back to Gemini", async () => {
    const setup = await syntheticSetup("GEMINI_API_KEY=synthetic-google-doctor-key\n");
    const report = await runReadinessDoctor({ ...setup, model: "claude-opus-5", skipGuestReadiness: true });
    expect(report.ready).toBe(false);
    const credential = report.checks.find((check) => check.id === "credential-present");
    expect(credential?.passed).toBe(false);
    expect(credential?.detail).toContain("ANTHROPIC_API_KEY");
    expect(credential?.detail).toContain("anthropic / claude-opus-5");
    expect(formatDoctorReport(report)).not.toContain("synthetic-google-doctor-key");
  });

  it.each([
    [{ model: "not-a-supported-model" }, "not-a-supported-model"],
    [{ model: "claude-opus-5", provider: "google" }, "claude-opus-5"],
    [{ model: "gemini-3.8-flash", thinking: "minimal" }, "minimal"],
    [{ model: "claude-opus-5", provider: "unsupported-provider" }, "unsupported-provider"],
    [{ model: "gemini-flash-latest" }, "moving alias"],
    [{ model: "gemini-3-flash-preview" }, "preview model"],
  ])("rejects an unsupported target before reading setup or credentials: %j", async (target, diagnostic) => {
    await expect(runReadinessDoctor({
      repoRoot: "/nonexistent-doctor-repo", evalsRoot: "/nonexistent-doctor-setup", ...target,
    })).rejects.toThrow(diagnostic);
  });

  it("parses explicit provider selection and preserves recovery without target options", () => {
    expect(parseDoctorArgs(["--model", "claude-opus-5", "--provider", "anthropic"])).toEqual({
      mode: "doctor", model: "claude-opus-5", provider: "anthropic",
    });
    expect(parseDoctorArgs(["--run", "exact-run-id"])).toEqual({ mode: "recover", runId: "exact-run-id" });
    expect(() => parseDoctorArgs(["--model"])).toThrow("--model requires a value");
    expect(() => parseDoctorArgs(["--run", "exact-run-id", "--model", "claude-opus-5"])).toThrow("cannot be combined");
  });

  it("uses the measured network policy, verifies both ephemeral resources are gone, and preserves the image", async () => {
    const setup = await syntheticSetup("GEMINI_API_KEY=synthetic-google-doctor-key\n");
    const sandbox = createFakeSandbox();
    const createNetwork = vi.spyOn(sandbox, "createNetwork");
    const destroyResource = vi.spyOn(sandbox, "destroyResource");
    const inspectResource = vi.spyOn(sandbox, "inspectResource");
    const report = await runReadinessDoctor({ ...setup, sandbox });
    expect(report.checks.find((check) => check.id === "guest-readiness")).toMatchObject({ passed: true });
    expect(createNetwork).toHaveBeenCalledWith(expect.any(String), EVAL_NETWORK_POLICY);
    expect(destroyResource.mock.calls.map(([kind]) => kind)).toEqual(["guest", "network"]);
    expect(inspectResource.mock.calls.map(([kind]) => kind)).toEqual(["guest", "network"]);
    expect(sandbox.live).toEqual({ guests: [], networks: [] });
    expect(await sandbox.inspectResource("image", sandbox.created.images[0]!)).toBe("present");
  });

  it.each(["failed", "survived", "threw"] as const)("retains a recovery journal and fails readiness when network cleanup %s", async (fault) => {
    const setup = await syntheticSetup("GEMINI_API_KEY=synthetic-google-doctor-key\n");
    const fake = createFakeSandbox();
    const sandbox: Sandbox = {
      ...fake,
      async destroyResource(kind, name, signal) {
        if (kind !== "network") return fake.destroyResource(kind, name, signal);
        if (fault === "threw") throw new Error("synthetic network deletion error");
        return fault === "survived"
          ? { status: "destroyed", verified: true, failure: null }
          : { status: "failed", verified: false, failure: null };
      },
    };
    try {
      const report = await runReadinessDoctor({ ...setup, sandbox });
      const check = report.checks.find((entry) => entry.id === "guest-readiness");
      expect(report.ready).toBe(false);
      expect(check?.passed).toBe(false);
      expect(check?.detail).toContain("pnpm eval:recover --run ");
      expect(fake.live.guests).toEqual([]);
      expect(fake.live.networks).toHaveLength(1);
      const stateDir = join(setup.evalsRoot, ".state");
      const journals = await readdir(stateDir);
      expect(journals).toHaveLength(1);
      const runId = journals[0]!.replace(/\.journal\.jsonl$/, "");
      const entries = await readRunJournal(stateDir, runId);
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "network", name: fake.created.networks[0], action: "create", event: "intent" }),
        expect.objectContaining({ kind: "network", name: fake.created.networks[0], action: "destroy", event: "observed", status: "failed" }),
      ]));
      expect(check?.detail).toContain(runId);
    } finally {
      for (const name of fake.created.networks) await fake.destroyNetwork(name);
    }
  });

  it("journals creation intent and cleans a network when creation throws after allocating it", async () => {
    const setup = await syntheticSetup("GEMINI_API_KEY=synthetic-google-doctor-key\n");
    const fake = createFakeSandbox();
    const sandbox: Sandbox = {
      ...fake,
      async createNetwork(name, policy) {
        await fake.createNetwork(name, policy);
        throw new Error("synthetic interrupted network creation");
      },
    };
    const report = await runReadinessDoctor({ ...setup, sandbox });
    expect(report.checks.find((entry) => entry.id === "guest-readiness")).toMatchObject({ passed: false });
    expect(fake.created.networks).toHaveLength(1);
    expect(fake.live).toEqual({ guests: [], networks: [] });
  });
});
