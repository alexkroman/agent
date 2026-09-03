// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the shared sweep scheduler.
 *
 * The two hand-rolled copies this replaced were covered only through their
 * OWNERS — `workflow-wake.test.ts` and `orphan-previews.test.ts` each asserted
 * "start/stop is idempotent and does not tick after stopping" and nothing else,
 * so the properties that make the schedule correct (drop an overrunning tick,
 * never hold the process up, survive a throwing pass) were asserted nowhere.
 * They are the whole content of this module, so they are asserted here once.
 *
 * Virtual time throughout: every claim is about whether a WINDOW elapsed, and a
 * spec that waits out real milliseconds to observe that is a race whose flake
 * names the timing spec rather than the bug (AGENTS.md, "A spec that observes a
 * TIMER runs on virtual time").
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createIntervalSweep } from "./_interval-sweep.ts";

describe("createIntervalSweep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("runs the pass once per interval", async () => {
    const pass = vi.fn(() => Promise.resolve());
    const stop = createIntervalSweep(pass).start(1000);

    await vi.advanceTimersByTimeAsync(3000);

    expect(pass).toHaveBeenCalledTimes(3);
    stop();
  });

  test("does not run a pass before the first interval elapses", async () => {
    // Both callers accept one interval of latency at boot rather than firing on
    // every replica the moment a deploy rolls — which is the one moment they are
    // all contending for the same advisory lock.
    const pass = vi.fn(() => Promise.resolve());
    createIntervalSweep(pass).start(1000);

    await vi.advanceTimersByTimeAsync(999);

    expect(pass).not.toHaveBeenCalled();
  });

  test("DROPS every tick that fires while a pass is still running", async () => {
    // The overrun policy, and the reason this is not `createCoalescingRunner`:
    // the skipped ticks are not owed a trailing run. Both passes re-read their
    // whole candidate set, so the next tick sees everything the dropped ones
    // would have.
    const gate = Promise.withResolvers<void>();
    const pass = vi.fn(() => gate.promise);
    const stop = createIntervalSweep(pass).start(1000);

    await vi.advanceTimersByTimeAsync(5000);
    expect(pass).toHaveBeenCalledTimes(1);

    gate.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    // One more, not five: the four dropped ticks left no backlog behind them.
    expect(pass).toHaveBeenCalledTimes(2);
    stop();
  });

  test("a pass that REJECTS does not wedge the interval", async () => {
    // The containment claim. Both callers log and swallow inside their own pass,
    // but a sweep whose whole purpose is that nothing else is watching must not
    // stop ticking because one tick threw.
    const pass = vi.fn(() => Promise.reject(new Error("pass failed")));
    const stop = createIntervalSweep(pass).start(1000);

    await vi.advanceTimersByTimeAsync(3000);

    expect(pass).toHaveBeenCalledTimes(3);
    stop();
  });

  test("a pass that throws SYNCHRONOUSLY is contained the same way", async () => {
    const pass = vi.fn((): Promise<void> => {
      throw new Error("sync throw");
    });
    const stop = createIntervalSweep(pass).start(1000);

    await vi.advanceTimersByTimeAsync(2000);

    expect(pass).toHaveBeenCalledTimes(2);
    stop();
  });

  test("stop() ends the ticking", async () => {
    const pass = vi.fn(() => Promise.resolve());
    const sweep = createIntervalSweep(pass);
    const stop = sweep.start(1000);

    await vi.advanceTimersByTimeAsync(1000);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(pass).toHaveBeenCalledTimes(1);
  });

  test("start() is idempotent — a second call does not double the rate", async () => {
    const pass = vi.fn(() => Promise.resolve());
    const sweep = createIntervalSweep(pass);
    sweep.start(1000);
    sweep.start(1000);

    await vi.advanceTimersByTimeAsync(2000);

    expect(pass).toHaveBeenCalledTimes(2);
  });

  test("an interval of 0 starts nothing, and still hands back a usable stop", async () => {
    // The documented kill switch both callers expose through an env-overridable
    // constant. Returning a live stop is what saves every caller a branch.
    const pass = vi.fn(() => Promise.resolve());
    const stop = createIntervalSweep(pass).start(0);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(pass).not.toHaveBeenCalled();
    expect(stop).not.toThrow();
  });

  test("RESTARTING cannot overlap a pass still in flight", async () => {
    // The latent bug the extraction closes. Both copies declared `running`
    // INSIDE `start`, so `start()` → `stop()` → `start()` built a fresh flag
    // while the first pass could still be running — and the second interval then
    // launched a concurrent pass, the one thing the flag exists to prevent. Two
    // passes overlapping means two reserved admin connections and two attempts on
    // the same transaction-scoped advisory lock.
    const gate = Promise.withResolvers<void>();
    const pass = vi.fn(() => gate.promise);
    const sweep = createIntervalSweep(pass);

    const stop = sweep.start(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pass).toHaveBeenCalledTimes(1); // in flight, and never settles below

    stop();
    sweep.start(1000);
    await vi.advanceTimersByTimeAsync(5000);

    // Still one. The pre-extraction copies reached 5 here.
    expect(pass).toHaveBeenCalledTimes(1);

    gate.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pass).toHaveBeenCalledTimes(2);
  });
});

/**
 * A REAL `NodeJS.Timeout` whose `unref` is a spy.
 *
 * A hand-built `{ unref }` does not satisfy that interface (`ref`, `hasRef`,
 * `refresh`, two well-known symbols), so standing one up means laundering it
 * past the checker — which is the cast `check:hatches` refuses, and refuses for
 * a reason that bites here: the cast stops reporting the moment the module
 * touches any OTHER member of the handle, silently. Taking a real timer and
 * replacing the one method under test needs no cast and cannot go stale.
 */
function timerWithUnrefSpy(): { timer: NodeJS.Timeout; unref: () => NodeJS.Timeout } {
  const timer = setInterval(() => undefined, 1_000_000);
  clearInterval(timer);
  const unref = vi.fn(() => timer);
  timer.unref = unref;
  return { timer, unref };
}

describe("the process must never be held up by a sweep", () => {
  test("unref()s its interval", () => {
    // Asserted through a stubbed `setInterval` rather than a real handle,
    // because that is the only place the call is observable — and it is worth
    // observing: the guest's idle controller and the replica's drain decide when
    // a process exits, and a ref'd interval outvotes both. It is also the
    // property most third-party schedulers lack, holding the loop open being
    // their purpose, so it is a load-bearing reason this module exists.
    const { timer, unref } = timerWithUnrefSpy();
    const spy = vi.spyOn(globalThis, "setInterval").mockReturnValue(timer);

    createIntervalSweep(() => Promise.resolve()).start(1000);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
