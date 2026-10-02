// Copyright 2026 the AAI authors. MIT license.
/**
 * The grace-window sweep: a session's state is reclaimed once
 * `SESSION_RESUME_GRACE_MS` passes with no resume, and a resume, a reschedule
 * or a shutdown cancels the pending one. Virtual time throughout.
 */

import { SESSION_RESUME_GRACE_MS } from "@alexkroman1/aai/host-internal";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMemoryStateBackend } from "./backends/memory.ts";
import { createSessionStateStore } from "./store.ts";
import { createStateSweeps } from "./sweeps.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const store = createSessionStateStore({ backend: createMemoryStateBackend() });
  const discard = vi.spyOn(store, "discard");
  return { sweeps: createStateSweeps(store), discard };
}

describe("createStateSweeps", () => {
  test("discards the session once the grace window passes, and not before", async () => {
    const { sweeps, discard } = setup();
    sweeps.schedule("s1");
    await vi.advanceTimersByTimeAsync(SESSION_RESUME_GRACE_MS - 1);
    expect(discard).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(discard).toHaveBeenCalledExactlyOnceWith("s1");
  });

  test("a resume cancels the pending sweep", async () => {
    const { sweeps, discard } = setup();
    sweeps.schedule("s1");
    sweeps.cancel("s1");
    sweeps.cancel("never-scheduled");
    await vi.advanceTimersByTimeAsync(SESSION_RESUME_GRACE_MS);
    expect(discard).not.toHaveBeenCalled();
  });

  test("rescheduling restarts the window rather than sweeping twice", async () => {
    const { sweeps, discard } = setup();
    sweeps.schedule("s1");
    await vi.advanceTimersByTimeAsync(SESSION_RESUME_GRACE_MS / 2);
    sweeps.schedule("s1");
    await vi.advanceTimersByTimeAsync(SESSION_RESUME_GRACE_MS / 2);
    expect(discard).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SESSION_RESUME_GRACE_MS);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  test("clear drops every pending sweep", async () => {
    const { sweeps, discard } = setup();
    sweeps.schedule("a");
    sweeps.schedule("b");
    sweeps.clear();
    await vi.advanceTimersByTimeAsync(SESSION_RESUME_GRACE_MS);
    expect(discard).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
