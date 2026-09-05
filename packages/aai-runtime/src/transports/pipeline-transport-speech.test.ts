// Copyright 2026 the AAI authors. MIT license.
/**
 * What the pipeline transport says outside a model turn, and what it records.
 *
 * Two cases sharing one question — is this speech, or is it plumbing? The
 * dead-air cover is audible but must not enter the conversation record; the
 * interim transcript must reach the client as the words become audible rather
 * than all at once when the reply ends.
 *
 * These specs drive the cover at the SHIPPED window on VIRTUAL time, with a
 * tool that outlasts it — the only shape that produces real dead air at 5s.
 * They used to drive it with `holdPhrase: "One moment."`, which fired at t=0 on
 * the turn's shape; there is no such mechanism now — filler follows MEASURED
 * silence.
 *
 * They then spent a while as the one pipeline spec file left on the WALL CLOCK,
 * squeezing `deadAirCoverMs: 1` against `delayMs: 15` — which tests the wiring
 * and says nothing about the window a caller actually waits out, and is a race
 * besides. See `useVirtualTime`'s doc and the worked conversion in
 * `pipeline-voice-events.test.ts` ("The SHIPPED window, not a 1ms stand-in").
 *
 * Split out of `pipeline-transport.test.ts` for file length.
 */

import { DEAD_AIR_OPENING_PHRASE, DEFAULT_DEAD_AIR_COVER_MS } from "@alexkroman1/aai/host-internal";
import { sleep } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import {
  createFakeLanguageModel,
  createFakeTtsProvider,
  type ScriptedPart,
} from "../_pipeline-test-fakes.ts";
import { makeOpts, noopToolSchema, useVirtualTime } from "./_pipeline-transport-harness.ts";
import { partialTranscripts } from "./_transport-recorder.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

useVirtualTime();

/**
 * The tool-first turn every cover spec here needs: the model calls a tool and
 * says nothing until it answers, and the tool takes twice the cover window.
 */
const TOOL_FIRST_STEPS: ScriptedPart[][] = [
  [
    {
      type: "tool-call",
      toolCallId: "tc-1",
      toolName: "get_weather",
      input: JSON.stringify({ city: "SF" }),
    },
  ],
  [{ type: "text", text: "It's sunny." }],
];

/** A tool that outlasts the cover window, so the turn is genuinely silent. */
const slowTool = () =>
  vi.fn(async () => {
    await sleep(DEFAULT_DEAD_AIR_COVER_MS * 2);
    return "sunny";
  });

describe("PipelineTransport speech vs. record", () => {
  describe("interim agent transcript", () => {
    test("publishes the cover filler before the model's answer exists", async () => {
      // A reply that stalls speaks its filler seconds (or, on a long chain,
      // minutes) before `onAgentTranscript` fires with the whole reply. A
      // client that pairs text with audio has played that audio by then, so the
      // words have to go out when they become audible.
      const { opts, stt, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ steps: TOOL_FIRST_STEPS, delayMs: 20 }),
        deadAirCoverMs: DEFAULT_DEAD_AIR_COVER_MS,
        executeTool: slowTool(),
        toolSchemas: [{ ...noopToolSchema, name: "get_weather" }],
      });
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("how's the weather?");

      // Nothing yet: the caller is in an ordinary pause, and covering it here
      // would cost the reply's opening sentence.
      await vi.advanceTimersByTimeAsync(DEFAULT_DEAD_AIR_COVER_MS - 1);
      expect(callbacks.reported("agent-transcript.updated")).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(callbacks.reported("agent-transcript.updated")).toHaveBeenCalledWith({
        type: "agent-transcript.updated",
        text: DEAD_AIR_OPENING_PHRASE,
      });
      // Still cumulative, and still one final transcript for history.
      await vi.advanceTimersByTimeAsync(DEFAULT_DEAD_AIR_COVER_MS * 2);
      await vi.waitFor(() => {
        expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledWith({
          type: "agent-transcript.committed",
          text: expect.stringContaining("It's sunny."),
        });
      });
      const lastPartial = partialTranscripts(callbacks).at(-1);
      expect(lastPartial).toContain(DEAD_AIR_OPENING_PHRASE);
      expect(lastPartial).toContain("It's sunny.");
      await t.stop();
    });

    test("starts each reply's transcript from empty", async () => {
      const { opts, stt, callbacks } = makeOpts({
        sessionConfig: { systemPrompt: "s", greeting: "Hi there!" },
        llm: createFakeLanguageModel({ script: [{ type: "text", text: "It is three." }] }),
      });
      const t = createPipelineTransport(opts);
      await t.start();
      // The greeting publishes only a final transcript (its whole text reaches
      // TTS at once, so an interim copy would be identical) — so that, not a
      // partial, is the signal that the greeting turn is behind us.
      await vi.waitFor(() => {
        expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledWith({
          type: "agent-transcript.committed",
          text: "Hi there!",
        });
      });
      const partialsBeforeTurn = partialTranscripts(callbacks).length;

      stt.last()?.fireFinal("what time is it?");
      await vi.waitFor(() => {
        expect(callbacks.reported("agent-transcript.updated")).toHaveBeenCalled();
      });
      // Carrying the previous reply's text over would restate the greeting as
      // part of this reply's caption.
      for (const text of partialTranscripts(callbacks).slice(partialsBeforeTurn)) {
        expect(text).not.toContain("Hi there!");
      }
      await t.stop();
    });
  });

  describe("filler is spoken but not recorded", () => {
    test("the cover filler reaches TTS but not the recorded transcript", async () => {
      // The filler is a timing artifact, not something the agent said. Left in
      // the record it costs context on every later turn and shows the model its
      // own filler as an example of what its turns look like.
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ steps: TOOL_FIRST_STEPS, delayMs: 20 }),
        deadAirCoverMs: DEFAULT_DEAD_AIR_COVER_MS,
        executeTool: slowTool(),
        toolSchemas: [{ ...noopToolSchema, name: "get_weather" }],
      });
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("how's the weather?");

      await vi.advanceTimersByTimeAsync(DEFAULT_DEAD_AIR_COVER_MS * 3);
      await vi.waitFor(() => {
        expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
      });
      // Heard by the caller...
      expect(tts.last()?.textChunks.join("")).toContain(DEAD_AIR_OPENING_PHRASE);
      // ...and shown live, since the caption is built from what reaches TTS.
      expect(
        partialTranscripts(callbacks).some((text) => text.includes(DEAD_AIR_OPENING_PHRASE)),
      ).toBe(true);
      // ...but absent from the reply's final transcript, which is what history,
      // ctx.messages, resume, and the STT agent-context hint are built from.
      // Every COMMITTED transcript — the interrupted arm is a separate event now
      // (`agent-transcript.updated`), so there is no flag left to filter on.
      const finals = callbacks.events
        .filter((e) => e.type === "agent-transcript.committed")
        .map((e) => e.text);
      expect(finals.some((text) => text.includes("It's sunny."))).toBe(true);
      for (const text of finals) expect(text).not.toContain(DEAD_AIR_OPENING_PHRASE);
      await t.stop();
    });
  });
});

describe("filler never talks over the caller", () => {
  test("the cover filler is suppressed while an utterance is open", async () => {
    // Filler is silence-cover. Playing it across a live utterance is worse than
    // the silence it hides — EVA's turn-taking metric scores it as an agent
    // interruption (1.5s of simultaneous speech measured 0.13 out of 1). This is
    // the gap `interruptionMinDurationMs` leaves open on purpose: a continuation
    // too short to be a barge-in does not cancel the reply.
    const tts = createFakeTtsProvider();
    const { opts, stt } = makeOpts(
      {
        llm: createFakeLanguageModel({ steps: TOOL_FIRST_STEPS, delayMs: 20 }),
        deadAirCoverMs: DEFAULT_DEAD_AIR_COVER_MS,
        tts,
        executeTool: slowTool(),
        toolSchemas: [{ ...noopToolSchema, name: "get_weather" }],
      },
      { tts },
    );
    const t = createPipelineTransport(opts);
    await t.start();

    // Commit a turn, then have the caller keep talking: partials arrive, which
    // hold the speech edge open while the reply is still being produced. They
    // have to KEEP arriving — the edge goes idle DEFAULT_SPEECH_IDLE_TIMEOUT_MS
    // (4s) after the last one, which is INSIDE the 5s cover window, so a single
    // partial would let the filler through legitimately. No audio is fired, so
    // nothing here is a barge-in: the agent is not audibly speaking.
    stt.last()?.fireFinal("how's the weather?");
    stt.last()?.firePartial("and also");
    for (let elapsed = 0; elapsed < DEFAULT_DEAD_AIR_COVER_MS * 2; elapsed += 1000) {
      await vi.advanceTimersByTimeAsync(1000);
      stt.last()?.firePartial("and also");
    }
    // Two whole cover windows have passed with the caller holding the floor.
    expect(tts.last()?.textChunks.join("")).not.toContain(DEAD_AIR_OPENING_PHRASE);

    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.join("")).toContain("It's sunny.");
    });
    expect(tts.last()?.textChunks.join("")).not.toContain(DEAD_AIR_OPENING_PHRASE);
    await t.stop();
  });
});
