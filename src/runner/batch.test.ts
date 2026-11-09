import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { STARTUP_ALLOWANCE_MS } from "./run.ts";
import { batchStopReason, createBatchSignals, deriveBatchRunFacts, runBatchSequence } from "./batch.ts";
import type { BatchRunFacts, BatchSignals } from "./batch.ts";

const ok = (overrides: Partial<BatchRunFacts> = {}): BatchRunFacts => ({
  started: true,
  verified: true,
  cleanupUnverified: false,
  failureCodes: [],
  code: 0,
  ...overrides,
});

/** Scriptable signal source: `reasons[n]` is what `reason()` returns on its n-th consultation. */
function fakeSignals(initial: string | null = null): BatchSignals & { received: string | null; disposed: boolean; controllers: AbortController[] } {
  const state = { received: initial, disposed: false, controllers: [] as AbortController[] };
  return Object.assign(state, {
    reason: () => state.received,
    beginRun: (controller: AbortController) => void state.controllers.push(controller),
    markRunning: () => undefined,
    endRun: () => undefined,
    dispose: () => {
      state.disposed = true;
    },
  });
}

const LABELS = ["Model A", "Model B", "Model C"];

async function sequence(
  runs: (BatchRunFacts | Error)[],
  options: { signals?: ReturnType<typeof fakeSignals>; onRun?: (index: number) => void; now?: () => number } = {},
) {
  const signals = options.signals ?? fakeSignals();
  const started: number[] = [];
  const exported: (BatchRunFacts | null)[][] = [];
  const result = await runBatchSequence<BatchRunFacts>({
    labels: LABELS,
    signals,
    now: options.now,
    async runOne(index) {
      started.push(index);
      options.onRun?.(index);
      const next = runs[index]!;
      if (next instanceof Error) throw next;
      return next;
    },
    onRunFailure: () => "evidence-invalid",
    async exportCombined(executed) {
      exported.push([...executed]);
    },
  });
  return { result, started, exported, signals };
}

describe("batchStopReason", () => {
  it.each<[string, Partial<BatchRunFacts>, string]>([
    ["no report or result", { started: false, code: 1 }, "the run did not start"],
    ["failed verification", { verified: false, code: 1 }, "evidence verification failed"],
    ["unverified cleanup", { cleanupUnverified: true, code: 1 }, "cleanup was not verified"],
    ["a cleanup-failed failure", { failureCodes: ["cleanup-failed"], code: 1 }, "cleanup failed"],
    ["a quarantined secret", { failureCodes: ["secret-quarantine"], code: 1 }, "a secret was quarantined"],
  ])("stops on %s", (_name, facts, reason) => {
    expect(batchStopReason(ok(facts))).toBe(reason);
  });

  it("does not stop for per-arm infrastructure failures or task failures", () => {
    expect(batchStopReason(ok({ failureCodes: ["provider-error", "validator-infrastructure", "protocol-drift"], code: 1 }))).toBeNull();
    expect(batchStopReason(ok({ code: 1 }))).toBeNull();
    expect(batchStopReason(ok())).toBeNull();
  });
});

describe("runBatchSequence", () => {
  it("wires the run's onRunning callback to signals.markRunning, between beginRun and endRun", async () => {
    const calls: string[] = [];
    const signals = Object.assign(fakeSignals(), {
      beginRun: () => void calls.push("beginRun"),
      markRunning: () => void calls.push("markRunning"),
      endRun: () => void calls.push("endRun"),
    });
    await runBatchSequence<BatchRunFacts>({
      labels: ["Model A"],
      signals,
      async runOne(_index, context) {
        calls.push("run");
        context.onRunning();
        return ok();
      },
      onRunFailure: () => "evidence-invalid",
      async exportCombined() {},
    });
    expect(calls).toEqual(["beginRun", "run", "markRunning", "endRun"]);
  });

  it("runs every model in order and exits 0 only when all complete and verify", async () => {
    const { result, started, exported, signals } = await sequence([ok(), ok(), ok()]);
    expect(started).toEqual([0, 1, 2]);
    expect(result).toMatchObject({ stopReason: null, startedCount: 3, code: 0 });
    expect(exported).toHaveLength(1);
    expect(signals.disposed).toBe(true);
  });

  it.each<[string, Partial<BatchRunFacts>, string]>([
    ["unverified cleanup", { cleanupUnverified: true, code: 1 }, "Model A: cleanup was not verified"],
    ["a cleanup-failed failure", { failureCodes: ["cleanup-failed"], code: 1 }, "Model A: cleanup failed"],
    ["a quarantined secret", { failureCodes: ["secret-quarantine"], code: 1 }, "Model A: a secret was quarantined"],
    ["failed verification", { verified: false, code: 1 }, "Model A: evidence verification failed"],
    ["a run without report or result", { started: false, code: 1 }, "Model A: the run did not start"],
  ])("stops after %s: later models are not run, exit 1, exports still attempted", async (_name, facts, reason) => {
    const { result, started, exported } = await sequence([ok(facts), ok(), ok()]);
    expect(started).toEqual([0]);
    expect(result.stopReason).toBe(reason);
    expect(result.code).toBe(1);
    expect(result.executed[1]).toBeNull();
    expect(exported).toHaveLength(1);
  });

  it("counts only runs that started", async () => {
    const { result } = await sequence([ok({ started: false, code: 1 }), ok(), ok()]);
    expect(result.startedCount).toBe(0);
  });

  it("continues after a per-arm infrastructure failure and after a task failure, but exits 1", async () => {
    const { result, started } = await sequence([
      ok({ failureCodes: ["provider-error"], code: 1 }),
      ok({ code: 1 }),
      ok(),
    ]);
    expect(started).toEqual([0, 1, 2]);
    expect(result.stopReason).toBeNull();
    expect(result.startedCount).toBe(3);
    expect(result.code).toBe(1);
  });

  it("starts nothing when a signal arrived before run 1, and still attempts the export", async () => {
    const { result, started, exported } = await sequence([ok(), ok(), ok()], { signals: fakeSignals("SIGINT received") });
    expect(started).toEqual([]);
    expect(result).toMatchObject({ stopReason: "SIGINT received", startedCount: 0, code: 1 });
    expect(exported).toHaveLength(1);
  });

  it("stops between runs when a signal arrives during a run; later models are not run", async () => {
    const signals = fakeSignals();
    const { result, started } = await sequence([ok(), ok(), ok()], {
      signals,
      onRun: (index) => {
        if (index === 1) signals.received = "SIGTERM received";
      },
    });
    expect(started).toEqual([0, 1]);
    expect(result.stopReason).toBe("SIGTERM received");
    expect(result.executed[1]).not.toBeNull();
    expect(result.executed[2]).toBeNull();
    expect(result.startedCount).toBe(2);
    expect(result.code).toBe(1);
  });

  it("stops when the first model throws, lists later models as not run, and still attempts the export", async () => {
    const { result, started, exported } = await sequence([new Error("boom"), ok(), ok()]);
    expect(started).toEqual([0]);
    expect(result.stopReason).toBe("Model A failed: evidence-invalid");
    expect(result.executed).toEqual([null, null, null]);
    expect(result.startedCount).toBe(0);
    expect(result.threw).toEqual(new Map([[0, "evidence-invalid"]]));
    expect(result.code).toBe(1);
    expect(exported).toHaveLength(1);
  });

  it("prefers a received signal over the failure text when a run throws", async () => {
    const signals = fakeSignals();
    const { result } = await sequence([new Error("aborted"), ok(), ok()], {
      signals,
      onRun: () => {
        signals.received = "SIGINT received";
      },
    });
    expect(result.stopReason).toBe("SIGINT received");
  });

  it("gives every run its own clock origin: an earlier run's elapsed time cannot expire a later run's startup deadline", async () => {
    let clock = 1_000_000;
    const origins: number[] = [];
    const clockAtStart: number[] = [];
    const signals = fakeSignals();
    await runBatchSequence<BatchRunFacts>({
      labels: ["A", "B"],
      signals,
      now: () => clock,
      async runOne(_index, { startedAtMs }) {
        origins.push(startedAtMs);
        clockAtStart.push(clock);
        // The run consumes more than the whole startup allowance.
        clock += STARTUP_ALLOWANCE_MS + 60_000;
        return ok();
      },
      onRunFailure: () => "x",
      async exportCombined() {},
    });
    expect(origins).toEqual([1_000_000, 1_000_000 + STARTUP_ALLOWANCE_MS + 60_000]);
    // The second run's startup deadline (origin + allowance) lies in the future when it starts.
    // Each origin is the clock when that run started: run 2 is not anchored at run 1's origin.
    expect(origins).toEqual(clockAtStart);
    expect(origins[1]).not.toBe(origins[0]);
    expect(origins[1]! + STARTUP_ALLOWANCE_MS).toBeGreaterThan(clockAtStart[1]!);
    // Anchoring at the first run's origin would already have expired it.
    expect(origins[0]! + STARTUP_ALLOWANCE_MS).toBeLessThan(origins[1]!);
  });

  it("exits 1 when every run is clean but a signal arrives after the last run completed", async () => {
    const signals = fakeSignals();
    const { result } = await sequence([ok(), ok(), ok()], {
      signals,
      onRun: (index) => {
        if (index === 2) signals.received = "SIGINT received";
      },
    });
    expect(result.executed.every((run) => run?.code === 0)).toBe(true);
    expect(result.stopReason).toBe("SIGINT received");
    expect(result.code).toBe(1);
  });

  it("hands each run its own abort controller", async () => {
    const { signals } = await sequence([ok(), ok(), ok()]);
    expect(new Set(signals.controllers).size).toBe(3);
  });
});

describe("createBatchSignals", () => {
  const setup = () => {
    const events = new EventEmitter();
    const exit = vi.fn();
    const signals = createBatchSignals({ events, exit });
    return { events, exit, signals };
  };

  it("aborts the current run during startup and records the reason", () => {
    const { events, signals, exit } = setup();
    const controller = new AbortController();
    signals.beginRun(controller);
    events.emit("SIGINT");
    expect(signals.reason()).toBe("SIGINT received");
    expect(controller.signal.aborted).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  it("leaves a running run to the runner's own handlers", () => {
    const { events, signals } = setup();
    const controller = new AbortController();
    signals.beginRun(controller);
    signals.markRunning();
    events.emit("SIGTERM");
    expect(signals.reason()).toBe("SIGTERM received");
    expect(controller.signal.aborted).toBe(false);
  });

  it("while a run is executing, further signals only record the stop and never force-exit or abort", () => {
    const { events, signals, exit } = setup();
    const controller = new AbortController();
    signals.beginRun(controller);
    signals.markRunning();
    events.emit("SIGINT");
    events.emit("SIGINT");
    events.emit("SIGTERM");
    expect(exit).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
    expect(signals.reason()).toBe("SIGINT received");
  });

  it("force-exits on a second signal during startup (130 for SIGINT, 143 for SIGTERM) and removes handlers on dispose", () => {
    const first = setup();
    first.events.emit("SIGINT");
    first.events.emit("SIGINT");
    expect(first.exit).toHaveBeenCalledWith(130);
    const second = setup();
    second.events.emit("SIGINT");
    second.events.emit("SIGTERM");
    expect(second.exit).toHaveBeenCalledWith(143);
    const third = setup();
    third.signals.dispose();
    expect(third.events.listenerCount("SIGINT")).toBe(0);
    expect(third.events.listenerCount("SIGTERM")).toBe(0);
  });

  it("after a run ends, a second signal between runs force-exits", () => {
    const { events, signals, exit } = setup();
    signals.beginRun(new AbortController());
    signals.markRunning();
    events.emit("SIGINT");
    signals.endRun();
    events.emit("SIGINT");
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("aborts a run that begins after a signal was already received", () => {
    const { events, signals } = setup();
    events.emit("SIGINT");
    const controller = new AbortController();
    signals.beginRun(controller);
    expect(controller.signal.aborted).toBe(true);
  });
});

describe("deriveBatchRunFacts", () => {
  const record = (overrides: Partial<Parameters<typeof deriveBatchRunFacts>[0]> = {}) => ({
    report: { verification: { ok: true }, failures: [] },
    result: { failures: [] },
    outcome: { code: 0 },
    cleanupUnverified: false,
    ...overrides,
  });

  it("derives a clean run", () => {
    expect(deriveBatchRunFacts(record())).toEqual({ started: true, verified: true, cleanupUnverified: false, failureCodes: [], code: 0 });
  });

  it("surfaces failure codes from both the run result and the report", () => {
    const facts = deriveBatchRunFacts(record({
      result: { failures: [{ code: "cleanup-failed" }] },
      report: { verification: { ok: true }, failures: [{ code: "secret-quarantine" }] },
      outcome: { code: 1 },
    }));
    expect(facts.failureCodes).toEqual(["cleanup-failed", "secret-quarantine"]);
    expect(batchStopReason(facts)).toBe("cleanup failed");
    expect(batchStopReason({ ...facts, failureCodes: ["secret-quarantine"] })).toBe("a secret was quarantined");
  });

  it("treats a missing report or result as not started, and failed verification as unverified", () => {
    expect(deriveBatchRunFacts(record({ report: null })).started).toBe(false);
    expect(deriveBatchRunFacts(record({ result: null })).started).toBe(false);
    expect(deriveBatchRunFacts(record({ report: { verification: { ok: false } } })).verified).toBe(false);
    expect(deriveBatchRunFacts(record({ report: null })).verified).toBe(false);
  });

  it("carries the unverified-cleanup flag and the run's own exit code", () => {
    expect(deriveBatchRunFacts(record({ cleanupUnverified: true, outcome: { code: 1 } }))).toMatchObject({ cleanupUnverified: true, code: 1 });
  });
});
