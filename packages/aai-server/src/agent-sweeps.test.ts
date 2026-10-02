// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test, vi } from "vitest";
import { captureLogs } from "./_logger-test-utils.ts";
import { createTestStore } from "./_orchestrator-test-utils.ts";
import { fakeAdminDbOver } from "./_sql-test-utils.ts";
import { startAgentSweeps } from "./agent-sweeps.ts";
import type { AdminDb } from "./platform/lock.ts";
import { createSlotCache } from "./sandbox/slots.ts";
import { WORKFLOW_QUEUE_CHANNEL } from "./workflow-queue-store.ts";

function sweepOptions(adminDb?: AdminDb) {
  const store = createTestStore();
  return { store, broker: { slots: createSlotCache(), store }, adminDb };
}

describe("startAgentSweeps", () => {
  captureLogs();
  // Virtual time throughout: the sweep returns no stop, so its interval must be
  // one that can never fire on the wall clock.
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a composition with no platform database starts nothing", () => {
    vi.useFakeTimers();
    startAgentSweeps(sweepOptions());
    expect(vi.getTimerCount()).toBe(0);
  });

  test("with one, it starts the queue delivery sweep on the queue channel", () => {
    vi.useFakeTimers();
    const channels: string[] = [];
    const adminDb: AdminDb = {
      ...fakeAdminDbOver(() => []),
      listen: (channel) => {
        channels.push(channel);
        return Promise.resolve(() => undefined);
      },
    };
    startAgentSweeps(sweepOptions(adminDb));
    expect(channels).toEqual([WORKFLOW_QUEUE_CHANNEL]);
    expect(vi.getTimerCount()).toBe(1);
  });
});
