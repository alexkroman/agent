// Copyright 2026 the AAI authors. MIT license.
// Unit specs for the pipeline transport's user-speech helpers: the speaking
// edge tracker (including its idle watchdog) and the false-interruption
// recovery timer (including its consecutive-resume budget). Exercised directly
// rather than through the transport so the timeouts can be short and the
// timer-boundary cases stay deterministic. End-to-end wiring is covered by
// pipeline-voice-events.test.ts.

import { describe, expect, test, vi } from "vitest";
import {
  createFalseInterruptionRecovery,
  createSpeechEdgeTracker,
} from "./pipeline-user-speech.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeEdgeCallbacks(): { onSpeechStarted: () => void; onSpeechStopped: () => void } {
  return { onSpeechStarted: vi.fn(), onSpeechStopped: vi.fn() };
}

describe("createSpeechEdgeTracker", () => {
  test("opens the edge once and closes it once", () => {
    const cb = makeEdgeCallbacks();
    const t = createSpeechEdgeTracker(cb, { idleTimeoutMs: 0 });

    t.speechStarted();
    t.speechStarted();
    expect(cb.onSpeechStarted).toHaveBeenCalledTimes(1);

    t.speechEnded();
    t.speechEnded();
    expect(cb.onSpeechStopped).toHaveBeenCalledTimes(1);
  });

  test("durationMs measures the open edge and is 0 once closed", async () => {
    const cb = makeEdgeCallbacks();
    const t = createSpeechEdgeTracker(cb, { idleTimeoutMs: 0 });

    expect(t.durationMs()).toBe(0);
    t.speechStarted();
    await sleep(20);
    expect(t.durationMs()).toBeGreaterThan(0);
    t.speechEnded();
    expect(t.durationMs()).toBe(0);
  });

  test("the idle watchdog closes an edge whose utterance never commits", async () => {
    const cb = makeEdgeCallbacks();
    const t = createSpeechEdgeTracker(cb, { idleTimeoutMs: 30 });

    // A noise partial opens the edge and no final ever arrives.
    t.speechStarted();
    expect(cb.onSpeechStopped).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(cb.onSpeechStopped).toHaveBeenCalledTimes(1);
    });
    // ...and the stale start time no longer inflates the duration gate.
    expect(t.durationMs()).toBe(0);
  });

  test("continued partials restart the watchdog instead of letting it fire mid-utterance", async () => {
    const cb = makeEdgeCallbacks();
    const t = createSpeechEdgeTracker(cb, { idleTimeoutMs: 50 });

    t.speechStarted();
    // Keep "speaking" across more than one watchdog window.
    for (let i = 0; i < 4; i++) {
      await sleep(25);
      t.speechStarted();
    }
    expect(cb.onSpeechStopped).not.toHaveBeenCalled();
    expect(cb.onSpeechStarted).toHaveBeenCalledTimes(1);
  });

  test("idleTimeoutMs 0 disables the watchdog", async () => {
    const cb = makeEdgeCallbacks();
    const t = createSpeechEdgeTracker(cb, { idleTimeoutMs: 0 });

    t.speechStarted();
    await sleep(40);
    expect(cb.onSpeechStopped).not.toHaveBeenCalled();
  });

  test("reset forgets the edge without emitting and cancels the watchdog", async () => {
    const cb = makeEdgeCallbacks();
    const t = createSpeechEdgeTracker(cb, { idleTimeoutMs: 20 });

    t.speechStarted();
    t.reset();
    expect(cb.onSpeechStopped).not.toHaveBeenCalled();

    await sleep(40);
    // The pending watchdog must not fire an edge event after the reset.
    expect(cb.onSpeechStopped).not.toHaveBeenCalled();
  });
});

describe("createFalseInterruptionRecovery", () => {
  function makeRecovery(over: Partial<Parameters<typeof createFalseInterruptionRecovery>[0]> = {}) {
    const onResume = vi.fn();
    const recovery = createFalseInterruptionRecovery({
      timeoutMs: 20,
      maxConsecutive: 3,
      isActive: () => true,
      isBusy: () => false,
      onResume,
      ...over,
    });
    return { recovery, onResume };
  }

  test("resumes once the window elapses", async () => {
    const { recovery, onResume } = makeRecovery();
    recovery.arm();
    expect(recovery.pending()).toBe(true);
    await vi.waitFor(() => {
      expect(onResume).toHaveBeenCalledTimes(1);
    });
    expect(recovery.pending()).toBe(false);
  });

  test("timeoutMs 0 disables recovery entirely", async () => {
    const { recovery, onResume } = makeRecovery({ timeoutMs: 0 });
    recovery.arm();
    expect(recovery.pending()).toBe(false);
    await sleep(40);
    expect(onResume).not.toHaveBeenCalled();
  });

  test("re-arming pushes the deadline out so a still-talking user isn't spoken over", async () => {
    const { recovery, onResume } = makeRecovery({ timeoutMs: 50 });
    recovery.arm();
    // Each "partial" re-arms while the window is pending.
    for (let i = 0; i < 4; i++) {
      await sleep(25);
      expect(recovery.pending()).toBe(true);
      recovery.arm();
    }
    // Total elapsed (~100 ms) is well past one window, but none elapsed fully.
    expect(onResume).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(onResume).toHaveBeenCalledTimes(1);
    });
  });

  test("clear cancels a pending window but keeps the budget", async () => {
    const { recovery, onResume } = makeRecovery();
    recovery.arm();
    recovery.clear();
    expect(recovery.pending()).toBe(false);
    await sleep(40);
    expect(onResume).not.toHaveBeenCalled();

    // Budget untouched: a later barge-in can still recover.
    recovery.arm();
    await vi.waitFor(() => {
      expect(onResume).toHaveBeenCalledTimes(1);
    });
  });

  test("caps consecutive resumes so cross-talk cannot loop forever", async () => {
    const { recovery, onResume } = makeRecovery({ maxConsecutive: 3 });

    // Simulate persistent noise: every resume is followed by another barge-in
    // that never commits a user turn.
    for (let i = 0; i < 6; i++) {
      recovery.arm();
      await sleep(40);
    }
    expect(onResume).toHaveBeenCalledTimes(3);
    // Budget spent — arming is now inert.
    expect(recovery.pending()).toBe(false);
  });

  test("a committed user turn restores the budget", async () => {
    const { recovery, onResume } = makeRecovery({ maxConsecutive: 1 });

    recovery.arm();
    await vi.waitFor(() => {
      expect(onResume).toHaveBeenCalledTimes(1);
    });

    // Spent: no further resume.
    recovery.arm();
    await sleep(40);
    expect(onResume).toHaveBeenCalledTimes(1);

    // The user speaks for real → budget restored.
    recovery.onUserTurn();
    recovery.arm();
    await vi.waitFor(() => {
      expect(onResume).toHaveBeenCalledTimes(2);
    });
  });

  test("a fired window is dropped when the transport went inactive or busy", async () => {
    const inactive = makeRecovery({ isActive: () => false });
    inactive.recovery.arm();
    await sleep(40);
    expect(inactive.onResume).not.toHaveBeenCalled();

    const busy = makeRecovery({ isBusy: () => true });
    busy.recovery.arm();
    await sleep(40);
    expect(busy.onResume).not.toHaveBeenCalled();
  });
});
