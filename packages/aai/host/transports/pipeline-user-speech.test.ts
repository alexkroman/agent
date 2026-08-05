// Copyright 2026 the AAI authors. MIT license.
// Unit specs for the pipeline transport's speaking-edge tracker (including
// its idle watchdog). Exercised directly rather than through the transport so
// the timeouts can be short and the timer-boundary cases stay deterministic.
// End-to-end wiring is covered by pipeline-voice-events.test.ts; the
// false-interruption recovery timer's specs live in pipeline-recovery.test.ts.

import { describe, expect, test, vi } from "vitest";
import { DEFAULT_FALSE_INTERRUPTION_PROMPT } from "../../sdk/constants.ts";
import { silentLogger, sleep } from "../_test-utils.ts";
import { createSpeechEdgeTracker, createUserActivity } from "./pipeline-user-speech.ts";

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

// ─── Barge-in classification + resume mooting (createUserActivity) ─────────

type ActivityDeps = Parameters<typeof createUserActivity>[0];

function makeActivity(overrides: Partial<ActivityDeps> = {}): {
  activity: ReturnType<typeof createUserActivity>;
  calls: { aborts: number; cancelled: number; chained: { text: string; isResume: boolean }[] };
  state: { inFlight: boolean; draining: boolean; resumeInFlight: boolean; spoke: boolean };
} {
  const calls = {
    aborts: 0,
    cancelled: 0,
    chained: [] as { text: string; isResume: boolean }[],
  };
  const state = { inFlight: true, draining: false, resumeInFlight: false, spoke: true };
  const deps: ActivityDeps = {
    log: silentLogger,
    sid: "t",
    callbacks: {
      onCancelled: () => {
        calls.cancelled++;
      },
      onUserTranscript: vi.fn(),
      onUserTranscriptPartial: vi.fn(),
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
    },
    silenceTimeoutMs: undefined,
    silencePrompt: undefined,
    falseInterruptionTimeoutMs: 20,
    // The resume is deferred until the speaking edge closes, so the watchdog is
    // what releases it — short here, since a barge-in opens the edge and these
    // specs never commit the final that would close it.
    speechIdleTimeoutMs: 40,
    minBargeInWords: 2,
    interruptionMinDurationMs: 0,
    isTerminated: () => false,
    isSessionActive: () => true,
    isTurnInFlight: () => state.inFlight,
    isTurnDraining: () => state.draining,
    isResumeTurnInFlight: () => state.resumeInFlight,
    hasTurnSpoken: () => state.spoke,
    isPlaybackPending: () => false,
    abortInFlightTurn: () => {
      calls.aborts++;
      state.inFlight = false;
      state.resumeInFlight = false;
      state.spoke = false;
    },
    tailResumePrompt: () => "TAIL_PROMPT",
    runChainedTurn: (text, _label, kind) => {
      calls.chained.push({ text, isResume: kind?.isResume === true });
    },
    ...overrides,
  };
  return { activity: createUserActivity(deps), calls, state };
}

describe("barge-in recovery classification", () => {
  test("a barge-in mid-stream arms the [interrupted] continuation prompt", async () => {
    const { activity, calls } = makeActivity();
    activity.sttEvents.onSttPartial("stop right there");
    expect(calls.aborts).toBe(1);
    // No final ever commits — the recovery window fires the resume.
    await vi.waitFor(() => {
      expect(calls.chained).toHaveLength(1);
    });
    expect(calls.chained[0]?.text).toBe(DEFAULT_FALSE_INTERRUPTION_PROMPT);
    expect(calls.chained[0]?.isResume).toBe(true);
  });

  test("a barge-in during the TTS drain arms the cut-point prompt, not [interrupted]", async () => {
    // The turn controller stays non-null through the drain, but the turn's
    // FULL text is already persisted with no [interrupted] marker — resuming
    // from the marker makes the model repeat or ramble past its own ending.
    const { activity, calls, state } = makeActivity();
    state.draining = true;
    activity.sttEvents.onSttPartial("stop right there");
    expect(calls.aborts).toBe(1);
    await vi.waitFor(() => {
      expect(calls.chained).toHaveLength(1);
    });
    expect(calls.chained[0]?.text).toBe("TAIL_PROMPT");
  });
});

describe("resume mooted by a committed user turn", () => {
  test("a final landing after the resume fired aborts the still-silent resume turn", () => {
    // Short utterances can produce a final with no preceding partial; the
    // recovery timer may have fired first and its resume turn already be in
    // flight. The final proves the interruption was genuine — the unspoken
    // resume must die, or the agent speaks a full continuation of the
    // interrupted reply before answering the user.
    const { activity, calls, state } = makeActivity();
    state.inFlight = true;
    state.resumeInFlight = true;
    state.spoke = false;
    activity.sttEvents.onSttFinal("what about tuesday");
    expect(calls.aborts).toBe(1);
    expect(calls.cancelled).toBe(1);
    // The user's turn still commits and runs.
    expect(calls.chained).toEqual([{ text: "what about tuesday", isResume: false }]);
  });

  test("a resume that already spoke is handled by the ordinary barge-in rules", () => {
    const { activity, calls, state } = makeActivity();
    state.inFlight = true;
    state.resumeInFlight = true;
    state.spoke = true; // audibly resuming
    activity.sttEvents.onSttFinal("what about tuesday");
    // Aborted via the agentIsSpeaking() barge-in path (>= minBargeInWords).
    expect(calls.aborts).toBe(1);
    expect(calls.chained).toEqual([{ text: "what about tuesday", isResume: false }]);
  });
});
