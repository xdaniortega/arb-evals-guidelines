import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { formatDoctorReport, runReadinessDoctor } from "./doctor.ts";

describe("no-request readiness doctor", () => {
  it("runs readiness doctor and structurally guarantees 0 provider requests", async () => {
    const evalsRoot = `${process.cwd()}/evals`;
    const repoRoot = process.cwd();

    const report = await runReadinessDoctor({
      evalsRoot,
      repoRoot,
      skipGuestReadiness: true, // skip real guest startup for fast unit test
    });

    expect(report.providerRequests).toBe(0);
    expect(report.provider).toBe("google");
    expect(report.model).toBe("gemini-3.8-flash");

    // Check that all required checks are present
    const checkIds = report.checks.map((c) => c.id);
    expect(checkIds).toContain("platform");
    expect(checkIds).toContain("apple-container");
    expect(checkIds).toContain("image-pi-pinned");
    expect(checkIds).toContain("credential-present");
    expect(checkIds).toContain("model-compatibility");
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
    // `npm install -g @earendil-works/pi-coding-agent@0.85.0`, so adding npm's
    // `--save-exact` flag to the Containerfile made a correctly pinned image report
    // NOT READY and skipped guest readiness behind it.
    const containerfile = await readFile(`${process.cwd()}/evals/container/Containerfile`, "utf8");
    expect(containerfile).toMatch(/npm install -g[^\n]*@earendil-works\/pi-coding-agent@0\.85\.0/);

    const report = await runReadinessDoctor({
      evalsRoot: `${process.cwd()}/evals`,
      repoRoot: process.cwd(),
      skipGuestReadiness: true,
    });
    const pinned = report.checks.find((check) => check.id === "image-pi-pinned");
    expect(pinned?.passed).toBe(true);
    expect(pinned?.detail).toContain("@earendil-works/pi-coding-agent@0.85.0 pinned");
  });
});
