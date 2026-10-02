// Copyright 2026 the AAI authors. MIT license.
// Unit specs for the pipeline transport's speaking-edge tracker (including
// its idle watchdog) and the outward edge gate. Exercised directly rather than
// through the transport so the timer-boundary cases stay isolated; the windows
// run on virtual time, so "short" is no longer a constraint on what a spec may
// describe. End-to-end wiring is covered by pipeline-voice-events.test.ts.
//
// Moved out of `user-speech.test.ts`, which keeps `createUserActivity`.

import { describe, expect, test, vi } from "vitest";
import { useVirtualTime } from "../../_pipeline-transport-harness.ts";
import { createGatedSpeechEdges, createSpeechEdgeTracker } from "./edges.ts";

function makeEdgeCallbacks(): { onSpeechStarted: () => void; onSpeechStopped: () => void } {
  return { onSpeechStarted: vi.fn(), onSpeechStopped: vi.fn() };
}

useVirtualTime();

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
    await vi.advanceTimersByTimeAsync(20);
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
    // This is the SINGLE home of the not-resumed-over property. The recovery
    // latch has no deadline of its own, so a user who barges in and keeps
    // talking is held off by exactly one mechanism: every partial restarts
    // this watchdog, and only the watchdog fires `onIdle`. (It used to be two
    // mechanisms writing the same rule twice — the recovery window re-armed on
    // continued partials as well, and never governed the wait.)
    const cb = makeEdgeCallbacks();
    const onIdle = vi.fn();
    const t = createSpeechEdgeTracker(cb, { idleTimeoutMs: 50, onIdle });

    t.speechStarted();
    // Keep "speaking" across more than one watchdog window.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(25);
      t.speechStarted();
    }
    expect(cb.onSpeechStopped).not.toHaveBeenCalled();
    expect(cb.onSpeechStarted).toHaveBeenCalledTimes(1);
    // ...and no resume could have fired over them.
    expect(onIdle).not.toHaveBeenCalled();

    // Once they stop, it does.
    await vi.waitFor(() => {
      expect(onIdle).toHaveBeenCalledTimes(1);
    });
  });

  test("idleTimeoutMs 0 disables the watchdog", async () => {
    const cb = makeEdgeCallbacks();
    const t = createSpeechEdgeTracker(cb, { idleTimeoutMs: 0 });

    t.speechStarted();
    await vi.advanceTimersByTimeAsync(40);
    expect(cb.onSpeechStopped).not.toHaveBeenCalled();
  });

  test("reset forgets the edge without emitting and cancels the watchdog", async () => {
    const cb = makeEdgeCallbacks();
    const t = createSpeechEdgeTracker(cb, { idleTimeoutMs: 20 });

    t.speechStarted();
    t.reset();
    expect(cb.onSpeechStopped).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(40);
    // The pending watchdog must not fire an edge event after the reset.
    expect(cb.onSpeechStopped).not.toHaveBeenCalled();
  });
});

describe("createGatedSpeechEdges", () => {
  function makeGate(agentIsSpeaking: () => boolean) {
    const report = vi.fn();
    return { report, gate: createGatedSpeechEdges({ report, agentIsSpeaking }) };
  }

  /** The wire event types reported so far, in order. */
  function reported(report: ReturnType<typeof vi.fn>): string[] {
    return report.mock.calls.map(([event]) => (event as { type: string }).type);
  }

  test("passes the edge straight through while the agent is silent", () => {
    const { report, gate } = makeGate(() => false);

    gate.onSpeechStarted();
    gate.onSpeechStopped();

    expect(reported(report)).toEqual(["speech.started", "speech.stopped"]);
  });

  test("holds the edge back while the agent has the floor, and release emits it", () => {
    const { report, gate } = makeGate(() => true);

    gate.onSpeechStarted();
    expect(report).not.toHaveBeenCalled();

    gate.release();
    expect(reported(report)).toEqual(["speech.started"]);
  });

  test("a held edge that never releases produces no stop either", () => {
    const { report, gate } = makeGate(() => true);

    gate.onSpeechStarted();
    gate.onSpeechStopped();

    // An unpaired `speech_stopped` is as confusing as the premature start the
    // gate exists to prevent, so a held edge closes silently.
    expect(report).not.toHaveBeenCalled();
  });

  test("release is a no-op when nothing is held", () => {
    const { report, gate } = makeGate(() => false);

    gate.release();
    expect(report).not.toHaveBeenCalled();

    gate.onSpeechStarted();
    gate.release();
    // Already told: releasing again must not repeat the start.
    expect(reported(report)).toEqual(["speech.started"]);
  });

  test("a second start on an already-emitted edge does not repeat it", () => {
    let speaking = false;
    const { report, gate } = makeGate(() => speaking);

    gate.onSpeechStarted();
    // The agent takes the floor mid-utterance; the tracker re-reports the open
    // edge. The pair of booleans this replaced set `held` on top of `emitted`
    // here, so the next release emitted a duplicate `speech_started`.
    speaking = true;
    gate.onSpeechStarted();
    gate.release();

    expect(reported(report)).toEqual(["speech.started"]);
  });

  test("a re-report of a held edge releases it once the agent goes quiet", () => {
    let speaking = true;
    const { report, gate } = makeGate(() => speaking);

    gate.onSpeechStarted();
    expect(report).not.toHaveBeenCalled();

    speaking = false;
    gate.onSpeechStarted();
    expect(reported(report)).toEqual(["speech.started"]);
  });

  test("reset forgets a held edge, so a later release emits nothing", () => {
    const { report, gate } = makeGate(() => true);

    gate.onSpeechStarted();
    gate.reset();
    gate.release();

    expect(report).not.toHaveBeenCalled();
  });

  test("reset forgets an emitted edge without reporting a stop", () => {
    const { report, gate } = makeGate(() => false);

    gate.onSpeechStarted();
    gate.reset();
    gate.onSpeechStopped();

    expect(reported(report)).toEqual(["speech.started"]);
  });

  test("the tracker's reset propagates to the gate", () => {
    const report = vi.fn();
    const gate = createGatedSpeechEdges({ report, agentIsSpeaking: () => true });
    const tracker = createSpeechEdgeTracker(gate, { idleTimeoutMs: 0 });

    tracker.speechStarted();
    tracker.reset();
    // The utterance the gate was holding is gone, so nothing may release it.
    gate.release();

    expect(report).not.toHaveBeenCalled();
  });
});
