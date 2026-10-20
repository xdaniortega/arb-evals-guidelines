/**
 * Offline preflight composition.
 *
 * `eval:validate` is only as good as this: it must actually freeze every case, resolve
 * every limit, report a failure per case rather than aborting the whole sweep, and
 * never print file contents.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SAFE_DEFAULT_LIMITS, SCHEMA_VERSION } from "../core/types.ts";
import { formatPreflightReport, preflightInputs } from "./preflight.ts";

const created: string[] = [];

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eval-preflight-"));
  created.push(dir);
  return dir;
}

async function buildSuite(
  root: string,
  suiteId: string,
  options: {
    selector?: string;
    caseId?: string;
    caseOverrides?: Record<string, unknown>;
    suiteOverrides?: Record<string, unknown>;
    fixtureText?: string;
  } = {},
): Promise<void> {
  const selector = options.selector ?? "group/case-a";
  const suiteDir = join(root, suiteId);
  const caseDir = join(suiteDir, "cases", ...selector.split("/"));
  await mkdir(join(caseDir, "fixture"), { recursive: true });
  await writeFile(
    join(suiteDir, "eval.json"),
    JSON.stringify({ schemaVersion: SCHEMA_VERSION, id: suiteId, skillPath: "skills/example", ...options.suiteOverrides }),
    "utf8",
  );
  await writeFile(
    join(caseDir, "case.json"),
    JSON.stringify({
      id: options.caseId ?? "case-a",
      version: 1,
      prompt: "p",
      outputPath: "config.json",
      allowedTools: ["read"],
      validator: "validator.ts",
      ...options.caseOverrides,
    }),
    "utf8",
  );
  await writeFile(join(caseDir, "oracle.json"), JSON.stringify({ ok: true }), "utf8");
  await writeFile(join(caseDir, "validator.ts"), "export function validateSnapshot() { return null; }\n", "utf8");
  await writeFile(join(caseDir, "fixture", "config.json"), options.fixtureText ?? '{"secretish":"value"}', "utf8");
}

describe("preflightInputs", () => {
  it("passes a well-formed suite and reports frozen hashes", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1");
    const report = await preflightInputs({ evalsRoot: root, suiteId: null, caseSelector: null, cliLimits: {} });
    expect(report.ok).toBe(true);
    expect(report.cases).toHaveLength(1);
    const result = report.cases[0]!;
    expect(result.fixtureFileCount).toBe(1);
    expect(result.promptSha256).toHaveLength(64);
    expect(result.limits).toEqual(SAFE_DEFAULT_LIMITS);
    expect(result.limitProvenance?.cpus).toBe("default");
  });

  it("applies CLI limit overrides above every other layer", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1", { caseOverrides: { limits: { cpus: 3 } }, suiteOverrides: { limits: { cpus: 4 } } });
    const report = await preflightInputs({ evalsRoot: root, suiteId: null, caseSelector: null, cliLimits: { cpus: 1 } });
    expect(report.cases[0]?.limits?.cpus).toBe(1);
    expect(report.cases[0]?.limitProvenance?.cpus).toBe("cli");
  });

  it("narrows by suite and by case selector", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1", { selector: "group/case-a", caseId: "case-a" });
    await buildSuite(root, "s1", { selector: "group/case-b", caseId: "case-b" });
    await buildSuite(root, "s2");
    const bySuite = await preflightInputs({ evalsRoot: root, suiteId: "s1", caseSelector: null, cliLimits: {} });
    expect(bySuite.suiteIds).toEqual(["s1"]);
    expect(bySuite.cases).toHaveLength(2);
    const byCase = await preflightInputs({ evalsRoot: root, suiteId: "s1", caseSelector: "case-b", cliLimits: {} });
    expect(byCase.cases.map((entry) => entry.selector)).toEqual(["group/case-b"]);
  });

  it("fails when the requested suite does not exist", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1");
    const report = await preflightInputs({ evalsRoot: root, suiteId: "nope", caseSelector: null, cliLimits: {} });
    expect(report.ok).toBe(false);
    expect(report.failure?.at).toBe("--suite");
  });

  it("fails when no suite exists at all", async () => {
    const report = await preflightInputs({
      evalsRoot: await tempRoot(),
      suiteId: null,
      caseSelector: null,
      cliLimits: {},
    });
    expect(report.ok).toBe(false);
    expect(report.failure?.code).toBe("input-invalid");
  });

  it("records a per-case failure without aborting the sweep", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1", { selector: "group/good", caseId: "good" });
    // Absent output is valid; use an unreadable validator to test preflight failure.
    await buildSuite(root, "s1", { selector: "group/bad", caseId: "bad", caseOverrides: { validator: "missing-validator.ts" } });
    const report = await preflightInputs({ evalsRoot: root, suiteId: "s1", caseSelector: null, cliLimits: {} });
    expect(report.ok).toBe(false);
    expect(report.cases.filter((entry) => entry.ok)).toHaveLength(1);
    expect(report.cases.find((entry) => !entry.ok)?.failure?.code).toBe("input-invalid");
  });

  it("reports an ambiguous case selector as a suite-scoped failure", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1", { selector: "alpha/leaf", caseId: "one" });
    await buildSuite(root, "s1", { selector: "beta/leaf", caseId: "two" });
    const report = await preflightInputs({ evalsRoot: root, suiteId: "s1", caseSelector: "leaf", cliLimits: {} });
    expect(report.ok).toBe(false);
    expect(report.cases[0]?.failure?.code).toBe("selector-ambiguous");
  });

  it("reports an invalid limit as a failure rather than throwing", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1", { caseOverrides: { limits: { cpus: 0 } } });
    const report = await preflightInputs({ evalsRoot: root, suiteId: null, caseSelector: null, cliLimits: {} });
    expect(report.ok).toBe(false);
  });
});

describe("formatPreflightReport", () => {
  it("prints a compact pass line with short hash prefixes and no file content", async () => {
    const root = await tempRoot();
    await buildSuite(root, "s1", { fixtureText: '{"do-not-print":"TOPSECRETFIXTUREVALUE"}' });
    const report = await preflightInputs({ evalsRoot: root, suiteId: null, caseSelector: null, cliLimits: {} });
    const text = formatPreflightReport(report);
    expect(text).toContain("PASS s1/group/case-a");
    expect(text).toContain("profile=default");
    expect(text).toContain("fixtureFiles=1");
    expect(text).toContain("1 case(s) checked, 0 failed");
    expect(text).not.toContain("TOPSECRETFIXTUREVALUE");
    expect(text).not.toContain(report.cases[0]!.promptSha256);
  });

  it("prints the structured code, message, and location on failure", async () => {
    const root = await tempRoot();
    // Absent output is valid; use an unreadable validator to test preflight failure.
    await buildSuite(root, "s1", { caseOverrides: { validator: "missing-validator.ts" } });
    const report = await preflightInputs({ evalsRoot: root, suiteId: null, caseSelector: null, cliLimits: {} });
    const text = formatPreflightReport(report);
    expect(text).toContain("FAIL s1/group/case-a");
    expect(text).toContain("[input-invalid]");
    expect(text).toContain("1 case(s) checked, 1 failed");
  });

  it("prints a top-level failure when discovery itself failed", () => {
    const text = formatPreflightReport({
      ok: false,
      suiteIds: [],
      cases: [],
      failure: { code: "input-invalid", failureClass: "infrastructure", message: "boom", at: "--suite" },
    });
    expect(text).toBe("FAIL [input-invalid] at --suite: boom");
  });
});
