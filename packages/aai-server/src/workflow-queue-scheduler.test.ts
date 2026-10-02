// Copyright 2026 the AAI authors. MIT license.
/**
 * The schedule's START conditions and its listener lifecycle.
 *
 * What a running sweep does on a tick, on a NOTIFY and on a due-soon look is
 * covered by `workflow-queue-sweep.test.ts` and `workflow-queue-due-soon.test.ts`,
 * which drive passes through it; this file covers the edges they do not reach:
 * when it refuses to start at all, and a listener that settles after `stop()` or
 * fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { captureLogs } from "./_logger-test-utils.ts";
import { fakeAdminDbOver } from "./_sql-test-utils.ts";
import type { AdminDb } from "./platform/lock.ts";
import { startWorkflowQueueSweep } from "./workflow-queue-scheduler.ts";
import { WORKFLOW_QUEUE_CHANNEL } from "./workflow-queue-store.ts";

/** An admin connection whose `listen` answers `subscribed` and records its channel. */
function dbListening(subscribed: Promise<() => void>): AdminDb & { channels: string[] } {
  const channels: string[] = [];
  return {
    ...fakeAdminDbOver(() => []),
    listen: (channel) => {
      channels.push(channel);
      return subscribed;
    },
    channels,
  };
}

const deliver = () => Promise.resolve({ type: "completed" as const });

describe("startWorkflowQueueSweep", () => {
  const logs = captureLogs();
  afterEach(() => {
    vi.useRealTimers();
  });

  test("starts nothing without a platform database", () => {
    vi.useFakeTimers();
    const stop = startWorkflowQueueSweep({ deliver });
    expect(vi.getTimerCount()).toBe(0);
    expect(() => stop()).not.toThrow();
    expect(logs.infos()).toEqual([]);
  });

  test("an interval of zero is the kill switch, and says so", () => {
    const db = dbListening(Promise.resolve(() => undefined));
    startWorkflowQueueSweep({ adminDb: db, deliver, intervalMs: 0 });
    expect(db.channels).toEqual([]);
    expect(logs.infos()).toHaveLength(1);
  });

  test("subscribes to the queue channel and unsubscribes on stop", async () => {
    const unlisten = vi.fn();
    const db = dbListening(Promise.resolve(unlisten));
    const stop = startWorkflowQueueSweep({ adminDb: db, deliver, intervalMs: 600_000 });
    expect(db.channels).toEqual([WORKFLOW_QUEUE_CHANNEL]);
    await vi.waitFor(() => expect(logs.infos().length).toBeGreaterThanOrEqual(2));
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  test("a subscription that lands AFTER stop is torn down at once", async () => {
    const pending = Promise.withResolvers<() => void>();
    const unlisten = vi.fn();
    const stop = startWorkflowQueueSweep({
      adminDb: dbListening(pending.promise),
      deliver,
      intervalMs: 600_000,
    });
    stop();
    pending.resolve(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  });

  test("a failed subscription degrades to the poll and warns", async () => {
    const stop = startWorkflowQueueSweep({
      adminDb: dbListening(Promise.reject(new Error("listen refused"))),
      deliver,
      intervalMs: 600_000,
    });
    await vi.waitFor(() => expect(logs.warns()).toHaveLength(1));
    stop();
  });
});
