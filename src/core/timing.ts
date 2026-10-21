/** A cancellable timeout that also supports delays beyond Node's single-timer range. */
export interface DeadlineTimer {
  cancel(): void;
  unref(): void;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * @notice Schedules a finite delay without Node's long-delay overflow turning it into 1ms.
 * @param callback Work to perform after the full delay.
 * @param delayMs Non-negative finite delay in milliseconds.
 * @returns A handle for cancellation and optional process-liveness detachment.
 */
export function scheduleTimeout(callback: () => void, delayMs: number): DeadlineTimer {
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("timeout must be a non-negative finite delay");
  let remaining = delayMs;
  let startedAt = Date.now();
  let cancelled = false;
  let detached = false;
  let timer: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    timer = setTimeout(() => {
      if (cancelled) return;
      const now = Date.now();
      remaining -= Math.max(0, now - startedAt);
      startedAt = now;
      if (remaining > 0) arm();
      else callback();
    }, Math.min(remaining, MAX_TIMER_DELAY_MS));
    if (detached) timer.unref();
  };
  arm();
  return {
    cancel: () => { cancelled = true; clearTimeout(timer); },
    unref: () => { detached = true; timer.unref(); },
  };
}
