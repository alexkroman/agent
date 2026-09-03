// Copyright 2026 the AAI authors. MIT license.
// What an INTERRUPTED pipeline turn leaves behind: the heard prefix marked
// `[interrupted]`, the completed tool steps, and — the negative half — the
// turns that must persist nothing at all (no text generated, or nothing but
// dead-air filler).
//
// Split out of `pipeline-turn.test.ts` at the seam it already had (this whole
// `describe`), which was over the 700-line test cap. That file keeps the
// happy-path turn: STT final → LLM stream → TTS, tool calls, deferral, commit.

import {
  DEAD_AIR_OPENING_PHRASE,
  DEFAULT_TTS_SAMPLE_RATE,
  sleep,
} from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel, createTestClock, speakFor } from "../_pipeline-test-fakes.ts";
import {
  inFlightReplyScript,
  llmCalls,
  makeOpts,
  noopToolSchema,
  useVirtualTime,
} from "./_pipeline-transport-harness.ts";
import { partialTranscripts } from "./_transport-recorder.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

useVirtualTime();

describe("interrupted-speech persistence", () => {
  /** The reply both barge-in specs below script, as one string. */
  const REPLY = "Your balance is five hundred dollars.";

  /** The text recorded for the interrupted turn, read out of an LLM prompt. */
  function interruptedText(prompt: string): string {
    return prompt.match(/"text":"([^"]*) \[interrupted\]"/)?.[1] ?? "";
  }

  test("barge-in persists spoken-so-far text with an [interrupted] marker", async () => {
    // History records what the caller HEARD, so this spec has to make them
    // hear it: audio is forwarded AND allowed to play out on the injected
    // clock. With no elapsed playback it would be the zero case below instead.
    const clock = createTestClock();
    const { opts, stt, tts, callbacks } = makeOpts({
      minBargeInWords: 1, // pin so the one-word "stop" barge-in fires (default is now 2)
      heardLagMs: 0,
      heardNow: clock.now,
      llm: createFakeLanguageModel({
        // Turn 1 streams slowly so we can barge in mid-stream; turn 2 is a plain reply.
        steps: [
          [
            { type: "text", text: "Your balance " },
            { type: "text", text: "is five " },
            { type: "text", text: "hundred dollars." },
          ],
          [{ type: "text", text: "Sure." }],
        ],
        delayMs: 20,
      }),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    const llm = llmCalls(opts);

    // Turn 1 — wait until text has streamed to TTS (so `accumulated` is
    // non-empty), then barge in (default threshold = 1 word).
    stt.last()?.fireFinal("what is my balance");
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
    });
    speakFor(tts, clock, 2000); // spoken, heard in full → interruptible
    stt.last()?.firePartial("stop");

    // The caller already has the spoken text: every chunk handed to TTS was
    // published as an interim snapshot. Nothing is emitted once the aborted
    // stream settles — that frame would land after `cancelled`, which the client
    // treats as the end of the reply (see persistInterruptedTurn).
    await vi.waitFor(() => {
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();
    });
    // Only what reached TTS is published — the coalescer was still batching the
    // rest, which the abort discarded, so the caller heard exactly this much.
    // History below records that same heard prefix, never the buffered tail.
    expect(partialTranscripts(callbacks)).toContainEqual(expect.stringContaining("Your "));
    const callsAfterTurn1 = llm.calls.length;

    // Turn 2 — its LLM prompt must contain the persisted interrupted assistant message.
    stt.last()?.fireFinal("never mind");
    await vi.waitFor(() => {
      expect(llm.calls.length).toBeGreaterThan(callsAfterTurn1);
    });
    const turn2Prompt = JSON.stringify(llm.calls[callsAfterTurn1]?.prompt);
    expect(turn2Prompt).toContain("[interrupted]");
    // What is recorded is a PREFIX of what the model generated — as far as the
    // caller's ear had got — never the tail still sitting in the TTS coalescer
    // when the abort discarded it.
    const recorded = interruptedText(turn2Prompt);
    expect(recorded.length).toBeGreaterThan(0);
    expect(REPLY.startsWith(recorded)).toBe(true);
    await t.stop();
  });

  test("an abort before any text is generated persists nothing", async () => {
    // `streamScript` awaits `delayMs` BEFORE the first delta, so an abort
    // inside that window leaves `accumulated` empty — the guard's no-op case.
    // (The dead-air cover cannot interfere: its filler is emitted
    // `record: false`, so it never reaches onDelta/accumulated — and at the
    // shipped 5000ms window it would not have fired inside this spec anyway.)
    //
    // Aborted via cancelReply() rather than a barge-in: with no text there is
    // no audio either, and barge-in now requires the agent to be audibly
    // speaking, so a client stop is the only path that reaches this window.
    const { opts, stt, callbacks } = makeOpts({
      llm: createFakeLanguageModel({
        steps: [[{ type: "text", text: "Hello there." }], [{ type: "text", text: "Sure." }]],
        delayMs: 50,
      }),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    const llm = llmCalls(opts);

    stt.last()?.fireFinal("hi");
    // Abort during the pre-first-delta delay.
    await vi.advanceTimersByTimeAsync(10);
    t.cancelReply();

    // No text accumulated → no interrupted transcript surfaced.
    expect(callbacks.reported("agent-transcript.committed")).not.toHaveBeenCalledWith({
      type: "agent-transcript.committed",
      text: expect.anything(),
    });

    // …and nothing persisted: turn 2's prompt carries no [interrupted] marker.
    const callsAfterTurn1 = llm.calls.length;
    stt.last()?.fireFinal("never mind");
    await vi.waitFor(() => {
      expect(llm.calls.length).toBeGreaterThan(callsAfterTurn1);
    });
    expect(JSON.stringify(llm.calls[callsAfterTurn1]?.prompt)).not.toContain("[interrupted]");
    await t.stop();
  });

  test("final-replace path: interrupted text is persisted before the replacing user turn and visible to it", async () => {
    const clock = createTestClock();
    const { opts, stt, tts } = makeOpts({
      heardLagMs: 0,
      heardNow: clock.now,
      llm: createFakeLanguageModel({
        steps: [
          [
            { type: "text", text: "Your balance " },
            { type: "text", text: "is five " },
            { type: "text", text: "hundred dollars." },
          ],
          [{ type: "text", text: "Okay." }],
        ],
        delayMs: 20,
      }),
      minBargeInWords: 3,
    });
    const t = createPipelineTransport(opts);
    await t.start();
    const llm = llmCalls(opts);

    // Turn 1 — start speaking.
    stt.last()?.fireFinal("what is my balance");
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
    });
    speakFor(tts, clock, 2000); // spoken, heard in full → interruptible
    const callsAfterTurn1 = llm.calls.length;

    // Replace via a >=3-word final (above threshold → interrupts).
    stt.last()?.fireFinal("actually never mind please");
    await vi.waitFor(() => {
      expect(llm.calls.length).toBeGreaterThan(callsAfterTurn1);
    });

    // The replacing turn's prompt must contain the [interrupted] marker,
    // ordered before the replacing user message.
    const prompt = JSON.stringify(llm.calls[callsAfterTurn1]?.prompt);
    expect(prompt).toContain("[interrupted]");
    const recorded = interruptedText(prompt);
    expect(recorded.length).toBeGreaterThan(0);
    expect(REPLY.startsWith(recorded)).toBe(true);
    const interruptedIdx = prompt.indexOf("[interrupted]");
    const replacingUserIdx = prompt.indexOf("actually never mind please");
    expect(interruptedIdx).toBeGreaterThanOrEqual(0);
    expect(replacingUserIdx).toBeGreaterThan(interruptedIdx);
    await t.stop();
  });

  test("barge-in after a completed tool step persists the tool call and its result", async () => {
    // Regression: an aborted turn used to drop ALL of its step messages, so a
    // tool call that had already succeeded (and its result) vanished from LLM
    // history — the next turn would repeat the call or claim the lookup failed.
    const executeTool = vi.fn(async () => "result-payload-42");
    const { opts, stt, tts, callbacks } = makeOpts({
      minBargeInWords: 1,
      llm: createFakeLanguageModel({
        steps: [
          // Step 1: tool call (completes, result recorded). Step 2: text long
          // enough that it is still streaming when we barge in — see
          // inFlightReplyScript for why a short step flakes under load. Step 3:
          // the follow-up turn's plain reply.
          [{ type: "tool-call", toolCallId: "tc-1", toolName: "lookup", input: "{}" }],
          [{ type: "text", text: "I found " }, ...inFlightReplyScript()],
          [{ type: "text", text: "Okay." }],
        ],
        delayMs: 20,
      }),
      executeTool,
      toolSchemas: [noopToolSchema],
    });
    const t = createPipelineTransport(opts);
    await t.start();
    const llm = llmCalls(opts);

    stt.last()?.fireFinal("look up my account");
    // Wait until step 1 finished (tool ran) and step 2's stream has started
    // (its doStream call was made). TTS chunks are no longer a reliable
    // mid-step signal: sends coalesce to sentence boundaries, so step 2's text
    // may only reach TTS at the end of the step.
    await vi.waitFor(() => {
      expect(executeTool).toHaveBeenCalled();
      expect(llm.calls.length).toBeGreaterThanOrEqual(2);
    });
    // The reply is audible by this point in production, so the turn holds the
    // floor and is interruptible.
    tts.last()?.fireAudio(new Int16Array(2400));
    stt.last()?.firePartial("stop");
    await vi.waitFor(() => {
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();
    });

    // The follow-up turn's LLM prompt must carry the completed tool step.
    const callsBefore = llm.calls.length;
    stt.last()?.fireFinal("did you find it");
    await vi.waitFor(() => {
      expect(llm.calls.length).toBeGreaterThan(callsBefore);
    });
    const prompt = JSON.stringify(llm.calls[callsBefore]?.prompt);
    expect(prompt).toContain("result-payload-42");
    expect(prompt).toContain("tc-1");
    // The tool ran exactly once — the follow-up turn built on the persisted
    // result instead of re-executing.
    expect(executeTool).toHaveBeenCalledTimes(1);
    await t.stop();
  });

  test("barge-in during the cover filler (no real text yet) persists nothing", async () => {
    // The filler has to be genuinely HEARD for this spec to say anything. It
    // used to fire 100 ms of audio and cut at once, putting `heardMs` at 0 under
    // the ear-lag, so the spec passed with `record: false` deleted from the
    // cover's `emitText` (verified). `heardLagMs: 0` plus a real drain is what
    // makes the cut land with filler behind the ear rather than ahead of it.
    const COVER_MS = 1000;
    const AUDIO_MS = 500;
    const TOOL_MS = 5000;
    const { opts, stt, tts, callbacks } = makeOpts({
      // Long enough that exactly ONE filler lands in the tool window (the
      // backoff puts the second at +2x), so what the ear reaches is a single
      // known phrase.
      deadAirCoverMs: COVER_MS,
      heardLagMs: 0,
      minBargeInWords: 1, // pin so the one-word "stop" barge-in fires (default is now 2)
      // The barge-in is a client cut of a turn that never spoke: no resume, so
      // the only LLM request after it is the follow-up turn asserted on below.
      resumeFalseInterruption: false,
      llm: createFakeLanguageModel({
        steps: [
          [{ type: "tool-call", toolCallId: "tc-1", toolName: "lookup", input: "{}" }],
          [{ type: "text", text: "Done." }],
        ],
        delayMs: 20,
      }),
      // Outlasts the whole cut, so the barge-in really does land with the tool
      // still in flight and no model text generated.
      executeTool: vi.fn(async () => {
        await sleep(TOOL_MS);
        return "ok";
      }),
      toolSchemas: [noopToolSchema],
    });
    const t = createPipelineTransport(opts);
    await t.start();
    const llm = llmCalls(opts);

    stt.last()?.fireFinal("look it up");
    // The tool call goes out at 20ms and the cover fires at 1000ms.
    await vi.advanceTimersByTimeAsync(COVER_MS);
    expect(tts.last()?.textChunks.join("")).toContain(DEAD_AIR_OPENING_PHRASE);

    // Half a second of filler audio, then drain it: the ear is now past the
    // opening words of the phrase.
    tts.last()?.fireAudio(new Int16Array((DEFAULT_TTS_SAMPLE_RATE * AUDIO_MS) / 1000));
    await vi.advanceTimersByTimeAsync(AUDIO_MS);
    stt.last()?.firePartial("stop");

    await vi.waitFor(() => {
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();
    });
    // Only filler was audible → nothing persisted as interrupted.
    expect(callbacks.reported("agent-transcript.committed")).not.toHaveBeenCalledWith({
      type: "agent-transcript.committed",
      text: expect.anything(),
    });
    // …and the HISTORY probe, the stronger of the two this file uses (see the
    // sibling "an abort before any text is generated persists nothing"): the
    // committed check alone stays green for filler that leaked into history,
    // since filler produces no committed transcript at all. Turn 2's prompt is
    // where a leak shows, and it runs after turn 1's persist decision — which
    // also replaces the `t.stop()` that used to guard against racing it.
    await vi.advanceTimersByTimeAsync(TOOL_MS);
    const callsAfterTurn1 = llm.calls.length;
    stt.last()?.fireFinal("never mind");
    await vi.waitFor(() => {
      expect(llm.calls.length).toBeGreaterThan(callsAfterTurn1);
    });
    const prompt = JSON.stringify(llm.calls[callsAfterTurn1]?.prompt);
    expect(prompt).not.toContain("[interrupted]");
    expect(prompt).not.toContain(DEAD_AIR_OPENING_PHRASE);
    await t.stop();
  });
});
