// Copyright 2026 the AAI authors. MIT license.
/**
 * The handlers driven DIRECTLY, with every collaborator a stub.
 *
 * `pipeline-user-speech.test.ts` drives the same code through
 * `createUserActivity` and owns the cases that need the real recovery latch
 * and the real speaking edges (barge-in classification, the resume window, the
 * low-confidence band). What is here is the handlers' own contract at the
 * seam: which calls a transcript produces, and the two early returns that
 * decide whether any of it happens.
 */

import { describe, expect, test, vi } from "vitest";
import { makeLogger, silentLogger } from "../_test-utils.ts";
import { AUTO_TURN_DETECTION } from "./pipeline-manual-turn.ts";
import { createSttEventHandlers } from "./pipeline-stt-handlers.ts";
import { NO_USER_TURN_LIMIT } from "./pipeline-user-turn-limit.ts";

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
    hasSpokenRecordable: () => false,
    abortInFlightTurn: vi.fn(),
    tailResumePrompt: () => undefined,
    speechEdges,
    edgeGate: {
      release: vi.fn(),
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
      reset: vi.fn(),
    },
    recovery: { arm: vi.fn(), clear: vi.fn(), onUtteranceEnded: vi.fn(), onUserTurn: vi.fn() },
    nudger: { arm: vi.fn(), clear: vi.fn(), onUserSpeech: vi.fn(), onUserTurn: vi.fn() },
    callbacks: { report: (event) => reported.push(event.type) },
    commitUserTurn: (text, note) => committed.push(note === undefined ? { text } : { text, note }),
    speculation: { onPartial: vi.fn(), onFinal: vi.fn(), onUtteranceIdle: vi.fn() },
    minBargeInWords: () => 2,
    interruptionMinDurationMs: () => 0,
    // Both phrase lists EMPTY, which leaves the two thresholds in sole charge —
    // the behaviour these specs were written against, before the lists existed.
    // The lists' own cases live in `pipeline-user-speech.test.ts`, which drives
    // the shipped defaults through `createUserActivity`.
    onInterrupted: vi.fn(),
    // No cap on a user turn — the shipped default. The cap's own cases live in
    // `pipeline-user-turn-limit.test.ts` and drive it through the transport.
    turnLimit: NO_USER_TURN_LIMIT,
    // The transcriber ends each turn — the shipped default. Push-to-talk's own
    // cases live in `pipeline-manual-turn.test.ts`.
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
    expect(reported).toEqual(["user-transcript.updated"]);
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
      { type: "user-transcript.updated", text: "cancel my", eotConfidence: 0.4 },
    ]);
  });

  test("and is OMITTED rather than nulled when the provider says nothing", () => {
    const events: unknown[] = [];
    const { handlers } = makeHandlers({ callbacks: { report: (event) => events.push(event) } });
    handlers.onSttPartial("cancel my");
    expect(events).toEqual([{ type: "user-transcript.updated", text: "cancel my" }]);
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
    expect(h.infoLines("Pipeline barge-in")).toEqual([{ sid: "s1", peakDb: -18, refDb: CALLER }]);
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
