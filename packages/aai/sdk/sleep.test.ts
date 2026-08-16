// Copyright 2026 the AAI authors. MIT license.
import { afterEach, expect, test, vi } from "vitest";
import { sleep } from "./sleep.ts";

afterEach(() => {
  vi.useRealTimers();
});

test("resolves after the delay and not before", async () => {
  vi.useFakeTimers();
  const done = vi.fn();
  void sleep(1000).then(done);
  await vi.advanceTimersByTimeAsync(999);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(done).toHaveBeenCalledOnce();
});

/**
 * The whole reason this uses the GLOBAL `setTimeout`. `node:timers/promises` is
 * invisible to `vi.useFakeTimers()` under this repo's config — measured, and the
 * finding the module doc is about — so a poll loop spelled that way can only be
 * tested by waiting out real milliseconds. This is the assertion that fails if
 * someone "simplifies" the implementation to Node's own timer promise.
 */
test("is driven by virtual time, not the wall clock", async () => {
  vi.useFakeTimers();
  const done = vi.fn();
  void sleep(60 * 60 * 1000).then(done);
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(done).toHaveBeenCalledOnce();
});

test("an abort resolves rather than rejecting", async () => {
  const ctl = new AbortController();
  const waited = sleep(60_000, { signal: ctl.signal });
  ctl.abort();
  await expect(waited).resolves.toBeUndefined();
});

/**
 * Settling under a frozen clock is the proof no timer had to fire — asserted
 * that way rather than by spying on `globalThis.setTimeout`, which cannot be
 * restored cleanly once fake timers have replaced it (`restoreMocks` puts the
 * fake back and the next test's real timer is gone).
 */
test("an already-aborted signal resolves without arming a timer", async () => {
  vi.useFakeTimers();
  await expect(sleep(60_000, { signal: AbortSignal.abort() })).resolves.toBeUndefined();
});

/**
 * The property dbos's `interruptibleSleep` doc is about, and the one
 * `host/_fake-llm.ts`'s `delayOrAbort` did not have: called in a loop against a
 * long-lived signal, a version that only ever attaches retains one closure per
 * iteration. Asserted on the signal's own bookkeeping, which is the observable
 * half of "retains nothing".
 */
test("detaches its abort listener when the timer wins", async () => {
  vi.useFakeTimers();
  const ctl = new AbortController();
  const detach = vi.spyOn(ctl.signal, "removeEventListener");
  const waited = sleep(10, { signal: ctl.signal });
  await vi.advanceTimersByTimeAsync(10);
  await waited;
  expect(detach).toHaveBeenCalledWith("abort", expect.any(Function));
});

/**
 * The other half of the test above, and the one it cannot state: with no signal
 * there is no `removeEventListener` to observe, so the claim has to be made
 * about ATTACHMENT. Spied on `EventTarget.prototype` rather than on an instance
 * — the point is that no target is reached at all — and asserted around the
 * whole wait, so an `addEventListener` on an internally-minted controller would
 * be caught too.
 */
test("attaches no listener at all without a signal", async () => {
  vi.useFakeTimers();
  const attach = vi.spyOn(EventTarget.prototype, "addEventListener");
  const done = vi.fn();
  void sleep(10).then(done);
  await vi.advanceTimersByTimeAsync(10);
  expect(done).toHaveBeenCalledOnce();
  expect(attach).not.toHaveBeenCalled();
});

/**
 * Real timers on purpose: this observes a METHOD CALL, not the passage of time,
 * and the prototype spy is the one seam that can see a synchronous `unref()` on
 * a timer the caller never gets a handle to. Both waits are 1ms.
 */
test("unref is opt-in — the default leaves the timer referenced", async () => {
  const probe = setTimeout(() => undefined, 0);
  clearTimeout(probe);
  const unref = vi.spyOn(Object.getPrototypeOf(probe) as { unref: () => unknown }, "unref");

  const referenced = sleep(1);
  expect(unref).not.toHaveBeenCalled();
  const unreferenced = sleep(1, { unref: true });
  expect(unref).toHaveBeenCalledOnce();

  await Promise.all([referenced, unreferenced]);
});
