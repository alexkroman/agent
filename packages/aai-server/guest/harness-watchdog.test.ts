// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for the guest orphan watchdog. Pure timer logic — no Deno shim
 * needed (unlike deno-harness.test.ts, this module touches no Deno globals).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createOrphanWatchdog } from "./harness-watchdog.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createOrphanWatchdog", () => {
  test("fires once after the timeout with no traffic", async () => {
    const onOrphaned = vi.fn();
    createOrphanWatchdog({ onOrphaned, timeoutMs: 1000, pollMs: 100 });
    await vi.advanceTimersByTimeAsync(999);
    expect(onOrphaned).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(onOrphaned).toHaveBeenCalledTimes(1);
    // The interval self-clears on firing — no repeat calls.
    await vi.advanceTimersByTimeAsync(5000);
    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });

  test("touch() defers orphaning while host traffic flows", async () => {
    const onOrphaned = vi.fn();
    const wd = createOrphanWatchdog({ onOrphaned, timeoutMs: 1000, pollMs: 100 });
    // Simulate steady heartbeats: touch every 500ms for 5s.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(500);
      wd.touch();
    }
    expect(onOrphaned).not.toHaveBeenCalled();
    // Traffic stops — the watchdog fires one timeout later.
    await vi.advanceTimersByTimeAsync(1200);
    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });

  test("stop() disarms the watchdog", async () => {
    const onOrphaned = vi.fn();
    const wd = createOrphanWatchdog({ onOrphaned, timeoutMs: 1000, pollMs: 100 });
    wd.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onOrphaned).not.toHaveBeenCalled();
  });
});
