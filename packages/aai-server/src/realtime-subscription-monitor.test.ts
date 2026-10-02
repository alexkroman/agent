// Copyright 2026 the AAI authors. MIT license.
/**
 * The tracker on its own, fed statuses directly. The same states driven
 * through real channel topology (topics, refcounts, a fake Supabase client) are
 * in `realtime-events.test.ts`'s "subscription health" block; this file covers
 * the tracker's own bookkeeping — registration, untracking, and the budget edge.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { captureLogs } from "./_logger-test-utils.ts";
import { createSubscriptionMonitor } from "./realtime-subscription-monitor.ts";

describe("createSubscriptionMonitor", () => {
  const logs = captureLogs();
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("counts tracked channels, and a fresh one is not stalled yet", () => {
    const monitor = createSubscriptionMonitor();
    monitor.track("aai:agents");
    monitor.track("aai:workspace:s:p");
    expect(monitor.health()).toEqual({ channels: 2, stalled: [] });
  });

  test("a channel that never acks is stalled exactly at the 30s budget", () => {
    const monitor = createSubscriptionMonitor();
    monitor.track("aai:agents");
    vi.advanceTimersByTime(29_999);
    expect(monitor.health().stalled).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(monitor.health().stalled).toEqual(["aai:agents"]);
  });

  test("statuses other than a join or a failure change nothing", () => {
    const monitor = createSubscriptionMonitor();
    const onStatus = monitor.track("aai:agents");
    onStatus("SUBSCRIBED");
    onStatus("CLOSED");
    vi.advanceTimersByTime(60_000);
    expect(monitor.health().stalled).toEqual([]);
    expect(logs.warns()).toEqual([]);
  });

  test("a failure warns with the error's message, then escalates once past budget", () => {
    const monitor = createSubscriptionMonitor();
    const onStatus = monitor.track("aai:agents");
    onStatus("TIMED_OUT", new Error("join timeout"));
    expect(logs.warns()).toEqual([expect.stringContaining("join timeout")]);
    vi.advanceTimersByTime(30_000);
    onStatus("TIMED_OUT");
    onStatus("TIMED_OUT");
    expect(logs.errors()).toHaveLength(1);
  });

  test("re-tracking a topic restarts its budget", () => {
    const monitor = createSubscriptionMonitor();
    monitor.track("aai:agents");
    vi.advanceTimersByTime(40_000);
    monitor.track("aai:agents");
    expect(monitor.health()).toEqual({ channels: 1, stalled: [] });
  });

  test("untrack and clear forget channels, stalled or not", () => {
    const monitor = createSubscriptionMonitor();
    monitor.track("a");
    monitor.track("b");
    monitor.track("c");
    vi.advanceTimersByTime(60_000);
    monitor.untrack("a");
    expect(monitor.health()).toEqual({ channels: 2, stalled: ["b", "c"] });
    monitor.clear();
    expect(monitor.health()).toEqual({ channels: 0, stalled: [] });
  });
});
