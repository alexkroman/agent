// Copyright 2026 the AAI authors. MIT license.
// Unit specs for the pipeline transport's speaking-edge tracker (including
// its idle watchdog). Exercised directly rather than through the transport so
// the timer-boundary cases stay isolated; the windows run on virtual time, so
// "short" is no longer a constraint on what a spec may describe.
// End-to-end wiring is covered by pipeline-voice-events.test.ts; the
// false-interruption recovery timer's specs live in pipeline-recovery.test.ts.

import {
  DEFAULT_FALSE_INTERRUPTION_PROMPT,
  DEFAULT_LOW_CONFIDENCE_PHRASE,
  resolveLowConfidence,
} from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "../_test-utils.ts";
import { useVirtualTime } from "./_pipeline-transport-harness.ts";
import { createGatedSpeechEdges, createSpeechEdgeTracker } from "./pipeline-speech-edges.ts";
import { createUserActivity } from "./pipeline-user-speech.ts";

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
    // Preemption is off in every spec here; the transport passes a real one.
    speculation: { onPartial: vi.fn(), onFinal: vi.fn(), onUtteranceIdle: vi.fn() },
    callbacks: {
      report: (event) => {
        if (event.type === "reply.cancelled") calls.cancelled++;
      },
    },
    silenceTimeoutMs: undefined,
    silencePrompt: undefined,
    // No confidence policy: every final commits, which is what an agent that
    // declares none gets. The band's own specs override both of these.
    lowConfidence: undefined,
    speakClarification: vi.fn(),
    resumeFalseInterruption: true,
    // The watchdog IS the resume: an armed latch fires when the speaking edge
    // goes idle. Short here, since a barge-in opens the edge and these specs
    // never commit the final that would close it.
    speechIdleTimeoutMs: 40,
    minBargeInWords: () => 2,
    interruptionMinDurationMs: () => 0,
    isTerminated: () => false,
    isSessionActive: () => true,
    isTurnInFlight: () => state.inFlight,
    isTurnDraining: () => state.draining,
    isResumeTurnInFlight: () => state.resumeInFlight,
    hasTurnSpoken: () => state.spoke,
    isPlaybackPending: () => false,
    // These specs are about barge-in CLASSIFICATION, not about filler: a turn
    // that has "spoken" here has spoken real text. The filler case has its own
    // coverage in pipeline-turn-persistence.test.ts.
    hasSpokenRecordable: () => state.spoke,
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
  test("a barge-in mid-stream resumes from the CUT POINT when one is known", async () => {
    // History's [interrupted] marker records what the model GENERATED, but TTS
    // runs behind the text, so the caller heard less than that. Resuming from
    // the marker re-speaks the gap — measured at 10% of consecutive agent
    // utterances repeating 60%+ of their words. The cut-point estimate names
    // the last words actually heard, so it wins whenever it is available.
    const { activity, calls } = makeActivity();
    activity.sttEvents.onSttPartial("stop right there");
    expect(calls.aborts).toBe(1);
    // No final ever commits — the recovery window fires the resume.
    await vi.waitFor(() => {
      expect(calls.chained).toHaveLength(1);
    });
    expect(calls.chained[0]?.text).toBe("TAIL_PROMPT");
    expect(calls.chained[0]?.isResume).toBe(true);
  });

  test("a mid-stream barge-in falls back to [interrupted] when no cut point exists", async () => {
    // Nothing audible yet, or essentially all of it heard: there is no boundary
    // to quote, and plain continuation is already the right instruction.
    const { activity, calls } = makeActivity({ tailResumePrompt: () => undefined });
    activity.sttEvents.onSttPartial("stop right there");
    expect(calls.aborts).toBe(1);
    await vi.waitFor(() => {
      expect(calls.chained).toHaveLength(1);
    });
    expect(calls.chained[0]?.text).toBe(DEFAULT_FALSE_INTERRUPTION_PROMPT);
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

// ─── The latch has no self-expiry ──────────────────────────────────────────
//
// A recovery window used to expire on its own, so a stale one was harmless.
// The latch waits for the next close of the speaking edge instead, which makes
// "every path that closes the edge either consumes or clears it" a real
// invariant rather than a description. These pin the three that exist today; a
// future path that closes the edge through none of them would fire a resume
// against an unrelated later utterance.
describe("no path leaves a stale resume armed", () => {
  /** Drive a later, unrelated noise utterance to its idle close. */
  async function laterUtteranceGoesIdle(
    activity: ReturnType<typeof createUserActivity>,
  ): Promise<void> {
    activity.sttEvents.onSttPartial("some later noise");
    await vi.advanceTimersByTimeAsync(80);
  }

  const resumes = (calls: { chained: { isResume: boolean }[] }): number =>
    calls.chained.filter((c) => c.isResume).length;

  test("a committed final consumes the latch armed by the barge-in", async () => {
    const { activity, calls } = makeActivity();
    activity.sttEvents.onSttPartial("stop right there");
    expect(calls.aborts).toBe(1);

    // The barge-in was genuine after all: the final commits.
    activity.sttEvents.onSttFinal("stop right there, cancel it.");
    await laterUtteranceGoesIdle(activity);
    expect(resumes(calls)).toBe(0);
  });

  test("the reset teardown leaves nothing armed", async () => {
    // The sequence pipeline-transport.ts's reset() runs.
    const { activity, calls } = makeActivity();
    activity.sttEvents.onSttPartial("stop right there");
    activity.recovery.onUserTurn();
    activity.speechEdges.reset();

    await laterUtteranceGoesIdle(activity);
    expect(resumes(calls)).toBe(0);
  });

  test("the stop/terminate/cancelReply teardown leaves nothing armed", async () => {
    // The sequence pipeline-transport.ts's stop(), terminate() and
    // cancelReply() all run (the first two also reset the edges).
    const { activity, calls } = makeActivity();
    activity.sttEvents.onSttPartial("stop right there");
    activity.recovery.clear();
    activity.speechEdges.reset();

    await laterUtteranceGoesIdle(activity);
    expect(resumes(calls)).toBe(0);
  });

  test("but a barge-in nobody resolved DOES resume — the control", async () => {
    // Without this the three above pass on a latch that never arms.
    const { activity, calls } = makeActivity();
    activity.sttEvents.onSttPartial("stop right there");
    await vi.waitFor(() => {
      expect(resumes(calls)).toBe(1);
    });
    // ...and exactly once: the released latch is not still armed.
    await laterUtteranceGoesIdle(activity);
    expect(resumes(calls)).toBe(1);
  });
});

// ─── The low-confidence band (AgentDef.lowConfidence) ──────────────────────

describe("low-confidence transcripts", () => {
  /** An activity whose committed transcripts and clarifications are recorded. */
  function makeBanded(overrides: Partial<ActivityDeps> = {}): {
    activity: ReturnType<typeof createUserActivity>;
    calls: ReturnType<typeof makeActivity>["calls"];
    spoken: string[];
    committed: string[];
  } {
    const spoken: string[] = [];
    const committed: string[] = [];
    const made = makeActivity({
      // Nothing is in flight: these specs are about what a FINAL does, not
      // about barging in on a reply.
      isTurnInFlight: () => false,
      hasTurnSpoken: () => false,
      hasSpokenRecordable: () => false,
      lowConfidence: resolveLowConfidence({}),
      speakClarification: (text) => spoken.push(text),
      callbacks: {
        report: (event) => {
          if (event.type === "user-transcript.committed") committed.push(event.text);
        },
      },
      ...overrides,
    });
    return { activity: made.activity, calls: made.calls, spoken, committed };
  }

  test("a confident turn commits exactly as it always did", () => {
    const { activity, calls, spoken, committed } = makeBanded();
    activity.sttEvents.onSttFinal("cancel order W two three seven", {
      transcriptConfidence: 0.9,
    });
    expect(calls.chained.map((c) => c.text)).toEqual(["cancel order W two three seven"]);
    expect(committed).toEqual(["cancel order W two three seven"]);
    expect(spoken).toEqual([]);
  });

  test("a turn the provider said nothing about commits too", () => {
    // Three of four STT providers report no per-word confidence at all, and
    // silence must never read as a bad transcript.
    const { activity, calls } = makeBanded();
    activity.sttEvents.onSttFinal("hello", {});
    activity.sttEvents.onSttFinal("hello again");
    expect(calls.chained).toHaveLength(2);
  });

  test("below the floor the words never reach the model OR the record", () => {
    const { activity, calls, spoken, committed } = makeBanded();
    activity.sttEvents.onSttFinal("shhk order double you", { transcriptConfidence: 0.05 });
    expect(calls.chained).toEqual([]);
    expect(committed).toEqual([]);
    expect(spoken).toEqual([]);
  });

  test("in the band the agent asks, and runs no turn", () => {
    const { activity, calls, spoken, committed } = makeBanded();
    activity.sttEvents.onSttFinal("order double you two three", { transcriptConfidence: 0.3 });
    expect(spoken).toEqual([DEFAULT_LOW_CONFIDENCE_PHRASE]);
    // The whole point: a transcript nobody trusts must not become a tool
    // argument, and must not be in the record as if it had been understood.
    expect(calls.chained).toEqual([]);
    expect(committed).toEqual([]);
  });

  test("`note` runs the turn, annotating the MODEL's copy only", () => {
    const { activity, calls, spoken, committed } = makeBanded({
      lowConfidence: resolveLowConfidence({ action: "note", note: "may be mis-heard" }),
    });
    activity.sttEvents.onSttFinal("cancel order W two three seven", {
      transcriptConfidence: 0.3,
    });
    expect(calls.chained[0]?.text).toBe("cancel order W two three seven\n[may be mis-heard]");
    // Verbatim on the wire: what the caller said is not ours to rewrite.
    expect(committed).toEqual(["cancel order W two three seven"]);
    expect(spoken).toEqual([]);
  });

  test("`statistic: minWord` reads the other number", () => {
    const { activity, calls, spoken } = makeBanded({
      lowConfidence: resolveLowConfidence({ statistic: "minWord" }),
    });
    // A clean sentence with one soft word: the mean is fine and the minimum
    // is in the band, which is exactly the case the two statistics differ on.
    activity.sttEvents.onSttFinal("cancel order W two three seven", {
      transcriptConfidence: 0.95,
      minWordConfidence: 0.3,
    });
    expect(spoken).toEqual([DEFAULT_LOW_CONFIDENCE_PHRASE]);
    expect(calls.chained).toEqual([]);
  });

  test("an agent that declares no policy is untouched by any of it", () => {
    const { activity, calls } = makeBanded({ lowConfidence: undefined });
    activity.sttEvents.onSttFinal("shhk order double you", { transcriptConfidence: 0.01 });
    expect(calls.chained).toHaveLength(1);
  });

  test("an empty phrase drops the turn silently", () => {
    const { activity, calls, spoken } = makeBanded({
      lowConfidence: resolveLowConfidence({ phrase: "" }),
    });
    activity.sttEvents.onSttFinal("order double you", { transcriptConfidence: 0.3 });
    expect(spoken).toEqual([]);
    expect(calls.chained).toEqual([]);
  });
});
