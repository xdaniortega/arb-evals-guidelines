/**
 * Multi-model command orchestration policy.
 *
 * A multi-model command is a sequence of independent runs (one per model); there is no sealed
 * grouping, only a combined EVALS.md written afterwards from the runs it produced. This
 * module owns the policy and nothing else: sequencing in argument order, when a batch must
 * stop, which stop reason is reported, which members count as started and the exit code.
 * Everything that touches a run (execution, export) is injected, so it is testable without
 * processes or evidence. Nothing is ever re-run.
 */

/** Facts about one finished run that the batch policy needs. */
export interface BatchRunFacts {
  /** A run was claimed and a report was produced (probes passed, evidence exists). */
  readonly started: boolean;
  /** The sealed evidence chain verified. */
  readonly verified: boolean;
  /** A pair's cleanup was not verified. */
  readonly cleanupUnverified: boolean;
  /** Structured failure codes recorded by the run (run-level and report-level). */
  readonly failureCodes: readonly string[];
  /** The run's own exit code: 0 only when it completed and verified. */
  readonly code: number;
}

/** Minimal shape of an executed run the batch policy reads (structurally satisfied by the CLI's run record). */
export interface BatchRunRecord {
  readonly report: {
    readonly verification: { readonly ok: boolean };
    readonly failures?: readonly { readonly code: string }[];
  } | null;
  readonly result: { readonly failures: readonly { readonly code: string }[] } | null;
  readonly outcome: { readonly code: number };
  readonly cleanupUnverified: boolean;
}

/** Derives the policy facts of a run: pure, from its report, result and outcome. */
export function deriveBatchRunFacts(run: BatchRunRecord): BatchRunFacts {
  return {
    started: run.report !== null && run.result !== null,
    verified: run.report?.verification.ok === true,
    cleanupUnverified: run.cleanupUnverified,
    failureCodes: [...(run.result?.failures ?? []), ...(run.report?.failures ?? [])].map((failure) => failure.code),
    code: run.outcome.code,
  };
}

/** Conditions after which no further model may start. Everything else (task or per-arm failures) continues. */
export function batchStopReason(run: BatchRunFacts): string | null {
  if (!run.started) return "the run did not start";
  if (!run.verified) return "evidence verification failed";
  if (run.cleanupUnverified) return "cleanup was not verified";
  if (run.failureCodes.includes("cleanup-failed")) return "cleanup failed";
  if (run.failureCodes.includes("secret-quarantine")) return "a secret was quarantined";
  return null;
}

/** Stop-signal source consulted between and during runs. */
export interface BatchSignals {
  /** Text of the first signal received, or `null`. */
  reason(): string | null;
  /** A new run is about to start under this controller. */
  beginRun(controller: AbortController): void;
  /** Startup is complete: the runner owns cancellation from here. */
  markRunning(): void;
  /** The run finished (or threw): signals now arrive between runs. */
  endRun(): void;
  /** Removes any handlers. */
  dispose(): void;
}

interface SignalEvents {
  on(name: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(name: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/**
 * Process signal policy. The first SIGINT/SIGTERM requests a stop: during startup it aborts
 * the current run's controller; during a run the runner's own handlers seal the run, and the
 * batch simply starts nothing further. While a run is executing the batch handler only
 * records the stop, however many signals arrive: the runner's handlers stay in charge of
 * sealing and bounded cleanup. A second signal during startup or between runs force-exits
 * (130 for SIGINT, 143 for SIGTERM), so a wedged startup is not bounded only by the startup
 * backstop.
 */
export function createBatchSignals(options: {
  readonly events?: SignalEvents;
  readonly exit?: (code: number) => void;
} = {}): BatchSignals {
  const events: SignalEvents = options.events ?? process;
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  let received: string | null = null;
  let running = false;
  let controller: AbortController | null = null;
  const handler = (name: "SIGINT" | "SIGTERM") => (): void => {
    if (received !== null) {
      if (running) return;
      process.stderr.write(`${name} received again; exiting immediately\n`);
      exit(name === "SIGINT" ? 130 : 143);
      return;
    }
    received = `${name} received`;
    if (!running) controller?.abort(new Error(received));
  };
  const onSigint = handler("SIGINT");
  const onSigterm = handler("SIGTERM");
  events.on("SIGINT", onSigint);
  events.on("SIGTERM", onSigterm);
  return {
    reason: () => received,
    beginRun(next) {
      running = false;
      controller = next;
      if (received !== null) next.abort(new Error(received));
    },
    markRunning() {
      running = true;
    },
    endRun() {
      running = false;
      controller = null;
    },
    dispose() {
      events.removeListener("SIGINT", onSigint);
      events.removeListener("SIGTERM", onSigterm);
    },
  };
}

export interface BatchRunContext {
  /**
   * This run's own clock origin (epoch ms), read when the run starts. Progress times, the
   * startup backstop and the runner's startup deadline all anchor here, never at the
   * command's start, so an earlier model's elapsed time cannot expire a later model.
   */
  readonly startedAtMs: number;
  readonly controller: AbortController;
  /** The run calls this once every awaited startup step is done. */
  readonly onRunning: () => void;
}

export interface BatchSequenceInput<T extends BatchRunFacts> {
  readonly labels: readonly string[];
  readonly signals: BatchSignals;
  /** Clock source; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Executes one model's complete run; may throw. */
  runOne(index: number, context: BatchRunContext): Promise<T>;
  /** Reports an exception that escaped a run and returns its failure code. */
  onRunFailure(error: unknown, index: number): string;
  /** Writes the combined EVALS.md from the runs that were produced; always attempted once. */
  exportCombined(executed: readonly (T | null)[], threw: ReadonlyMap<number, string>): Promise<void>;
}

export interface BatchSequenceResult<T extends BatchRunFacts> {
  /** One slot per planned model; `null` when no result exists (not run, or the run threw). */
  readonly executed: readonly (T | null)[];
  readonly stopReason: string | null;
  /** Failure code of each model whose run threw, by planned index (such a run may have sealed before throwing). */
  readonly threw: ReadonlyMap<number, string>;
  /** Runs that actually started (a claimed run with a report). */
  readonly startedCount: number;
  /** 0 only if every planned run completed and verified and nothing stopped the batch. */
  readonly code: number;
}

/** Runs the planned models one after another, in order, applying the stop policy. */
export async function runBatchSequence<T extends BatchRunFacts>(input: BatchSequenceInput<T>): Promise<BatchSequenceResult<T>> {
  const executed: (T | null)[] = input.labels.map(() => null);
  const threw = new Map<number, string>();
  let stopReason: string | null = null;
  try {
    for (let index = 0; index < input.labels.length; index += 1) {
      const label = input.labels[index]!;
      const requested = input.signals.reason();
      if (requested !== null) {
        stopReason = requested;
        break;
      }
      const controller = new AbortController();
      input.signals.beginRun(controller);
      let run: T;
      try {
        run = await input.runOne(index, { startedAtMs: (input.now ?? Date.now)(), controller, onRunning: () => input.signals.markRunning() });
        input.signals.endRun();
      } catch (error: unknown) {
        input.signals.endRun();
        const code = input.onRunFailure(error, index);
        threw.set(index, code);
        stopReason = input.signals.reason() ?? `${label} failed: ${code}`;
        break;
      }
      executed[index] = run;
      const afterRun = input.signals.reason();
      if (afterRun !== null) {
        stopReason = afterRun;
        break;
      }
      const unsafe = batchStopReason(run);
      if (unsafe !== null) {
        stopReason = `${label}: ${unsafe}`;
        break;
      }
    }
  } finally {
    input.signals.dispose();
  }
  await input.exportCombined(executed, threw);
  const allOk = executed.every((run) => run !== null && run.code === 0);
  return {
    executed,
    threw,
    stopReason,
    startedCount: executed.filter((run) => run !== null && run.started).length,
    code: allOk && stopReason === null ? 0 : 1,
  };
}
