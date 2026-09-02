// Copyright 2026 the AAI authors. MIT license.
/**
 * The two failure phrases, as they leave the transport.
 *
 * This suite exists because of one line in the module under test's own doc
 * table — `history / ctx.messages: never` for both phrases — which was true of
 * this module and false of the system: nothing on the wire distinguished a
 * failure phrase from a reply, so every reader of the retained stream had to
 * treat one as the other. `recovery` is that distinction, and the claim it makes
 * is asserted at the EMITTER here and at both readers
 * (`session-core-history.test.ts`, `session-event-history.test.ts`).
 */

import type { SessionEventBody } from "@alexkroman1/aai/protocol";
import { describe, expect, test } from "vitest";
import { recordingTts } from "../_pipeline-test-fakes.ts";
import { createPipelineHistory } from "./pipeline-history.ts";
import type { PipelineProviderSessions } from "./pipeline-providers.ts";
import { createTurnGate } from "./pipeline-turn-gate.ts";
import { createTurnOutcome } from "./pipeline-turn-outcome.ts";
import type { TransportCallbacks } from "./types.ts";

const ERROR_PHRASE = "Sorry, I had a problem just then.";
const START_FAILURE_PHRASE = "I cannot start this call.";

/** Records and synthesizes nothing — written out rather than cast. */
function harness(opts?: { tts?: boolean }) {
  const reported: SessionEventBody[] = [];
  const spoken: string[] = [];
  const history = createPipelineHistory();
  const callbacks: TransportCallbacks = {
    report: (event) => reported.push(event),
    onAudioChunk: () => undefined,
    onReplyStarted: () => undefined,
  };
  // `stt: null` is the documented start-failure state — see
  // `TurnOutcome.speakStartFailure`, whose reason to exist is "STT missing while
  // TTS connected".
  const providers: PipelineProviderSessions = {
    stt: null,
    tts: opts?.tts === false ? null : recordingTts(spoken),
    open: (): Promise<"ok" | "failed"> => Promise.resolve("ok"),
    unsubscribe: () => undefined,
    close: () => Promise.resolve(),
  };
  const outcome = createTurnOutcome({
    history,
    callbacks,
    providers,
    gate: createTurnGate(),
    errorPhrase: ERROR_PHRASE,
    startFailurePhrase: START_FAILURE_PHRASE,
    drainTts: () => Promise.resolve(),
    sendTtsText: (text) => spoken.push(text),
  });
  return { outcome, reported, spoken, history };
}

describe("speakRecovery", () => {
  test("speaks the phrase and TAGS the transcript it commits", () => {
    const { outcome, reported, spoken, history } = harness();

    expect(outcome.speakRecovery(true)).toBe(true);

    // The caller heard it, so the caption carries it...
    expect(spoken).toEqual([ERROR_PHRASE]);
    expect(reported).toEqual([
      { type: "agent-transcript.committed", text: ERROR_PHRASE, recovery: "turn-failed" },
    ]);
    // ...and nothing recorded it. Both views, because the LLM's is the one the
    // apology would teach.
    expect(history.conversation).toEqual([]);
    expect(history.llm).toEqual([]);
  });

  test("a turn that did not fail says nothing at all", () => {
    const { outcome, reported, spoken } = harness();
    expect(outcome.speakRecovery(false)).toBe(false);
    expect(reported).toEqual([]);
    expect(spoken).toEqual([]);
  });
});

describe("speakStartFailure", () => {
  test("tags its transcript too, with the reason that names the SESSION", () => {
    // A different tag rather than one shared boolean: the two phrases have
    // different lifecycles (one inside a reply, one outside any reply), and a
    // client rendering them the same way should be its own decision.
    const { outcome, reported } = harness();

    return outcome.speakStartFailure().then(() => {
      expect(reported).toEqual([
        {
          type: "agent-transcript.committed",
          text: START_FAILURE_PHRASE,
          recovery: "session-failed",
        },
      ]);
    });
  });

  test("says nothing when TTS is the side that failed", async () => {
    const { outcome, reported } = harness({ tts: false });
    await expect(outcome.speakStartFailure()).resolves.toBeUndefined();
    expect(reported).toEqual([]);
  });
});

describe("finishSpokenTurn", () => {
  test("carries NO tag, and is the message that enters the record", () => {
    // The absence is the load-bearing half: a reader keys on the field being
    // there, so an ordinary reply — and an event written before the field
    // existed — reads as a turn.
    const { outcome, reported, history } = harness();

    outcome.finishSpokenTurn("Here you go.");

    expect(reported).toEqual([{ type: "agent-transcript.committed", text: "Here you go." }]);
    expect(history.conversation).toEqual([{ role: "assistant", content: "Here you go." }]);
  });
});
