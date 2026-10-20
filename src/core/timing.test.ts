import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleTimeout } from "./timing.ts";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("long task timeouts", () => {
  it("waits the full duration beyond Node's timer range", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    scheduleTimeout(done, 2_147_483_647 + 60_000);
    vi.advanceTimersByTime(2_147_483_647);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(59_999);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledOnce();
  });

  it("cancels between chunks", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const timer = scheduleTimeout(done, 2_147_483_647 + 60_000);
    vi.advanceTimersByTime(2_147_483_647);
    timer.cancel();
    vi.advanceTimersByTime(60_000);
    expect(done).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps re-armed chunks unreferenced after unref", () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const timer = scheduleTimeout(vi.fn(), 2_147_483_647 + 60_000);
    timer.unref();
    expect(timeout.mock.results[0]!.value.hasRef()).toBe(false);
    vi.advanceTimersByTime(2_147_483_647);
    expect(timeout).toHaveBeenCalledTimes(2);
    expect(timeout.mock.results[1]!.value.hasRef()).toBe(false);
    timer.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])("rejects invalid delay %p before scheduling", (delay) => {
    vi.useFakeTimers();
    expect(() => scheduleTimeout(vi.fn(), delay)).toThrow("non-negative finite delay");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts zero as an immediate cancellable timeout", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    scheduleTimeout(done, 0);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(done).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

});
