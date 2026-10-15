// Copyright 2026 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { drainTurns, isDraining, resetTurnDrain, trackTurnWork } from "./turn-drain.ts";
import { enterTurn } from "./turn-stream.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetTurnDrain();
});

/** Has `p` settled yet? Read after letting every queued microtask run. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  return done;
}

describe("drainTurns", () => {
  test("an idle guest drains at once and then refuses every claim", async () => {
    expect(isDraining()).toBe(false);
    await drainTurns();
    expect(isDraining()).toBe(true);
    // Held for good: no turn and no re-install can start on a drained guest.
    expect(enterTurn()).toBeNull();
  });

  test("waits for the running turn to release its claim", async () => {
    const turn = enterTurn();
    const drained = drainTurns();
    // Draining starts at once, so the turn's tab is told before it ends.
    expect(isDraining()).toBe(true);
    expect(await settled(drained)).toBe(false);
    turn?.();
    expect(await settled(drained)).toBe(true);
  });

  test("waits for tracked turn work that outlives the claim", async () => {
    // The response closes — releasing the claim — before the settle writes the
    // workspace and the conversation back to the host.
    let finishSettle: () => void = () => undefined;
    void trackTurnWork(
      new Promise<void>((resolve) => {
        finishSettle = resolve;
      }),
    );
    const drained = drainTurns();
    expect(await settled(drained)).toBe(false);
    finishSettle();
    expect(await settled(drained)).toBe(true);
  });

  test("work tracked while the first batch is awaited is waited for too", async () => {
    // The turn's own promise ends by starting its settle (chat.ts).
    let finishSettle: () => void = () => undefined;
    let finishTurn: () => void = () => undefined;
    const turn = new Promise<void>((resolve) => {
      finishTurn = resolve;
    }).then(() => {
      void trackTurnWork(
        new Promise<void>((resolve) => {
          finishSettle = resolve;
        }),
      );
    });
    void trackTurnWork(turn);
    const drained = drainTurns();
    finishTurn();
    expect(await settled(drained)).toBe(false);
    finishSettle();
    expect(await settled(drained)).toBe(true);
  });

  test("a rejected settle still ends the wait, and the caller keeps its rejection", async () => {
    const failing = trackTurnWork(Promise.reject(new Error("sync failed")));
    await expect(failing).rejects.toThrow("sync failed");
    await drainTurns();
    expect(isDraining()).toBe(true);
  });

  test("repeated drain requests join the one drain", () => {
    expect(drainTurns()).toBe(drainTurns());
  });
});
