/**
 * Synthetic tests for Trusted Preparation (Item 2).
 *
 * Requirements:
 * - Local synthetic preparer runs exactly ONCE across both arms and multiple repetitions (proven by atomic counter)
 * - Returns bounded fixture/oracle bytes plus credential-free provenance
 * - Failure or cancellation produces ZERO agent dispatches
 * - Checked-in case files remain completely untouched
 * - Oracle, helper code, and hidden provenance never enter agent guests
 * - Reports and verification use retained bytes and NEVER re-invoke the preparer
 */

import { execFileSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalError } from "../core/types.ts";
import type { CasePreparer, PreparedCaseData, PartialLimits } from "../core/types.ts";
import { createFakeHarness } from "../harnesses/fake.ts";
import { createFakeSandbox } from "../sandboxes/fake.ts";
import { buildAllowlistedEnv } from "../test-guards.ts";
import { createInProcessValidatorRunner } from "./validation.ts";
import { executeTrustedPreparer, runPairedEvaluation } from "./run.ts";
import type { RunPairedEvaluationOptions, RunProgressEvent } from "./run.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  tempRoots.length = 0;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function setupSuite(root: string, limits: { case?: PartialLimits; suite?: PartialLimits } = {}): Promise<{ evalsRoot: string; repoRoot: string; suiteId: string; caseSelector: string }> {
  const evalsRoot = join(root, "evals");
  const repoRoot = root;
  const suiteId = "prep-suite";
  const caseSelector = "prep-case";

  const caseDir = join(evalsRoot, suiteId, "cases", caseSelector);
  await mkdir(join(caseDir, "fixture"), { recursive: true });

  await writeFile(
    join(evalsRoot, suiteId, "eval.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: suiteId,
      skillPath: "skills/test-skill",
      runtimeProfileId: "default",
      limits: limits.suite ?? {},
    }),
  );

  await writeFile(
    join(caseDir, "case.json"),
    JSON.stringify({
      id: caseSelector,
      version: 1,
      prompt: "Solve the prepared puzzle",
      outputPath: "answer.txt",
      allowedTools: ["read", "write"],
      validator: "validator.ts",
      runtimeProfileId: null,
      limits: limits.case ?? {},
      fixtureDir: "fixture",
      oracle: "oracle.json",
    }),
  );

  // Checked-in fixture and oracle on disk
  await writeFile(join(caseDir, "fixture", "checked-in.txt"), "original-checked-in-fixture");
  await writeFile(join(caseDir, "oracle.json"), JSON.stringify({ secretOracleData: "checked-in-oracle" }));
  await writeFile(
    join(caseDir, "validator.ts"),
    "export function validateSnapshot() { return { status: 'graded', score: 1.0, fullPass: true, checks: [{ id: 'prep-check', passed: true, message: 'ok' }] }; }",
  );

  // Skill directory
  const skillDir = join(repoRoot, "skills", "test-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "# Skill for preparation");

  return { evalsRoot, repoRoot, suiteId, caseSelector };
}

async function preparationRun(limits: { case?: PartialLimits; suite?: PartialLimits } = {}) {
  const root = await mkdtemp(join(tmpdir(), "eval-prep-controlled-"));
  tempRoots.push(root);
  const suite = await setupSuite(root, limits);
  const harness = createFakeHarness();
  const sandbox = createFakeSandbox();
  const dispatch = vi.spyOn(harness, "run");
  const createGuest = vi.spyOn(sandbox, "createGuest");
  const events: RunProgressEvent[] = [];
  const options: RunPairedEvaluationOptions = {
    ...suite,
    mode: "fake",
    repetitions: 1,
    cliLimits: {},
    target: { provider: "google", model: "fake-model", thinking: "off" },
    runId: "19700101T000000Z-prep-controlled",
    resourceNonce: "0a1b2c3d",
    createdAt: "1970-01-01T00:00:00.000Z",
    source: { revision: "fake-rev", dirty: false },
    evaluatorBuild: "eval-build-test",
    harness,
    sandbox,
    validatorRunner: createInProcessValidatorRunner(),
    workDir: join(root, "work"),
    onProgress: (event) => events.push(event),
  };
  return {
    options,
    events,
    async expectNoDispatch() {
      expect(dispatch).not.toHaveBeenCalled();
      expect(createGuest).not.toHaveBeenCalled();
      expect(events.map((event) => event.type)).not.toContain("preparation-completed");
      expect(events.map((event) => event.type)).not.toContain("freeze-started");
      await expect(stat(options.workDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(suite.evalsRoot, suite.suiteId, "runs", options.runId))).rejects.toMatchObject({ code: "ENOENT" });
    },
  };
}

describe("Trusted Preparation (once-per-invocation, zero dispatches on failure, immutable checked-in files)", () => {
  it("runs exactly once for an entire run across both arms and multiple repetitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-prep-once-"));
    tempRoots.push(root);
    const suiteInfo = await setupSuite(root);

    let preparationCalls = 0;
    const preparer: CasePreparer = async (context) => {
      preparationCalls += 1;
      return {
        fixtureFiles: [
          { path: "prepared-data.json", content: JSON.stringify({ round: 42, challenge: "abc" }) },
        ],
        oracle: { answer: "xyz", hiddenKey: "supersecret" },
        provenance: { source: "synthetic-oracle-source", timestamp: "1970-01-01T00:00:00Z" },
      };
    };

    let agentDispatches = 0;
    const baseHarness = createFakeHarness();
    const fakeHarness = {
      ...baseHarness,
      async run(guest: any, req: any) {
        agentDispatches += 1;
        return baseHarness.run(guest, req);
      },
    };

    const sandbox = createFakeSandbox();
    const validatorRunner = createInProcessValidatorRunner();
    const workDir = join(root, "work");

    const runOptions: RunPairedEvaluationOptions = {
      evalsRoot: suiteInfo.evalsRoot,
      repoRoot: suiteInfo.repoRoot,
      suiteId: suiteInfo.suiteId,
      caseSelector: suiteInfo.caseSelector,
      mode: "fake",
      repetitions: 2, // 2 repetitions = 4 arms total!
      cliLimits: {},
      target: { provider: "google", model: "fake-model", thinking: "off" },
      runId: "19700101T000000Z-prep0001",
      resourceNonce: "0a1b2c3d",
      createdAt: "1970-01-01T00:00:00.000Z",
      source: { revision: "fake-rev", dirty: false },
      evaluatorBuild: "eval-build-test",
      harness: fakeHarness,
      sandbox,
      validatorRunner,
      workDir,
      preparer,
    };

    const result = await runPairedEvaluation(runOptions);

    // Preparer MUST run exactly once! (Not once per repetition or once per arm)
    expect(preparationCalls).toBe(1);
    // 2 repetitions * 2 conditions (baseline + treatment) = 4 agent dispatches
    expect(agentDispatches).toBe(4);
    expect(result.status).toBe("complete");

    // Checked-in fixture and oracle on disk must remain COMPLETELY UNTOUCHED!
    const caseDir = join(suiteInfo.evalsRoot, suiteInfo.suiteId, "cases", suiteInfo.caseSelector);
    const checkedInFixture = await readFile(join(caseDir, "fixture", "checked-in.txt"), "utf8");
    expect(checkedInFixture).toBe("original-checked-in-fixture");
    const checkedInOracle = await readFile(join(caseDir, "oracle.json"), "utf8");
    expect(JSON.parse(checkedInOracle)).toEqual({ secretOracleData: "checked-in-oracle" });

    // The prepared file was NOT written to the checked-in directory
    await expect(readFile(join(caseDir, "fixture", "prepared-data.json"))).rejects.toThrow();
  });

  it("produces ZERO agent dispatches when preparation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-prep-fail-"));
    tempRoots.push(root);
    const suiteInfo = await setupSuite(root);

    let preparationCalls = 0;
    const failingPreparer: CasePreparer = async () => {
      preparationCalls += 1;
      throw new Error("Simulated preparation network timeout");
    };

    let agentDispatches = 0;
    const baseHarness = createFakeHarness();
    const fakeHarness = {
      ...baseHarness,
      async run(guest: any, req: any) {
        agentDispatches += 1;
        return baseHarness.run(guest, req);
      },
    };

    const sandbox = createFakeSandbox();
    const validatorRunner = createInProcessValidatorRunner();
    const workDir = join(root, "work");

    const runOptions: RunPairedEvaluationOptions = {
      evalsRoot: suiteInfo.evalsRoot,
      repoRoot: suiteInfo.repoRoot,
      suiteId: suiteInfo.suiteId,
      caseSelector: suiteInfo.caseSelector,
      mode: "fake",
      repetitions: 1,
      cliLimits: {},
      target: { provider: "google", model: "fake-model", thinking: "off" },
      runId: "19700101T000000Z-prep0002",
      resourceNonce: "0a1b2c3d",
      createdAt: "1970-01-01T00:00:00.000Z",
      source: { revision: "fake-rev", dirty: false },
      evaluatorBuild: "eval-build-test",
      harness: fakeHarness,
      sandbox,
      validatorRunner,
      workDir,
      preparer: failingPreparer,
    };

    await expect(runPairedEvaluation(runOptions)).rejects.toThrow(EvalError);

    // Preparer ran once and failed
    expect(preparationCalls).toBe(1);
    // CRUCIAL: Exactly ZERO agent dispatches occurred!
    expect(agentDispatches).toBe(0);
  });

  it("produces ZERO agent dispatches when preparation is aborted", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-prep-abort-"));
    tempRoots.push(root);
    const suiteInfo = await setupSuite(root);

    const controller = new AbortController();
    controller.abort(new Error("Caller aborted before preparation completed"));

    let agentDispatches = 0;
    const baseHarness = createFakeHarness();
    const fakeHarness = {
      ...baseHarness,
      async run(guest: any, req: any) {
        agentDispatches += 1;
        return baseHarness.run(guest, req);
      },
    };

    const preparer: CasePreparer = async ({ signal }) => {
      if (signal?.aborted) {
        throw new EvalError("interrupted", "preparation was aborted");
      }
      return {};
    };

    const sandbox = createFakeSandbox();
    const validatorRunner = createInProcessValidatorRunner();
    const workDir = join(root, "work");

    const runOptions: RunPairedEvaluationOptions = {
      evalsRoot: suiteInfo.evalsRoot,
      repoRoot: suiteInfo.repoRoot,
      suiteId: suiteInfo.suiteId,
      caseSelector: suiteInfo.caseSelector,
      mode: "fake",
      repetitions: 1,
      cliLimits: {},
      target: { provider: "google", model: "fake-model", thinking: "off" },
      runId: "19700101T000000Z-prep0003",
      resourceNonce: "0a1b2c3d",
      createdAt: "1970-01-01T00:00:00.000Z",
      source: { revision: "fake-rev", dirty: false },
      evaluatorBuild: "eval-build-test",
      harness: fakeHarness,
      sandbox,
      validatorRunner,
      workDir,
      preparer,
      signal: controller.signal,
    };

    await expect(runPairedEvaluation(runOptions)).rejects.toThrow();
    expect(agentDispatches).toBe(0);
  });

  it("keeps oracle, helper code, and hidden provenance out of agent guests", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-prep-guest-"));
    tempRoots.push(root);
    const suiteInfo = await setupSuite(root);

    const preparer: CasePreparer = async () => ({
      fixtureFiles: [
        { path: "public-input.txt", content: "visible to guest" },
      ],
      oracle: { topSecretKey: "classified-oracle-value" },
      provenance: { credentialFreeSource: "https://synthetic.source.example" },
    });

    let inspectedFiles: string[] = [];
    const baseHarness = createFakeHarness();
    const fakeHarness = {
      ...baseHarness,
      async run(guest: any, req: any) {
        const exported = await guest.exportFiles({ root: "/work" });
        inspectedFiles = exported.files.map((f: any) => f.path);
        return baseHarness.run(guest, req);
      },
    };

    const sandbox = createFakeSandbox();
    const validatorRunner = createInProcessValidatorRunner();
    const workDir = join(root, "work");

    const runOptions: RunPairedEvaluationOptions = {
      evalsRoot: suiteInfo.evalsRoot,
      repoRoot: suiteInfo.repoRoot,
      suiteId: suiteInfo.suiteId,
      caseSelector: suiteInfo.caseSelector,
      mode: "fake",
      repetitions: 1,
      cliLimits: {},
      target: { provider: "google", model: "fake-model", thinking: "off" },
      runId: "19700101T000000Z-prep0004",
      resourceNonce: "0a1b2c3d",
      createdAt: "1970-01-01T00:00:00.000Z",
      source: { revision: "fake-rev", dirty: false },
      evaluatorBuild: "eval-build-test",
      harness: fakeHarness,
      sandbox,
      validatorRunner,
      workDir,
      preparer,
    };

    await runPairedEvaluation(runOptions);

    // Staged guest root should contain public-input.txt, NOT oracle.json or provenance
    expect(inspectedFiles).toContain("public-input.txt");
    expect(inspectedFiles.some((f) => f.includes("oracle"))).toBe(false);
    expect(inspectedFiles.some((f) => f.includes("provenance"))).toBe(false);
  });

  it("never settling preparer times out, aborts its composed signal and dispatches zero agents", async () => {
    const run = await preparationRun();
    const started = deferred<Parameters<CasePreparer>[0]>();
    const controller = new AbortController();
    const preparer = vi.fn<CasePreparer>((context) => {
      started.resolve(context);
      return new Promise(() => {});
    });
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const result = runPairedEvaluation({ ...run.options, cliLimits: { wallClockMs: null }, operationAllowanceMs: 60, preparer, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ code: "interrupted", message: expect.stringContaining("exceeded deadline") });
    const context = await started.promise;
    expect(preparer).toHaveBeenCalledTimes(1);
    expect(context.deadlineAtMs).toBe(1_060);
    expect(context.signal).not.toBe(controller.signal);
    expect(context.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60);
    await rejected;
    expect(context.signal.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(context.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await run.expectNoDispatch();
  });

  it("pre-aborted signal throws interrupted EvalError with ZERO preparer invocations and zero agent dispatches", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-prep-preabort-"));
    tempRoots.push(root);
    const suiteInfo = await setupSuite(root);

    const controller = new AbortController();
    controller.abort(new Error("caller pre-aborted before run"));

    let preparerInvocations = 0;
    const preparer: CasePreparer = async () => {
      preparerInvocations += 1;
      return {};
    };

    let agentDispatches = 0;
    const baseHarness = createFakeHarness();
    const fakeHarness = {
      ...baseHarness,
      async run(guest: any, req: any) {
        agentDispatches += 1;
        return baseHarness.run(guest, req);
      },
    };

    const sandbox = createFakeSandbox();
    const validatorRunner = createInProcessValidatorRunner();
    const workDir = join(root, "work");

    const runOptions: RunPairedEvaluationOptions = {
      evalsRoot: suiteInfo.evalsRoot,
      repoRoot: suiteInfo.repoRoot,
      suiteId: suiteInfo.suiteId,
      caseSelector: suiteInfo.caseSelector,
      mode: "fake",
      repetitions: 1,
      cliLimits: {},
      target: { provider: "google", model: "fake-model", thinking: "off" },
      runId: "19700101T000000Z-prep-preabort",
      resourceNonce: "0a1b2c3d",
      createdAt: "1970-01-01T00:00:00.000Z",
      source: { revision: "fake-rev", dirty: false },
      evaluatorBuild: "eval-build-test",
      harness: fakeHarness,
      sandbox,
      validatorRunner,
      workDir,
      preparer,
      signal: controller.signal,
    };

    let caughtError: unknown;
    try {
      await runPairedEvaluation(runOptions);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(EvalError);
    expect((caughtError as EvalError).code).toBe("interrupted");
    expect((caughtError as EvalError).message).toContain("trusted preparation was cancelled before starting");
    expect(preparerInvocations).toBe(0);
    expect(agentDispatches).toBe(0);
  });

  it("ignored-signal external abort interrupts in-flight preparation and prevents late dispatch", async () => {
    const run = await preparationRun();
    const started = deferred<Parameters<CasePreparer>[0]>();
    const late = deferred<PreparedCaseData>();
    const controller = new AbortController();
    vi.useFakeTimers();
    const preparer = vi.fn<CasePreparer>((context) => { started.resolve(context); return late.promise; });
    const result = runPairedEvaluation({ ...run.options, preparer, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ code: "interrupted" });
    const context = await started.promise;
    const reason = new EvalError("interrupted", "caller aborted mid-flight");
    controller.abort(reason);
    await rejected;
    expect(preparer).toHaveBeenCalledTimes(1);
    expect(context.signal.reason).toBe(reason);
    late.resolve({ fixtureFiles: [{ path: "late.txt", content: "late" }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(context.signal, "abort")).toHaveLength(0);
    await run.expectNoDispatch();
  });

  it.each(["resolve", "reject"] as const)("timeout absorbs late %s without dispatch or unhandledRejection", async (settlement) => {
    const run = await preparationRun();
    const started = deferred<Parameters<CasePreparer>[0]>();
    const late = deferred<PreparedCaseData>();
    const preparer = vi.fn<CasePreparer>((context) => { started.resolve(context); return late.promise; });
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    vi.useFakeTimers();
    try {
      const result = runPairedEvaluation({ ...run.options, cliLimits: { wallClockMs: null }, operationAllowanceMs: 40, preparer });
      const rejected = expect(result).rejects.toMatchObject({ code: "interrupted" });
      const context = await started.promise;
      expect(preparer).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(40);
      await rejected;
      expect(context.signal.aborted).toBe(true);
      if (settlement === "resolve") late.resolve({ fixtureFiles: [{ path: "late.txt", content: "late" }] });
      else late.reject(new Error("late failure after timeout"));
      // Yield an event-loop turn so an unhandled rejection would actually be observed.
      await vi.advanceTimersByTimeAsync(0);
      expect(onUnhandled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      await run.expectNoDispatch();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it.each(["sync", "microtask", "rejection"] as const)("rejects late %s settlement before the timer can execute", async (work) => {
    const run = await preparationRun();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let signal: AbortSignal | undefined;
    const preparer = vi.fn<CasePreparer>(async (context) => {
      signal = context.signal;
      if (work === "microtask") await Promise.resolve();
      // Models finite event-loop-blocking work: moves the clock WITHOUT running timers.
      vi.setSystemTime(context.deadlineAtMs);
      expect(context.signal.aborted).toBe(false);
      if (work === "rejection") throw new Error("late preparer failure");
      return {};
    });
    await expect(runPairedEvaluation({ ...run.options, cliLimits: { wallClockMs: null }, operationAllowanceMs: 60, preparer })).rejects.toMatchObject({ code: "interrupted" });
    expect(preparer).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await run.expectNoDispatch();
  });

  it.each(["abort", "deadline"] as const)("rechecks %s immediately before callback invocation", async (reason) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const controller = new AbortController();
    const preparer = vi.fn<CasePreparer>(async () => ({}));
    const result = executeTrustedPreparer({ preparer, suiteId: "s", caseSelector: "c", deadlineAtMs: 1_060, signal: controller.signal });
    // Between helper entry and its queued callback, no timers have fired.
    if (reason === "abort") controller.abort(new Error("cancel before callback"));
    else vi.setSystemTime(1_060);
    await expect(result).rejects.toMatchObject({ code: "interrupted" });
    expect(preparer).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("does not start a preparer when preflight consumed the startup deadline", async () => {
    const run = await preparationRun({ case: { wallClockMs: 60 } });
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const preparer = vi.fn<CasePreparer>(async () => ({}));
    const result = runPairedEvaluation({
      ...run.options,
      invocationStartedAtMs: 1_000,
      startupAllowanceMs: 29_000,
      preparer,
      onProgress(event) {
        run.events.push(event);
        if (event.type === "request-validated") vi.setSystemTime(30_000);
      },
    });
    await expect(result).rejects.toMatchObject({ code: "interrupted" });
    expect(preparer).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await run.expectNoDispatch();
  });

  it.each([
    { name: "cli", cli: 100, case: 200, suite: 300, profile: 400 },
    { name: "case", case: 200, suite: 300, profile: 400 },
    { name: "suite", suite: 300, profile: 400 },
    { name: "profile", profile: 400 },
    { name: "default" },
    { name: "unlimited", cli: null },
    { name: "long finite", cli: 2_147_483_648 },
  ])("preparation uses its infrastructure allowance independently of the $name arm time limit", async (row) => {
    const limits = (wallClockMs?: number | null): PartialLimits => wallClockMs === undefined ? {} : { wallClockMs };
    const run = await preparationRun({ case: limits(row.case), suite: limits(row.suite) });
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const stop = new EvalError("interrupted", "stop after observing preparation deadline");
    const preparer = vi.fn<CasePreparer>(async (context) => {
      expect(context.deadlineAtMs).toBe(1_010 + 5_000);
      throw stop;
    });
    await expect(runPairedEvaluation({
      ...run.options,
      operationAllowanceMs: 5_000,
      cliLimits: limits(row.cli),
      profileCatalog: { default: { id: "default", description: "Synthetic defaults", limits: limits(row.profile) } },
      preparer,
      onProgress(event) {
        run.events.push(event);
        if (event.type === "request-validated") vi.setSystemTime(1_010);
      },
    })).rejects.toBe(stop);
    expect(preparer).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await run.expectNoDispatch();
  });

  it("clamps preparation to the remaining startup allowance after preflight", async () => {
    const run = await preparationRun();
    const started = deferred<Parameters<CasePreparer>[0]>();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const preparer = vi.fn<CasePreparer>((context) => {
      started.resolve(context);
      return new Promise(() => {});
    });
    const result = runPairedEvaluation({
      ...run.options,
      cliLimits: { wallClockMs: null },
      invocationStartedAtMs: 1_000,
      startupAllowanceMs: 80,
      operationAllowanceMs: 60,
      preparer,
      onProgress(event) {
        run.events.push(event);
        if (event.type === "request-validated") vi.setSystemTime(1_050);
      },
    });
    const rejected = expect(result).rejects.toMatchObject({ code: "interrupted" });
    const context = await started.promise;
    expect(context.deadlineAtMs).toBe(1_080);
    await vi.advanceTimersByTimeAsync(29);
    expect(context.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(context.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await run.expectNoDispatch();
  });

  it("success passes absolute deadlineAtMs and emits preparation facts in order, omitting completed on failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-prep-progress-"));
    tempRoots.push(root);
    const suiteInfo = await setupSuite(root);

    let recordedDeadlineAtMs = 0;
    let recordedPreparationAtMs = 0;
    let recordedSignal: AbortSignal | null = null;
    const eventsSuccess: RunProgressEvent[] = [];

    const startBeforeRun = Date.now();
    const preparerSuccess: CasePreparer = async (context) => {
      recordedPreparationAtMs = Date.now();
      recordedDeadlineAtMs = context.deadlineAtMs;
      recordedSignal = context.signal;
      return {
        fixtureFiles: [{ path: "answer.txt", content: "ok" }],
      };
    };

    const sandbox = createFakeSandbox();
    const validatorRunner = createInProcessValidatorRunner();
    const workDir = join(root, "work");

    const runOptionsSuccess: RunPairedEvaluationOptions = {
      evalsRoot: suiteInfo.evalsRoot,
      repoRoot: suiteInfo.repoRoot,
      suiteId: suiteInfo.suiteId,
      caseSelector: suiteInfo.caseSelector,
      mode: "fake",
      repetitions: 1,
      cliLimits: { wallClockMs: 25_000 },
      operationAllowanceMs: 5_000,
      target: { provider: "google", model: "fake-model", thinking: "off" },
      runId: "19700101T000000Z-prep-order",
      resourceNonce: "0a1b2c3d",
      createdAt: "1970-01-01T00:00:00.000Z",
      source: { revision: "fake-rev", dirty: false },
      evaluatorBuild: "eval-build-test",
      harness: createFakeHarness(),
      sandbox,
      validatorRunner,
      workDir,
      preparer: preparerSuccess,
      onProgress: (evt) => eventsSuccess.push(evt),
    };

    const result = await runPairedEvaluation(runOptionsSuccess);
    expect(result.status).toBe("complete");

    // Preparation gets its own infrastructure allowance, not the longer arm budget.
    expect(recordedSignal).not.toBeNull();
    expect(recordedSignal!.aborted).toBe(false);
    expect(typeof recordedDeadlineAtMs).toBe("number");
    expect(recordedDeadlineAtMs).toBeGreaterThanOrEqual(startBeforeRun + 5_000);
    expect(recordedDeadlineAtMs).toBeLessThanOrEqual(recordedPreparationAtMs + 5_000);

    // Progress fact order check:
    const typesSuccess = eventsSuccess.map((e) => e.type);
    const prepStartIdx = typesSuccess.indexOf("preparation-started");
    const prepCompIdx = typesSuccess.indexOf("preparation-completed");
    const reqValIdx = typesSuccess.indexOf("request-validated");
    const freezeStartIdx = typesSuccess.indexOf("freeze-started");

    expect(reqValIdx).toBeGreaterThanOrEqual(0);
    expect(prepStartIdx).toBeGreaterThan(reqValIdx);
    expect(prepCompIdx).toBeGreaterThan(prepStartIdx);
    expect(freezeStartIdx).toBeGreaterThan(prepCompIdx);

    // On failure: preparation-completed MUST NOT be emitted!
    const eventsFailure: RunProgressEvent[] = [];
    const preparerFailure: CasePreparer = async () => {
      throw new Error("prep crashed");
    };

    const runOptionsFailure: RunPairedEvaluationOptions = {
      ...runOptionsSuccess,
      runId: "19700101T000000Z-prep-order-fail",
      workDir: join(root, "work-fail"),
      preparer: preparerFailure,
      onProgress: (evt) => eventsFailure.push(evt),
    };

    await expect(runPairedEvaluation(runOptionsFailure)).rejects.toThrow(EvalError);
    const typesFailure = eventsFailure.map((e) => e.type);
    expect(typesFailure).toContain("preparation-started");
    expect(typesFailure).not.toContain("preparation-completed");
  });

  it("thrown error wrapping: preserves callback EvalError and wraps non-EvalError into input-invalid with cause", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-prep-wrapping-"));
    tempRoots.push(root);
    const suiteInfo = await setupSuite(root);

    const sandbox = createFakeSandbox();
    const validatorRunner = createInProcessValidatorRunner();

    // Case A: throws regular Error
    const rawError = new Error("raw network failure");
    const preparerA: CasePreparer = async () => {
      throw rawError;
    };

    const runOptionsA: RunPairedEvaluationOptions = {
      evalsRoot: suiteInfo.evalsRoot,
      repoRoot: suiteInfo.repoRoot,
      suiteId: suiteInfo.suiteId,
      caseSelector: suiteInfo.caseSelector,
      mode: "fake",
      repetitions: 1,
      cliLimits: {},
      target: { provider: "google", model: "fake-model", thinking: "off" },
      runId: "19700101T000000Z-prep-wrap-a",
      resourceNonce: "0a1b2c3d",
      createdAt: "1970-01-01T00:00:00.000Z",
      source: { revision: "fake-rev", dirty: false },
      evaluatorBuild: "eval-build-test",
      harness: createFakeHarness(),
      sandbox,
      validatorRunner,
      workDir: join(root, "work-a"),
      preparer: preparerA,
    };

    let caughtA: unknown;
    try {
      await runPairedEvaluation(runOptionsA);
    } catch (err) {
      caughtA = err;
    }
    expect(caughtA).toBeInstanceOf(EvalError);
    expect((caughtA as EvalError).code).toBe("input-invalid");
    expect((caughtA as EvalError).message).toContain("trusted preparation failed: raw network failure");
    expect((caughtA as EvalError).cause).toBe(rawError);

    // Case B: throws EvalError directly
    const customEvalError = new EvalError("path-unsafe", "custom preparation path unsafe violation", { at: "custom" });
    const preparerB: CasePreparer = async () => {
      throw customEvalError;
    };

    const runOptionsB: RunPairedEvaluationOptions = {
      ...runOptionsA,
      runId: "19700101T000000Z-prep-wrap-b",
      workDir: join(root, "work-b"),
      preparer: preparerB,
    };

    let caughtB: unknown;
    try {
      await runPairedEvaluation(runOptionsB);
    } catch (err) {
      caughtB = err;
    }
    expect(caughtB).toBe(customEvalError);
    expect((caughtB as EvalError).code).toBe("path-unsafe");
  });

  it("cleans up timers and abort listeners across success, error, timeout, and preabort", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const observe = (signal: AbortSignal) => { signals.push(signal); };
    // 1. Success case
    const controller1 = new AbortController();
    await executeTrustedPreparer({
      preparer: async ({ signal }) => { observe(signal); return { fixtureFiles: [{ path: "f", content: "c" }] }; },
      suiteId: "s",
      caseSelector: "c",
      deadlineAtMs: Date.now() + 5000,
      signal: controller1.signal,
    });
    expect(getEventListeners(controller1.signal, "abort").length).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    // 2. Thrown error case
    const controller2 = new AbortController();
    await expect(
      executeTrustedPreparer({
        preparer: async ({ signal }) => {
          observe(signal);
          throw new Error("error");
        },
        suiteId: "s",
        caseSelector: "c",
        deadlineAtMs: Date.now() + 5000,
        signal: controller2.signal,
      }),
    ).rejects.toThrow();
    expect(getEventListeners(controller2.signal, "abort").length).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    // 3. Timeout case
    const controller3 = new AbortController();
    const timeout = executeTrustedPreparer({
      preparer: async ({ signal }) => { observe(signal); return new Promise<PreparedCaseData>(() => {}); },
      suiteId: "s",
      caseSelector: "c",
      deadlineAtMs: Date.now() + 40,
      signal: controller3.signal,
    });
    const rejected = expect(timeout).rejects.toMatchObject({ code: "interrupted" });
    await vi.advanceTimersByTimeAsync(40);
    await rejected;
    expect(getEventListeners(controller3.signal, "abort").length).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    // 4. Preabort case
    const controller4 = new AbortController();
    controller4.abort(new Error("preaborted"));
    await expect(
      executeTrustedPreparer({
        preparer: async () => ({}),
        suiteId: "s",
        caseSelector: "c",
        deadlineAtMs: Date.now() + 5000,
        signal: controller4.signal,
      }),
    ).rejects.toThrow();
    expect(getEventListeners(controller4.signal, "abort").length).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(signals).toHaveLength(3);
    for (const signal of signals) expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });

  it("proves pending deadline in a child process produces diagnostic error and non-zero exit rather than silent code 0", () => {
    const childScript = `
      import { executeTrustedPreparer } from "./evals/src/runner/run.ts";
      async function main() {
        await executeTrustedPreparer({
          preparer: () => new Promise(() => {}), // never settles
          suiteId: "sub-suite",
          caseSelector: "sub-case",
          deadlineAtMs: Date.now() + 80,
        });
      }
      main().catch((err) => {
        process.stderr.write("DIAGNOSTIC_ERR: " + (err instanceof Error ? err.message : String(err)) + "\\n");
        process.exit(1);
      });
    `;

    let status: number | null = null;
    let stdout = "";
    let stderr = "";

    try {
      stdout = execFileSync(
        process.execPath,
        ["--experimental-strip-types", "-e", childScript],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
          timeout: 5000,
          env: buildAllowlistedEnv(tmpdir(), {}),
        },
      );
      status = 0;
    } catch (err: unknown) {
      const execError = err as { status?: number; stdout?: string; stderr?: string };
      status = execError.status ?? 1;
      stdout = execError.stdout ?? "";
      stderr = execError.stderr ?? "";
    }

    // Crucial: Child must NOT exit silently with status 0!
    expect(status).not.toBe(0);
    expect(status).toBe(1);
    expect(stderr).toContain("DIAGNOSTIC_ERR:");
    expect(stderr).toContain("trusted preparation exceeded deadline");
  });
});
