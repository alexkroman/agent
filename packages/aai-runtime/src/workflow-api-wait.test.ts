// Copyright 2026 the AAI authors. MIT license.
/**
 * The wait loop.
 *
 * Driven directly rather than over HTTP — `workflow-api.test.ts` owns what the
 * routes DO with the answer, and what is left is the loop's three stopping
 * conditions and the one thing none of them is: a request that gave up must
 * never look like a run that ended.
 *
 * Virtual time throughout. The whole subject is a deadline, so a spec that
 * waited out real milliseconds would be measuring the runner.
 */

import type { WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type CallerLink, waitForRun } from "./workflow-api-wait.ts";

function snapshot(over: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    runId: "wrun_1",
    workflow: "digest",
    createdAt: 0,
    status: "running",
    ...over,
  } as WorkflowRunSnapshot;
}

/** A live caller, plus the `close` its listener is waiting for. */
function link(): CallerLink & { leave: () => void } {
  const listeners = new Set<() => void>();
  return {
    destroyed: false,
    once: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
    leave: () => {
      for (const listener of listeners) listener();
    },
  };
}

/** A reader that walks a script, repeating its last entry. */
function reader(script: (WorkflowRunSnapshot | undefined)[]) {
  const queue = [...script];
  return { get: vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0])) };
}

describe("waitForRun", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns as soon as the run is terminal", async () => {
    const runs = reader([snapshot(), snapshot({ status: "completed" })]);
    const waiting = waitForRun(runs, "wrun_1", 60_000, link());

    await vi.advanceTimersByTimeAsync(1000);

    expect(await waiting).toMatchObject({ status: "completed" });
    // Stopping is the point: the loop must not keep reading a settled run for
    // the rest of the budget.
    const reads = runs.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs.get.mock.calls.length).toBe(reads);
  });

  test("gives up at the deadline with the RUNNING snapshot", async () => {
    // Not an error and not a cancel: the run is real and the caller holds its
    // id. A rejection here would throw away the one thing they cannot rebuild.
    const runs = reader([snapshot({ status: "running" })]);
    const waiting = waitForRun(runs, "wrun_1", 1000, link());

    await vi.advanceTimersByTimeAsync(2000);

    expect(await waiting).toMatchObject({ status: "running" });
  });

  test("never sleeps past the deadline", async () => {
    // The last interval is TRIMMED to what is left, so a 100ms budget answers
    // in 100ms rather than at the next 250ms tick.
    const runs = reader([snapshot({ status: "running" })]);
    // A spy rather than a `let settled = false` flipped in a `.then()`: it
    // records its own calls and names itself in the failure. And the promise is
    // AWAITED at the end instead of `void`ed, so a rejection fails this test
    // rather than surfacing as an unhandled rejection somewhere later.
    const settled = vi.fn();
    const waiting = waitForRun(runs, "wrun_1", 100, link()).then(settled);

    await vi.advanceTimersByTimeAsync(120);
    expect(settled).toHaveBeenCalled();
    await waiting;
  });

  test("stops when the caller goes away", async () => {
    // A page navigating away mid-wait would otherwise leave this reading a
    // database for a response nobody will receive.
    const runs = reader([snapshot({ status: "running" })]);
    const caller = link();
    const waiting = waitForRun(runs, "wrun_1", 60_000, caller);

    await vi.advanceTimersByTimeAsync(300);
    caller.leave();
    await vi.advanceTimersByTimeAsync(300);
    await waiting;

    const reads = runs.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs.get.mock.calls.length).toBe(reads);
  });

  test("does not start at all for a caller already gone", async () => {
    const runs = reader([snapshot({ status: "running" })]);
    const caller = { ...link(), destroyed: true };

    await waitForRun(runs, "wrun_1", 60_000, caller);

    // One read, then out: the answer is whatever the run is, and there is
    // nobody to tell about a later one.
    expect(runs.get).toHaveBeenCalledTimes(1);
  });

  test("answers immediately for a run the agent does not know", async () => {
    // A 404 is a stable answer; spending a 60s budget on it is how a stale id
    // holds a request open for a minute.
    const runs = reader([undefined]);
    expect(await waitForRun(runs, "wrun_gone", 60_000, link())).toBeUndefined();
    expect(runs.get).toHaveBeenCalledTimes(1);
  });

  test("reads exactly once when asked not to wait", async () => {
    const runs = reader([snapshot({ status: "running" })]);
    expect(await waitForRun(runs, "wrun_1", 0, link())).toMatchObject({ status: "running" });
    expect(runs.get).toHaveBeenCalledTimes(1);
  });

  test("clamps a budget past the cap rather than honouring it", async () => {
    // Both ends clamp with the same function, so a client cannot ask the agent
    // to hold a socket open for longer than the agent will.
    const runs = reader([snapshot({ status: "running" })]);
    const waiting = waitForRun(runs, "wrun_1", 10 * 60_000, link());

    await vi.advanceTimersByTimeAsync(61_000);

    expect(await waiting).toMatchObject({ status: "running" });
  });

  test("releases its listener, so a served request leaks nothing", async () => {
    const caller = link();
    const off = vi.spyOn(caller, "off");
    await waitForRun(reader([snapshot({ status: "completed" })]), "wrun_1", 5000, caller);
    expect(off).toHaveBeenCalled();
  });
});
