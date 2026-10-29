// Copyright 2026 the AAI authors. MIT license.
/**
 * The handlers driven DIRECTLY, with every collaborator a stub.
 *
 * `user-speech.test.ts` drives the same code through
 * `createUserActivity` and owns the cases that need the real recovery latch
 * and the real speaking edges (barge-in classification, the resume window, the
 * low-confidence band). What is here is the handlers' own contract at the
 * seam: which calls a transcript produces, and the two early returns that
 * decide whether any of it happens.
 */

import { describe, expect, test, vi } from "vitest";
import { makeLogger, silentLogger } from "../../../_logger-test-utils.ts";
import { buildCutNote, createFalseInterruptionRecovery } from "../heard/index.ts";
import { AUTO_TURN_DETECTION } from "./manual-turn.ts";
import { createSttEventHandlers } from "./stt-handlers.ts";
import { NO_USER_TURN_LIMIT } from "./user-turn-limit.ts";

type Handlers = ReturnType<typeof createSttEventHandlers>;
type Deps = Parameters<typeof createSttEventHandlers>[0];

function makeHandlers(overrides: Partial<Deps> = {}): {
  handlers: Handlers;
  committed: { text: string; note?: string }[];
  edges: { started: number; ended: number };
  reported: string[];
} {
  const committed: { text: string; note?: string }[] = [];
  const edges = { started: 0, ended: 0 };
  const reported: string[] = [];
  const speechEdges = {
    speechStarted: () => {
      edges.started += 1;
    },
    speechEnded: () => {
      edges.ended += 1;
    },
    durationMs: () => 0,
    reset: vi.fn(),
  };
  const deps: Deps = {
    isTerminated: () => false,
    isTurnInFlight: () => false,
    isTurnDraining: () => false,
    isResumeTurnInFlight: () => false,
    hasTurnSpoken: () => false,
    agentIsSpeaking: () => false,
    audioOnLine: () => false,
    utteranceOpenedOverSpeech: () => false,
    utteranceOpenedOverAudio: () => false,
    hasSpokenRecordable: () => false,
    abortInFlightTurn: vi.fn(),
    tailResumePrompt: () => undefined,
    cutAnchor: () => undefined,
    speechEdges,
    edgeGate: {
      release: vi.fn(),
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
      reset: vi.fn(),
    },
    recovery: {
      arm: vi.fn(),
      noteCut: vi.fn(),
      clear: vi.fn(),
      onUtteranceEnded: vi.fn(),
      onUserTurn: vi.fn(),
    },
    nudger: { arm: vi.fn(), clear: vi.fn(), onUserSpeech: vi.fn(), onUserTurn: vi.fn() },
    callbacks: { report: (event) => reported.push(event.type) },
    commitUserTurn: (text, note) => committed.push(note === undefined ? { text } : { text, note }),
    speculation: { onPartial: vi.fn(), onFinal: vi.fn(), onUtteranceIdle: vi.fn() },
    minBargeInWords: () => 2,
    interruptionMinDurationMs: () => 0,
    continuationWindowMs: () => 0,
    // Both phrase lists EMPTY, which leaves the two thresholds in sole charge —
    // the behaviour these specs were written against, before the lists existed.
    // The lists' own cases live in `user-speech.test.ts`, which drives
    // the shipped defaults through `createUserActivity`.
    onInterrupted: vi.fn(),
    // No cap on a user turn — the shipped default. The cap's own cases live in
    // `user-turn-limit.test.ts` and drive it through the transport.
    turnLimit: NO_USER_TURN_LIMIT,
    // The transcriber ends each turn — the shipped default. Push-to-talk's own
    // cases live in `manual-turn.test.ts`.
    manualTurn: AUTO_TURN_DETECTION,
    log: silentLogger,
    sid: "s1",
    ...overrides,
  };
  return { handlers: createSttEventHandlers(deps), committed, edges, reported };
}

describe("onSttFinal", () => {
  test("commits the trimmed transcript and closes the speaking edge", () => {
    const { handlers, committed, edges, reported } = makeHandlers();
    handlers.onSttFinal("  cancel my order  ");
    expect(committed).toEqual([{ text: "cancel my order" }]);
    expect(edges).toEqual({ started: 1, ended: 1 });
    // The edge is opened even with no preceding partial: short utterances on
    // some providers arrive as a final and nothing else.
    expect(reported).toEqual([]);
  });

  test("an empty or whitespace-only final does nothing at all", () => {
    const { handlers, committed, edges } = makeHandlers();
    handlers.onSttFinal("");
    handlers.onSttFinal("   ");
    expect(committed).toEqual([]);
    expect(edges).toEqual({ started: 0, ended: 0 });
  });

  test("a terminated transport drops every inbound event", () => {
    const { handlers, committed, edges } = makeHandlers({ isTerminated: () => true });
    handlers.onSttFinal("cancel my order");
    handlers.onSttPartial("cancel my");
    expect(committed).toEqual([]);
    expect(edges).toEqual({ started: 0, ended: 0 });
  });
});

describe("onSttPartial", () => {
  test("a non-empty interim opens the edge and publishes a caption", () => {
    const { handlers, edges, reported } = makeHandlers();
    handlers.onSttPartial("cancel my");
    expect(edges.started).toBe(1);
    expect(reported).toEqual(["userTranscript.updated"]);
  });

  test("an empty interim publishes nothing and opens no edge", () => {
    const { handlers, edges, reported } = makeHandlers();
    handlers.onSttPartial("   ");
    expect(edges.started).toBe(0);
    expect(reported).toEqual([]);
  });

  test("the end-of-turn confidence rides out on the caption event", () => {
    const events: unknown[] = [];
    const { handlers } = makeHandlers({ callbacks: { report: (event) => events.push(event) } });
    handlers.onSttPartial("cancel my", { endOfTurnConfidence: 0.4 });
    expect(events).toEqual([
      { type: "userTranscript.updated", text: "cancel my", eotConfidence: 0.4 },
    ]);
  });

  test("and is OMITTED rather than nulled when the provider says nothing", () => {
    const events: unknown[] = [];
    const { handlers } = makeHandlers({ callbacks: { report: (event) => events.push(event) } });
    handlers.onSttPartial("cancel my");
    expect(events).toEqual([{ type: "userTranscript.updated", text: "cancel my" }]);
  });
});

/**
 * The relative-level veto, at the handlers' seam. The shape it was written
 * for: a television behind the caller, transcribed and barging in on the
 * reply — its loudest audio about 18 dB under anything the caller said.
 */
describe("the relative-level veto", () => {
  const CALLER = -16;
  const BACKGROUND = -34;

  function makeVetoHandlers() {
    // `thinking`: a turn in flight that has put nothing on the line yet.
    const state = { speaking: false, thinking: false };
    const log = makeLogger();
    const abortInFlightTurn = vi.fn();
    const made = makeHandlers({
      isTurnInFlight: () => state.speaking || state.thinking,
      hasTurnSpoken: () => state.speaking,
      agentIsSpeaking: () => state.speaking,
      audioOnLine: () => state.speaking,
      utteranceOpenedOverSpeech: () => state.speaking,
      abortInFlightTurn,
      log,
    });
    const infoLines = (message: string) =>
      log.info.mock.calls.filter(([m]) => m === message).map(([, fields]) => fields);
    return { ...made, state, log, abortInFlightTurn, infoLines };
  }

  /** Two caller turns committed into silence: the reference is established. */
  function establish(h: ReturnType<typeof makeVetoHandlers>): void {
    h.handlers.onSttFinal("my order number is four", { inputPeakDbfs: CALLER });
    h.handlers.onSttFinal("it came yesterday", { inputPeakDbfs: CALLER });
    h.committed.length = 0;
  }

  test("a quiet interim cannot barge in, and the veto is logged once per utterance", () => {
    const h = makeVetoHandlers();
    establish(h);
    h.state.speaking = true;
    h.handlers.onSttPartial("police stopped", { inputPeakDbfs: BACKGROUND });
    h.handlers.onSttPartial("police stopped him", { inputPeakDbfs: BACKGROUND });
    expect(h.abortInFlightTurn).not.toHaveBeenCalled();
    expect(h.reported).not.toContain("reply.cancelled");
    expect(h.infoLines("Pipeline barge-in vetoed (quiet)")).toEqual([
      { sid: "s1", peakDb: BACKGROUND, refDb: CALLER, text: "police stopped" },
    ]);
  });

  test("a loud interim still barges in, and says how loud it was", () => {
    const h = makeVetoHandlers();
    establish(h);
    h.state.speaking = true;
    h.handlers.onSttPartial("wait no", { inputPeakDbfs: -18 });
    expect(h.abortInFlightTurn).toHaveBeenCalledOnce();
    expect(h.reported).toContain("reply.cancelled");
    expect(h.infoLines("Pipeline barge-in")).toEqual([
      expect.objectContaining({ sid: "s1", peakDb: -18, refDb: CALLER }),
    ]);
  });

  test("a quiet final while the agent speaks is not a turn and does not interrupt", () => {
    const h = makeVetoHandlers();
    establish(h);
    const endedBefore = h.edges.ended;
    h.state.speaking = true;
    h.handlers.onSttFinal("was the driver of that vehicle", { inputPeakDbfs: BACKGROUND });
    expect(h.committed).toEqual([]);
    expect(h.abortInFlightTurn).not.toHaveBeenCalled();
    // The edge is left to the idle watchdog, as for any utterance with no turn.
    expect(h.edges.ended).toBe(endedBefore);
    expect(h.infoLines("Pipeline quiet final dropped")).toEqual([
      { sid: "s1", peakDb: BACKGROUND, refDb: CALLER, text: "was the driver of that vehicle" },
    ]);
  });

  test("a quiet final while a reply is only being prepared still commits (chained, not lost)", () => {
    const h = makeVetoHandlers();
    establish(h);
    h.state.thinking = true;
    h.handlers.onSttFinal("hello are you still there", { inputPeakDbfs: BACKGROUND });
    expect(h.committed).toEqual([{ text: "hello are you still there" }]);
    expect(h.abortInFlightTurn).not.toHaveBeenCalled();
    expect(h.infoLines("Pipeline quiet final dropped")).toEqual([]);
  });

  test("a quiet final into a silent agent still commits, as it always has", () => {
    const h = makeVetoHandlers();
    establish(h);
    h.handlers.onSttFinal("mm-hmm", { inputPeakDbfs: BACKGROUND });
    expect(h.committed).toEqual([{ text: "mm-hmm" }]);
    expect(h.infoLines("Pipeline committed turn level").at(-1)).toEqual({
      sid: "s1",
      peakDb: BACKGROUND,
      refDb: CALLER,
    });
  });

  test("fails open before a reference exists and without a measured peak", () => {
    const h = makeVetoHandlers();
    h.handlers.onSttFinal("hello", { inputPeakDbfs: CALLER });
    h.state.speaking = true;
    // One committed utterance is not a reference yet.
    h.handlers.onSttPartial("police stopped him", { inputPeakDbfs: BACKGROUND });
    expect(h.abortInFlightTurn).toHaveBeenCalledOnce();

    const later = makeVetoHandlers();
    establish(later);
    later.state.speaking = true;
    later.handlers.onSttPartial("police stopped him");
    later.handlers.onSttFinal("police stopped him there");
    expect(later.abortInFlightTurn).toHaveBeenCalledTimes(2);
    expect(later.committed).toEqual([{ text: "police stopped him there" }]);
  });

  test("vetoed and quiet utterances never move the reference", () => {
    const h = makeVetoHandlers();
    establish(h);
    for (let i = 0; i < 10; i++) {
      h.state.speaking = true;
      h.handlers.onSttFinal("breaking news tonight", { inputPeakDbfs: BACKGROUND });
      h.state.speaking = false;
      h.handlers.onSttFinal("more at eleven", { inputPeakDbfs: BACKGROUND });
    }
    h.state.speaking = true;
    h.handlers.onSttPartial("police stopped him", { inputPeakDbfs: BACKGROUND });
    expect(h.abortInFlightTurn).not.toHaveBeenCalled();
    expect(h.infoLines("Pipeline barge-in vetoed (quiet)").at(-1)).toMatchObject({
      refDb: CALLER,
    });
  });
});

describe("a brief final over agent speech is an acknowledgement, not a turn", () => {
  const GATE = 500;

  function makeBriefHandlers(overrides: Partial<Deps> = {}) {
    const state = { speaking: true };
    const log = makeLogger();
    const abortInFlightTurn = vi.fn();
    const made = makeHandlers({
      isTurnInFlight: () => state.speaking,
      hasTurnSpoken: () => state.speaking,
      agentIsSpeaking: () => state.speaking,
      audioOnLine: () => state.speaking,
      utteranceOpenedOverSpeech: () => state.speaking,
      minBargeInWords: () => 1,
      interruptionMinDurationMs: () => GATE,
      abortInFlightTurn,
      log,
      ...overrides,
    });
    return { ...made, state, log, abortInFlightTurn };
  }

  test("an 'uh-huh' over the agent neither cuts the reply nor commits", () => {
    const h = makeBriefHandlers();
    h.handlers.onSttFinal("Uh-huh.", { spokenMs: 320 });
    expect(h.committed).toEqual([]);
    expect(h.abortInFlightTurn).not.toHaveBeenCalled();
    expect(h.reported).not.toContain("reply.cancelled");
    // The edge is left to the idle watchdog, as for any utterance with no turn.
    expect(h.edges.ended).toBe(0);
    expect(
      h.log.info.mock.calls.filter(([m]) => m === "Pipeline brief final dropped"),
    ).toHaveLength(1);
  });

  test("an utterance as long as the gate still takes the floor", () => {
    const h = makeBriefHandlers();
    h.handlers.onSttFinal("no wait", { spokenMs: GATE });
    expect(h.committed).toEqual([{ text: "no wait" }]);
    expect(h.abortInFlightTurn).toHaveBeenCalledOnce();
    expect(h.reported).toContain("reply.cancelled");
  });

  test("a short answer given after the agent stopped still commits", () => {
    const h = makeBriefHandlers();
    h.state.speaking = false;
    h.handlers.onSttFinal("Yes.", { spokenMs: 250 });
    expect(h.committed).toEqual([{ text: "Yes." }]);
  });

  /**
   * The hotel template's case: the agent spells an email back and asks "is
   * that right?", the caller says "Yes." over the closing word, and the final
   * lands once the reply has finished playing. The utterance OPENED over
   * speech; the agent has no floor left by the time the final arrives.
   */
  function makeTailHandlers() {
    const flags: (boolean | undefined)[] = [];
    const log = makeLogger();
    const made = makeHandlers({
      utteranceOpenedOverSpeech: () => true,
      utteranceOpenedOverAudio: () => true,
      agentIsSpeaking: () => false,
      audioOnLine: () => false,
      minBargeInWords: () => 1,
      interruptionMinDurationMs: () => GATE,
      commitUserTurn: (text, _note, _meta, b) => {
        made.committed.push({ text });
        flags.push(b);
      },
      log,
    });
    return { ...made, flags, log };
  }

  test("a brief final that began over the agent but lands after it stopped is the answer", () => {
    const h = makeTailHandlers();
    h.handlers.onSttFinal("Yes.", { spokenMs: 250 });
    expect(h.committed).toEqual([{ text: "Yes." }]);
    expect(h.edges.ended).toBe(1);
    expect(h.log.info.mock.calls.filter(([m]) => m === "Pipeline brief final dropped")).toEqual([]);
    // Still a backchannel to the write gate: it opened over the agent and is brief.
    expect(h.flags).toEqual([true]);
  });

  test("an acknowledgement is dropped only while the reply it acknowledges still plays", () => {
    const playing = makeBriefHandlers();
    playing.handlers.onSttFinal("Yes.");
    expect(playing.committed).toEqual([]);
    expect(
      playing.log.info.mock.calls.filter(([m]) => m === "Pipeline acknowledgement dropped"),
    ).toHaveLength(1);

    const ended = makeTailHandlers();
    ended.handlers.onSttFinal("Yes.");
    expect(ended.committed).toEqual([{ text: "Yes." }]);
    expect(
      ended.log.info.mock.calls.filter(([m]) => m === "Pipeline acknowledgement dropped"),
    ).toEqual([]);
    expect(ended.flags).toEqual([true]);
  });

  // "Stop." rather than an "uh-huh": a short final that is NOT an
  // acknowledgement, so these exercise the duration gate alone
  // (`dropsAcknowledgementFinal` would drop an "uh-huh" on its words).
  test("fails open without word timings", () => {
    const h = makeBriefHandlers();
    h.handlers.onSttFinal("Stop.");
    expect(h.committed).toEqual([{ text: "Stop." }]);
  });

  test("a gate of 0 disables it", () => {
    const h = makeBriefHandlers({ interruptionMinDurationMs: () => 0 });
    h.handlers.onSttFinal("Stop.", { spokenMs: 320 });
    expect(h.committed).toEqual([{ text: "Stop." }]);
  });
});

describe("continuation: the caller resumes right after a commit", () => {
  /**
   * Handlers whose speaking edge opens on the first partial and reports the
   * real time since then, on a fixed clock — the gate reads the utterance's
   * OPENING, so the stub's usual constant 0 cannot express "opened 1s after
   * the commit".
   */
  function resumable(overrides: Partial<Deps> = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    let openedAt: number | undefined;
    const abort = vi.fn();
    const arm = vi.fn();
    const made = makeHandlers({
      continuationWindowMs: () => 2500,
      isTurnInFlight: () => true,
      abortInFlightTurn: abort,
      recovery: {
        arm,
        noteCut: vi.fn(),
        clear: vi.fn(),
        onUtteranceEnded: vi.fn(),
        onUserTurn: vi.fn(),
      },
      speechEdges: {
        speechStarted: () => {
          openedAt ??= Date.now();
        },
        speechEnded: () => {
          openedAt = undefined;
        },
        durationMs: () => (openedAt === undefined ? 0 : Date.now() - openedAt),
        reset: vi.fn(),
      },
      ...overrides,
    });
    const at = (ms: number) => vi.setSystemTime(ms);
    return { ...made, abort, arm, at };
  }

  test("cuts the reply to the first fragment, through the barge-in path", () => {
    const { handlers, abort, arm, reported, at } = resumable();
    handlers.onSttFinal("my name is Mei Davis and my zip is");
    at(101_000);
    handlers.onSttPartial("eight zero");
    expect(abort).toHaveBeenCalledTimes(1);
    // Recovery armed, so speech that never commits resumes the reply.
    expect(arm).toHaveBeenCalledTimes(1);
    expect(reported).toContain("reply.cancelled");
    vi.useRealTimers();
  });

  test("speech after the window is a reply to the agent, not a continuation", () => {
    const { handlers, abort, at } = resumable();
    handlers.onSttFinal("my name is Mei Davis");
    at(103_000);
    handlers.onSttPartial("yes that is right");
    expect(abort).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  test("a window of 0 leaves the old behaviour: the fragment is answered first", () => {
    const { handlers, abort, at } = resumable({ continuationWindowMs: () => 0 });
    handlers.onSttFinal("my name is Mei Davis and my zip is");
    at(101_000);
    handlers.onSttPartial("eight zero");
    expect(abort).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  test("nothing to cut when no reply is in flight or playing", () => {
    const { handlers, abort, at } = resumable({ isTurnInFlight: () => false });
    handlers.onSttFinal("my name is Mei Davis");
    at(101_000);
    handlers.onSttPartial("and my zip");
    expect(abort).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  test("speech that opened over the reply is a barge-in, gates included", () => {
    // A backchannel inside the window. As a continuation, its first one-word
    // interim cut the reply at once; through the barge-in policy it has to
    // clear the sustained-speech gate first.
    // The agent starts answering only once the question has committed.
    let speaking = false;
    const { handlers, abort, at } = resumable({
      agentIsSpeaking: () => speaking,
      utteranceOpenedOverSpeech: () => speaking,
      minBargeInWords: () => 1,
      interruptionMinDurationMs: () => 500,
    });
    handlers.onSttFinal("summarize black holes");
    speaking = true;
    at(101_000);
    handlers.onSttPartial("Um,");
    expect(abort).not.toHaveBeenCalled();
    at(101_600);
    handlers.onSttPartial("Wait, stop");
    expect(abort).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  test("fires once per utterance, however many interims it produces", () => {
    const { handlers, abort, at } = resumable();
    handlers.onSttFinal("my zip is");
    at(101_000);
    handlers.onSttPartial("eight");
    at(101_300);
    handlers.onSttPartial("eight zero two");
    expect(abort).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("acknowledgements over the agent are listening, not turns", () => {
  /** The agent is speaking, and every utterance opens over it. */
  function overSpeech() {
    const abort = vi.fn();
    const made = makeHandlers({
      agentIsSpeaking: () => true,
      utteranceOpenedOverSpeech: () => true,
      isTurnInFlight: () => true,
      minBargeInWords: () => 1,
      interruptionMinDurationMs: () => 500,
      abortInFlightTurn: abort,
    });
    return { ...made, abort };
  }

  test("an acknowledgement-only interim does not cut the reply", () => {
    const { handlers, abort, reported } = overSpeech();
    handlers.onSttPartial("Mm-hmm, yeah");
    expect(abort).not.toHaveBeenCalled();
    expect(reported).not.toContain("reply.cancelled");
  });

  test("an acknowledgement-only final is neither a cut nor a turn", () => {
    const { handlers, abort, committed, reported } = overSpeech();
    handlers.onSttFinal("Uh-huh, sure.");
    expect(abort).not.toHaveBeenCalled();
    expect(committed).toEqual([]);
    expect(reported).not.toContain("reply.cancelled");
  });

  test("the same words after the agent stopped are an answer, and commit", () => {
    const { handlers, committed } = makeHandlers({ minBargeInWords: () => 1 });
    handlers.onSttFinal("Yeah, right.");
    expect(committed).toEqual([{ text: "Yeah, right." }]);
  });

  test("a three-word interim cuts at once, with the edge just opened", () => {
    const { handlers, abort } = overSpeech();
    handlers.onSttPartial("Oh, before I");
    expect(abort).toHaveBeenCalledTimes(1);
  });

  test("a one-word interim that is not an acknowledgement still waits for the gate", () => {
    const { handlers, abort } = overSpeech();
    handlers.onSttPartial("Hold");
    expect(abort).not.toHaveBeenCalled();
  });
});

describe("continuation respects a floor the agent must keep", () => {
  test('`interruption: "off"` (an infinite threshold) is never cut by a continuation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    let openedAt: number | undefined;
    const abort = vi.fn();
    const { handlers } = makeHandlers({
      continuationWindowMs: () => 2500,
      minBargeInWords: () => Number.POSITIVE_INFINITY,
      isTurnInFlight: () => true,
      abortInFlightTurn: abort,
      speechEdges: {
        speechStarted: () => {
          openedAt ??= Date.now();
        },
        speechEnded: () => {
          openedAt = undefined;
        },
        durationMs: () => (openedAt === undefined ? 0 : Date.now() - openedAt),
        reset: vi.fn(),
      },
    });
    handlers.onSttFinal("my zip is");
    vi.setSystemTime(101_000);
    handlers.onSttPartial("eight zero two");
    expect(abort).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// Recorded on tau2-bench retail: a caller's "Okay, just let me k—" cut "I have
// May Kovacs, ZIP 2-8-2-3-6, but couldn't locate the account. Please spell your
// first or last name…" at "ZIP 2", committed as "Okay, no problem.", and the
// model — holding only "… [interrupted]" — asked "What would you like to try
// next?". The spelling request never reached the caller. 17% of barge-ins on
// that run committed nothing but an acknowledgement.
describe("a cut whose utterance commits a turn hands that turn a note", () => {
  const HEARD = "I have May Kovacs, ZIP 2";

  function makeCutHandlers(anchor: string | null = HEARD) {
    const state = { speaking: true };
    const recovery = createFalseInterruptionRecovery({
      enabled: () => true,
      maxConsecutive: 3,
      isActive: () => true,
      isBusy: () => false,
      onResume: vi.fn(),
    });
    const made = makeHandlers({
      isTurnInFlight: () => state.speaking,
      hasTurnSpoken: () => state.speaking,
      agentIsSpeaking: () => state.speaking,
      audioOnLine: () => state.speaking,
      utteranceOpenedOverSpeech: () => state.speaking,
      hasSpokenRecordable: () => state.speaking,
      cutAnchor: () => (state.speaking && anchor !== null ? anchor : undefined),
      abortInFlightTurn: () => {
        state.speaking = false;
      },
      recovery,
    });
    return { ...made, state, recovery };
  }

  test("a partial barge-in records the cut, and the final it commits carries it", () => {
    const h = makeCutHandlers();
    h.handlers.onSttPartial("okay just let me");
    expect(h.state.speaking).toBe(false);
    h.handlers.onSttFinal("Okay, no problem.");
    expect(h.committed).toEqual([{ text: "Okay, no problem.", note: buildCutNote(HEARD) }]);
    expect(h.committed[0]?.note).toContain(`"…${HEARD}"`);
  });

  test("a final that itself interrupts carries the note too", () => {
    const h = makeCutHandlers();
    h.handlers.onSttFinal("uh-huh sure thing");
    expect(h.committed).toEqual([{ text: "uh-huh sure thing", note: buildCutNote(HEARD) }]);
  });

  test("only the turn the cut belongs to carries it", () => {
    const h = makeCutHandlers();
    h.handlers.onSttPartial("okay just let me");
    h.handlers.onSttFinal("Okay, no problem.");
    h.handlers.onSttFinal("My name is Mei.");
    expect(h.committed[1]).toEqual({ text: "My name is Mei." });
  });

  test("a reply heard essentially whole leaves nothing to note", () => {
    const h = makeCutHandlers(null);
    h.handlers.onSttPartial("okay just let me");
    h.handlers.onSttFinal("Okay, no problem.");
    expect(h.committed).toEqual([{ text: "Okay, no problem." }]);
  });

  test("speech into silence cut nothing", () => {
    const h = makeCutHandlers();
    h.state.speaking = false;
    h.handlers.onSttFinal("Hello?");
    expect(h.committed).toEqual([{ text: "Hello?" }]);
  });
});

describe("the turn tells the write gate whether it was a backchannel", () => {
  // tools/confirmation-gate.ts refuses a declared write on a turn that began
  // while agent audio was on the line, filler included. The flag is sampled
  // before the final closes the speaking edge, which clears it.
  test("a final opened over agent audio commits as overlapped", () => {
    const overlapped: (boolean | undefined)[] = [];
    let onAir = true;
    const { handlers } = makeHandlers({
      utteranceOpenedOverAudio: () => onAir,
      commitUserTurn: (_text, _note, _meta, o) => void overlapped.push(o),
    });
    handlers.onSttFinal("Uh-huh.");
    onAir = false;
    handlers.onSttFinal("Yes, go ahead.");
    // No word timings: overlap alone decides, as the first rule did.
    expect(overlapped).toEqual([true, false]);
  });

  // tau2 retail: an "uh-huh" over the question (task 12) must not confirm;
  // "Yeah, cancel that charger order" begun over its last ~1.4s (task 32) must.
  test("over agent audio, only a turn shorter than the gate is a backchannel", () => {
    const flags: (boolean | undefined)[] = [];
    let onAir = true;
    const { handlers } = makeHandlers({
      utteranceOpenedOverAudio: () => onAir,
      interruptionMinDurationMs: () => 500,
      commitUserTurn: (_text, _note, _meta, b) => void flags.push(b),
    });
    handlers.onSttFinal("Uh-huh.", { spokenMs: 320 });
    handlers.onSttFinal("Yeah, cancel that charger order.", { spokenMs: 1400 });
    onAir = false;
    handlers.onSttFinal("Yes.", { spokenMs: 250 });
    expect(flags).toEqual([true, false, false]);
  });

  // `universal-3-5-pro` times a turn's first word from the turn window, so a
  // one-beat "Yes." over the agent reports a span past the gate. Its words say
  // what the span cannot.
  test("over agent audio, acknowledgement-only words are a backchannel whatever their span", () => {
    const flags: (boolean | undefined)[] = [];
    let onAir = true;
    const { handlers } = makeHandlers({
      utteranceOpenedOverAudio: () => onAir,
      interruptionMinDurationMs: () => 500,
      commitUserTurn: (_text, _note, _meta, b) => void flags.push(b),
    });
    handlers.onSttFinal("Yes.", { spokenMs: 2400 });
    handlers.onSttFinal("Yes, go ahead with it.", { spokenMs: 2400 });
    onAir = false;
    handlers.onSttFinal("Yes.", { spokenMs: 2400 });
    expect(flags).toEqual([true, false, false]);
  });
});
