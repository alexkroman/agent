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
import { silentLogger } from "../_test-utils.ts";
import { createSttEventHandlers } from "./pipeline-stt-handlers.ts";

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
    lowConfidence: undefined,
    speculation: { onPartial: vi.fn(), onFinal: vi.fn(), onUtteranceIdle: vi.fn() },
    minBargeInWords: () => 2,
    interruptionMinDurationMs: () => 0,
    // Both phrase lists EMPTY, which leaves the two thresholds in sole charge —
    // the behaviour these specs were written against, before the lists existed.
    // The lists' own cases live in `pipeline-user-speech.test.ts`, which drives
    // the shipped defaults through `createUserActivity`.
    phrases: { acknowledgement: [], interruption: [] },
    // Inert: the table's own cases are in `pipeline-user-speech.test.ts` too.
    // Recorded rather than a no-op so a spec here can still assert the seam.
    endpointing: { onUserPartial: vi.fn(), onUtteranceEnded: vi.fn() },
    onInterrupted: vi.fn(),
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

  test("the low-confidence gate can take the turn away, and pass a note through", () => {
    const handled = makeHandlers({
      lowConfidence: { classify: () => "handled" },
    });
    handled.handlers.onSttFinal("shhk");
    expect(handled.committed).toEqual([]);

    const noted = makeHandlers({
      lowConfidence: { classify: () => ({ note: "may be mis-heard" }) },
    });
    noted.handlers.onSttFinal("cancel W123");
    expect(noted.committed).toEqual([{ text: "cancel W123", note: "may be mis-heard" }]);
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
