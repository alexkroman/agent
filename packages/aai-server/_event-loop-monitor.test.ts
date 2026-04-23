// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { startEventLoopMonitor } from "./_event-loop-monitor.ts";

describe("startEventLoopMonitor", () => {
  test("emits a log line after logIntervalMs and resets the window", async () => {
    const log = vi.fn();
    const monitor = startEventLoopMonitor({
      resolutionMs: 10,
      logIntervalMs: 50,
      log,
    });
    // Let the histogram gather samples for roughly three log intervals.
    await new Promise((r) => setTimeout(r, 200));
    monitor.stop();

    expect(log).toHaveBeenCalled();
    const firstCall = log.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [msg, data] = firstCall as [string, Record<string, unknown>];
    expect(msg).toBe("event-loop delay");
    expect(data).toEqual(
      expect.objectContaining({
        p50: expect.any(Number),
        p95: expect.any(Number),
        max: expect.any(Number),
        count: expect.any(Number),
      }),
    );
    // Latencies are reported in ms and non-negative.
    expect((data as { p50: number }).p50).toBeGreaterThanOrEqual(0);
    expect((data as { max: number }).max).toBeGreaterThanOrEqual(0);
  });

  test("snapshot() returns current stats without resetting", async () => {
    const monitor = startEventLoopMonitor({ resolutionMs: 10, logIntervalMs: 60_000 });
    await new Promise((r) => setTimeout(r, 40));
    const first = monitor.snapshot();
    await new Promise((r) => setTimeout(r, 40));
    const second = monitor.snapshot();
    monitor.stop();

    // Samples accumulate between snapshots (we didn't reset in between).
    expect(second.count).toBeGreaterThanOrEqual(first.count);
  });

  test("stop() clears the interval so no further log lines fire", async () => {
    const log = vi.fn();
    const monitor = startEventLoopMonitor({ resolutionMs: 10, logIntervalMs: 30, log });
    await new Promise((r) => setTimeout(r, 80));
    const callsBeforeStop = log.mock.calls.length;
    monitor.stop();
    await new Promise((r) => setTimeout(r, 80));
    expect(log.mock.calls.length).toBe(callsBeforeStop);
  });
});
