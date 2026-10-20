/**
 * Synthetic tests for Runtime Profiles as Data (Item 3 & Compatibility Check 5).
 *
 * Requirements:
 * - Resolve profile identifiers from a supplied allowlisted profile catalog at the boundary
 * - No domain-name branch in core (no branching on "default", a suite name, or a language)
 * - Preserve case-over-suite profile selection
 * - Limit precedence: CLI > case > suite > profile > safe default
 * - Unknown or unavailable profiles fail BEFORE agent dispatch
 * - Both arms use the same selected inspected image and effective tooling/resources
 * - Test TWO synthetic profiles through injected catalog identities
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvalError, SAFE_DEFAULT_LIMITS } from "../core/types.ts";
import type { PartialLimits, RuntimeProfile } from "../core/types.ts";
import { resolveLimits } from "../core/experiment.ts";
import { freezeCase, loadFrozenCase } from "./case-loader.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  tempRoots.length = 0;
});

// Two synthetic profiles defined as pure data:
const SYNTHETIC_PROFILE_A: RuntimeProfile = {
  id: "synthetic-profile-a",
  description: "Synthetic runtime profile A with custom resource limits",
  limits: {
    wallClockMs: 90_000,
    cpus: 4,
    memoryMiB: 4096,
  },
};

const SYNTHETIC_PROFILE_B: RuntimeProfile = {
  id: "synthetic-profile-b",
  description: "Synthetic runtime profile B with lower memory",
  limits: {
    wallClockMs: 60_000,
    cpus: 1,
    memoryMiB: 1024,
    pids: 64,
  },
};

const INJECTED_CATALOG: Readonly<Record<string, RuntimeProfile>> = {
  default: {
    id: "default",
    description: "Default profile",
    limits: {},
  },
  "synthetic-profile-a": SYNTHETIC_PROFILE_A,
  "synthetic-profile-b": SYNTHETIC_PROFILE_B,
};

async function createSuiteWithProfiles(root: string, options: {
  suiteProfileId?: string;
  suiteLimits?: PartialLimits;
  caseProfileId?: string | null;
  caseLimits?: PartialLimits;
}): Promise<{ suiteId: string; caseSelector: string }> {
  const suiteId = "profile-suite";
  const caseSelector = "profile-case";
  const suiteDir = join(root, suiteId);
  const caseDir = join(suiteDir, "cases", caseSelector);
  await mkdir(join(caseDir, "fixture"), { recursive: true });

  await writeFile(
    join(suiteDir, "eval.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: suiteId,
      skillPath: "skills/test-skill",
      runtimeProfileId: options.suiteProfileId ?? "synthetic-profile-a",
      limits: options.suiteLimits ?? {},
    }),
  );

  await writeFile(
    join(caseDir, "case.json"),
    JSON.stringify({
      id: caseSelector,
      version: 1,
      prompt: "Solve in profile",
      outputPath: "out.json",
      allowedTools: ["read"],
      validator: "validator.ts",
      runtimeProfileId: options.caseProfileId === undefined ? null : options.caseProfileId,
      limits: options.caseLimits ?? {},
      fixtureDir: "fixture",
      oracle: "oracle.json",
    }),
  );

  await writeFile(join(caseDir, "fixture", "out.json"), "{}");
  await writeFile(join(caseDir, "oracle.json"), "{}");
  await writeFile(
    join(caseDir, "validator.ts"),
    "export function validateSnapshot() { return { status: 'graded', score: 1, fullPass: true, checks: [{ id: 'c', passed: true, message: 'ok' }] }; }",
  );

  return { suiteId, caseSelector };
}

describe("Runtime Profiles as Data — Resolution and Precedence", () => {
  it("resolves limits through data-injected profile catalog", () => {
    const resolvedA = resolveLimits({
      cli: {},
      caseLimits: {},
      suiteLimits: {},
      runtimeProfileId: "synthetic-profile-a",
      profileCatalog: INJECTED_CATALOG,
    });

    expect(resolvedA.limits.cpus).toBe(4);
    expect(resolvedA.limits.memoryMiB).toBe(4096);
    expect(resolvedA.limits.wallClockMs).toBe(90_000);
    expect(resolvedA.provenance.cpus).toBe("profile");
    expect(resolvedA.provenance.memoryMiB).toBe("profile");
    expect(resolvedA.provenance.wallClockMs).toBe("profile");
    // Unspecified limits in profile fall back to safe default
    expect(resolvedA.limits.pids).toBe(SAFE_DEFAULT_LIMITS.pids);
    expect(resolvedA.provenance.pids).toBe("default");

    const resolvedB = resolveLimits({
      cli: {},
      caseLimits: {},
      suiteLimits: {},
      runtimeProfileId: "synthetic-profile-b",
      profileCatalog: INJECTED_CATALOG,
    });

    expect(resolvedB.limits.cpus).toBe(1);
    expect(resolvedB.limits.memoryMiB).toBe(1024);
    expect(resolvedB.limits.pids).toBe(64);
    expect(resolvedB.provenance.pids).toBe("profile");
  });

  it("enforces strict limit precedence: CLI > case > suite > profile > default", () => {
    const resolved = resolveLimits({
      cli: {
        wallClockMs: 12_345, // CLI wins over all
      },
      caseLimits: {
        cpus: 8, // Case wins over suite and profile
        memoryMiB: 8192,
      },
      suiteLimits: {
        cpus: 6, // Suite wins over profile
        pids: 512, // Suite wins over default
      },
      runtimeProfileId: "synthetic-profile-a", // Profile has wallClockMs=90000, cpus=4, memoryMiB=4096
      profileCatalog: INJECTED_CATALOG,
    });

    // 1. CLI wins
    expect(resolved.limits.wallClockMs).toBe(12_345);
    expect(resolved.provenance.wallClockMs).toBe("cli");

    // 2. Case wins over suite & profile
    expect(resolved.limits.cpus).toBe(8);
    expect(resolved.provenance.cpus).toBe("case");
    expect(resolved.limits.memoryMiB).toBe(8192);
    expect(resolved.provenance.memoryMiB).toBe("case");

    // 3. Suite wins over default
    expect(resolved.limits.pids).toBe(512);
    expect(resolved.provenance.pids).toBe("suite");

    // 4. Safe default when nothing above specifies
    expect(resolved.limits.diskMiB).toBe(SAFE_DEFAULT_LIMITS.diskMiB);
    expect(resolved.provenance.diskMiB).toBe("default");
  });

  it("fails when an unknown runtime profile is requested", () => {
    expect(() =>
      resolveLimits({
        cli: {},
        caseLimits: {},
        suiteLimits: {},
        runtimeProfileId: "nonexistent-profile-xyz",
        profileCatalog: INJECTED_CATALOG,
      }),
    ).toThrow(EvalError);
  });

  it("prefers case-specified profile over suite profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-profile-override-"));
    tempRoots.push(root);

    // Suite has synthetic-profile-a, case overrides to synthetic-profile-b
    const { suiteId, caseSelector } = await createSuiteWithProfiles(root, {
      suiteProfileId: "synthetic-profile-a",
      caseProfileId: "synthetic-profile-b",
    });

    const frozen = await loadFrozenCase({ evalsRoot: root, suiteId, caseSelector, profileCatalog: INJECTED_CATALOG });
    expect(frozen.runtimeProfileId).toBe("synthetic-profile-b");

    const resolved = resolveLimits({
      cli: {},
      caseLimits: frozen.config.limits,
      suiteLimits: frozen.suite.limits,
      runtimeProfileId: frozen.runtimeProfileId,
      profileCatalog: INJECTED_CATALOG,
    });

    // synthetic-profile-b has pids=64
    expect(resolved.limits.pids).toBe(64);
    expect(resolved.provenance.pids).toBe("profile");
  });

  it("falls back to suite profile when case does not specify one", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-profile-fallback-"));
    tempRoots.push(root);

    const { suiteId, caseSelector } = await createSuiteWithProfiles(root, {
      suiteProfileId: "synthetic-profile-a",
      caseProfileId: null, // no override in case
    });

    const frozen = await loadFrozenCase({ evalsRoot: root, suiteId, caseSelector, profileCatalog: INJECTED_CATALOG });
    expect(frozen.runtimeProfileId).toBe("synthetic-profile-a");

    const resolved = resolveLimits({
      cli: {},
      caseLimits: frozen.config.limits,
      suiteLimits: frozen.suite.limits,
      runtimeProfileId: frozen.runtimeProfileId,
      profileCatalog: INJECTED_CATALOG,
    });

    // synthetic-profile-a has cpus=4
    expect(resolved.limits.cpus).toBe(4);
    expect(resolved.provenance.cpus).toBe("profile");
  });
});
