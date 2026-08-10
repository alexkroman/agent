// Copyright 2026 the AAI authors. MIT license.
// Turn-processing behaviors of the pipeline transport (STT final → LLM stream →
// TTS): transcript/TTS fan-out, mid-turn tool calls, dead-air cover, cross-turn
// tool memory, and flush. Lifecycle/config/error specs live in
// pipeline-transport.test.ts.

import { describe, expect, test, vi } from "vitest";
import { DEAD_AIR_OPENING_PHRASE } from "../../sdk/constants.ts";
import {
  createFakeLanguageModel,
  createTestClock,
  type ScriptedPart,
  speakFor,
} from "../_pipeline-test-fakes.ts";
import {
  firstCallArg,
  inFlightReplyScript,
  llmCalls,
  makeOpts,
  noopToolSchema,
  partialTranscriptSpy,
  useVirtualTime,
} from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

useVirtualTime();

describe("PipelineTransport — STT → LLM turn", () => {
  test("final STT event fires onUserTranscript and onReplyStarted", async () => {
    const { opts, stt, callbacks } = makeOpts();
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("Hello agent");
    await vi.waitFor(() => {
      expect(callbacks.onUserTranscript).toHaveBeenCalledWith("Hello agent");
      // The reply starts a tick after the transcript (chainTurn defers past a
      // possibly-rejected predecessor), so poll for it too.
      expect(callbacks.onReplyStarted).toHaveBeenCalledWith(expect.stringMatching(/^pipeline-/));
    });
    await t.stop();
  });

  test("empty / whitespace-only final is ignored", async () => {
    const { opts, stt, callbacks } = makeOpts();
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("   ");
    await vi.advanceTimersByTimeAsync(10);
    expect(callbacks.onUserTranscript).not.toHaveBeenCalled();
    expect(callbacks.onReplyStarted).not.toHaveBeenCalled();
    await t.stop();
  });

  test("LLM text chunk is forwarded to ttsSession.sendText", async () => {
    const script: ScriptedPart[] = [
      { type: "text", text: "I am " },
      { type: "text", text: "the answer" },
    ];
    const { opts, stt, tts } = makeOpts({ llm: createFakeLanguageModel({ script }) });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("what is the answer?");
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
    });
    expect(tts.last()?.textChunks.join("")).toContain("the answer");
    await t.stop();
  });

  test("inserts a separator between text segments split by a mid-turn tool call", async () => {
    // Multi-step turn: without the separator fix, deltas fuse into "...up.Got it".
    const { opts, stt, tts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({
        steps: [
          [
            { type: "text", text: "Let me look that up." },
            { type: "tool-call", toolCallId: "tc-1", toolName: "lookup", input: "{}" },
          ],
          [{ type: "text", text: "Got it. Here's the answer." }],
        ],
      }),
      executeTool: vi.fn(async () => "result"),
      toolSchemas: [noopToolSchema],
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("look it up");
    await vi.waitFor(() => {
      expect(callbacks.onAgentTranscript).toHaveBeenCalled();
    });
    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith(
      "Let me look that up. Got it. Here's the answer.",
      false,
    );
    expect(tts.last()?.textChunks.join("")).toBe("Let me look that up. Got it. Here's the answer.");
    await t.stop();
  });

  test("speaks a sub-threshold pre-tool fragment before the tool runs", async () => {
    // Regression: TTS text is coalesced, and "let me" is short and unpunctuated,
    // so it used to sit in the batch buffer for the whole tool-execution window
    // — the caller heard "Sure," then dead air. The segment boundary must
    // release it.
    const toolStarted = Promise.withResolvers<void>();
    const { opts, stt, tts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({
        steps: [
          [
            { type: "text", text: "Sure, " },
            { type: "text", text: "let me" },
            { type: "tool-call", toolCallId: "tc-1", toolName: "lookup", input: "{}" },
          ],
          [{ type: "text", text: "found it." }],
        ],
      }),
      executeTool: vi.fn(async () => {
        toolStarted.resolve();
        return "result";
      }),
      toolSchemas: [noopToolSchema],
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("look it up");

    await toolStarted.promise;
    // Everything spoken before the tool call has reached TTS by the time the
    // tool starts — nothing is still buffered.
    expect(tts.last()?.textChunks.join("")).toBe("Sure, let me");

    await vi.waitFor(() => {
      expect(callbacks.onAgentTranscript).toHaveBeenCalled();
    });
    expect(tts.last()?.textChunks.join("")).toBe("Sure, let me found it.");
    await t.stop();
  });

  test("does not double-space when a segment boundary already carries whitespace", async () => {
    const { opts, stt, callbacks } = makeOpts({
      llm: createFakeLanguageModel({
        steps: [
          [
            { type: "text", text: "First sentence. " },
            { type: "tool-call", toolCallId: "tc-1", toolName: "lookup", input: "{}" },
          ],
          [{ type: "text", text: "Second sentence." }],
        ],
      }),
      executeTool: vi.fn(async () => "result"),
      toolSchemas: [noopToolSchema],
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("look it up");
    await vi.waitFor(() => {
      expect(callbacks.onAgentTranscript).toHaveBeenCalled();
    });
    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith(
      "First sentence. Second sentence.",
      false,
    );
    await t.stop();
  });

  test("TTS audio event is forwarded to callbacks.onAudioChunk as Uint8Array", async () => {
    const { opts, tts, callbacks } = makeOpts();
    const t = createPipelineTransport(opts);
    await t.start();
    const pcm = new Int16Array([100, 200, 300]);
    tts.last()?.fireAudio(pcm);
    expect(callbacks.onAudioChunk).toHaveBeenCalledOnce();
    const arg = firstCallArg<Uint8Array>(callbacks.onAudioChunk);
    expect(arg).toBeInstanceOf(Uint8Array);
    expect(arg.byteLength).toBe(pcm.byteLength);
    await t.stop();
  });

  test("full turn: onUserTranscript → onReplyStarted → onAgentTranscript → onReplyDone (no transport-level onAudioDone)", async () => {
    const { opts, stt, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "Sure!" }] }),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("test question");
    await vi.waitFor(() => {
      expect(callbacks.onReplyDone).toHaveBeenCalledOnce();
    });
    expect(callbacks.onUserTranscript).toHaveBeenCalledWith("test question");
    expect(callbacks.onReplyStarted).toHaveBeenCalled();
    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Sure!", false);
    // onAudioDone is owned by session-core's flushReply, not the transport.
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();
    await t.stop();
  });

  test("truly empty turn (no text, no tool call) skips the TTS flush/await", async () => {
    // Regression: a no-speech turn used to call tts.flush() on a context that
    // received no text, so the provider never emitted `done` and the turn
    // stalled for the full PIPELINE_FLUSH_TIMEOUT_MS.
    const { opts, stt, tts, callbacks } = makeOpts({
      // An empty step yields neither text nor a tool call — nothing spoken.
      llm: createFakeLanguageModel({ steps: [[]] }),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("hello?");
    await vi.waitFor(() => {
      expect(callbacks.onReplyDone).toHaveBeenCalledOnce();
    });
    expect(tts.last()?.flush).not.toHaveBeenCalled();
    expect(callbacks.onAgentTranscript).not.toHaveBeenCalled();
    await t.stop();
  });

  test("covers a silent tool-first turn before the model's reply lands", async () => {
    const { opts, stt, tts } = makeOpts({
      // A 1ms window so the cover fires inside the 20ms the fake LLM spends
      // before its first part; the shipped 5000 would outlast the whole spec.
      deadAirCoverMs: 1,
      llm: createFakeLanguageModel({
        steps: [
          [{ type: "tool-call", toolCallId: "tc-1", toolName: "lookup", input: "{}" }],
          [{ type: "text", text: "Here you go." }],
        ],
        delayMs: 20,
      }),
      executeTool: vi.fn(async () => "ok"),
      toolSchemas: [noopToolSchema],
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("look it up");
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.join("")).toContain("Here you go.");
    });
    const spoken = tts.last()?.textChunks.join("") ?? "";
    // Filler is spoken before the model's reply — no dead air during the tool.
    expect(spoken).toContain(DEAD_AIR_OPENING_PHRASE);
    expect(spoken.indexOf(DEAD_AIR_OPENING_PHRASE)).toBeLessThan(spoken.indexOf("Here you go."));
    await t.stop();
  });

  test("does not inject filler when the model speaks before the tool call", async () => {
    const { opts, stt, tts } = makeOpts({
      llm: createFakeLanguageModel({
        steps: [
          [
            { type: "text", text: "Let me check." },
            { type: "tool-call", toolCallId: "tc-1", toolName: "lookup", input: "{}" },
          ],
          [{ type: "text", text: "Done." }],
        ],
      }),
      executeTool: vi.fn(async () => "ok"),
      toolSchemas: [noopToolSchema],
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("check");
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.join("")).toContain("Done.");
    });
    expect(tts.last()?.textChunks.join("")).not.toContain(DEAD_AIR_OPENING_PHRASE);
    await t.stop();
  });

  test("persists tool calls and results across turns (LLM sees prior tool context)", async () => {
    const { opts, stt, callbacks } = makeOpts({
      // Turn 1: call a tool, then speak. Turn 2: a plain reply.
      llm: createFakeLanguageModel({
        steps: [
          [{ type: "tool-call", toolCallId: "tc-1", toolName: "lookup", input: "{}" }],
          [{ type: "text", text: "Found your account." }],
          [{ type: "text", text: "Anything else?" }],
        ],
      }),
      executeTool: vi.fn(async () => "USER_123"),
      toolSchemas: [noopToolSchema],
    });
    const t = createPipelineTransport(opts);
    await t.start();
    const llm = llmCalls(opts);

    // Turn 1 — runs the tool and finishes speaking. (Matched by substring: at
    // the shipped cover window nothing precedes the reply, but the spec is
    // about the tool context surviving into turn 2, not about the exact text.)
    stt.last()?.fireFinal("look me up");
    await vi.waitFor(() => {
      expect(callbacks.onAgentTranscript).toHaveBeenCalledWith(
        expect.stringContaining("Found your account."),
        false,
      );
    });
    const callsAfterTurn1 = llm.calls.length;

    // Turn 2 — its LLM request must carry turn 1's tool call AND its result,
    // not just the spoken transcript.
    stt.last()?.fireFinal("thanks");
    await vi.waitFor(() => {
      expect(llm.calls.length).toBeGreaterThan(callsAfterTurn1);
    });
    const turn2Prompt = JSON.stringify(llm.calls[callsAfterTurn1]?.prompt);
    expect(turn2Prompt).toContain("lookup"); // the tool call
    expect(turn2Prompt).toContain("USER_123"); // the tool result
    await t.stop();
  });

  test("full assistant reply is pushed via sttSession.updateAgentContext after the turn", async () => {
    const { opts, stt, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "Sure!" }] }),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("test question");
    await vi.waitFor(() => {
      expect(callbacks.onReplyDone).toHaveBeenCalledOnce();
    });
    expect(stt.last()?.updateAgentContext).toHaveBeenCalledWith("Sure!");
    await t.stop();
  });

  test("TTS flush is called after LLM stream finishes", async () => {
    const { opts, stt, tts } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] }),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("go");
    await vi.waitFor(() => {
      expect(tts.last()?.flush).toHaveBeenCalledOnce();
    });
    await t.stop();
  });
});

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
      expect(callbacks.onCancelled).toHaveBeenCalled();
    });
    // Only what reached TTS is published — the coalescer was still batching the
    // rest, which the abort discarded, so the caller heard exactly this much.
    // History below records that same heard prefix, never the buffered tail.
    expect(partialTranscriptSpy(callbacks)).toHaveBeenCalledWith(expect.stringContaining("Your "));
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
    expect(callbacks.onAgentTranscript).not.toHaveBeenCalledWith(expect.anything(), true);

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
    // mid-step signal: sends coalesce to clause boundaries, so step 2's text
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
      expect(callbacks.onCancelled).toHaveBeenCalled();
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
    const { opts, stt, tts, callbacks } = makeOpts({
      // A 1ms window so the filler lands in the 20ms before the model's first
      // part — this is now the turn's OPENING gap rather than a tool-call bet.
      deadAirCoverMs: 1,
      minBargeInWords: 1, // pin so the one-word "stop" barge-in fires (default is now 2)
      llm: createFakeLanguageModel({
        steps: [
          [{ type: "tool-call", toolCallId: "tc-1", toolName: "lookup", input: "{}" }],
          [{ type: "text", text: "Done." }],
        ],
        delayMs: 20,
      }),
      executeTool: vi.fn(async () => {
        await vi.advanceTimersByTimeAsync(100);
        return "ok";
      }),
      toolSchemas: [noopToolSchema],
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.fireFinal("look it up");
    // Wait until the filler has been emitted, then barge in during the tool
    // await, before any real model text.
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.join("")).toContain(DEAD_AIR_OPENING_PHRASE);
    });
    tts.last()?.fireAudio(new Int16Array(2400)); // filler audible → interruptible
    stt.last()?.firePartial("stop");

    await vi.waitFor(() => {
      expect(callbacks.onCancelled).toHaveBeenCalled();
    });
    // The turn's persist decision runs after the in-flight tool call settles
    // (the abort doesn't cut the tool promise short) — await full teardown so
    // the abort-path persist logic has actually had a chance to run before we
    // assert on it, instead of racing it.
    await t.stop();
    // Only the filler was accumulated → nothing persisted as interrupted.
    expect(callbacks.onAgentTranscript).not.toHaveBeenCalledWith(expect.anything(), true);
  });
});

describe("PipelineTransport — below-threshold deferral", () => {
  test("a below-threshold final spoken over the agent is answered after the reply, not dropped", async () => {
    // Regression: a sub-minBargeInWords final used to be discarded while the
    // agent was speaking ("treat as backchannel, ignore"), silently losing real
    // short answers (a "yes", a ZIP) the caller spoke over the reply. It must
    // now be deferred — transcribed and answered once the current reply ends.
    const { opts, stt, tts, callbacks } = makeOpts({
      minBargeInWords: 2, // "sure" (1 word) is below threshold
      llm: createFakeLanguageModel({
        steps: [
          [
            { type: "text", text: "Let me " },
            { type: "text", text: "check that." },
          ],
          [{ type: "text", text: "Confirmed." }],
        ],
        delayMs: 20,
      }),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    const llm = llmCalls(opts);

    stt.last()?.fireFinal("update my order please"); // ≥2 words → starts turn 1
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
    });
    const callsAfterTurn1 = llm.calls.length;

    // One-word final spoken while the agent is still replying — below threshold.
    stt.last()?.fireFinal("sure");

    // It does NOT interrupt the in-flight reply...
    expect(callbacks.onCancelled).not.toHaveBeenCalled();
    // ...but it IS answered: a deferred turn runs after the reply, and its LLM
    // prompt carries the buffered "sure" (proving it was not dropped).
    await vi.waitFor(() => {
      expect(llm.calls.length).toBeGreaterThan(callsAfterTurn1);
    });
    expect(JSON.stringify(llm.calls.at(-1)?.prompt)).toContain("sure");
    await t.stop();
  });
});

describe("PipelineTransport — turn commit on STT final", () => {
  test("every final commits a turn immediately (endpointing is the STT provider's job)", async () => {
    const { opts, stt, callbacks } = makeOpts();
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("track order BOB12"); // no punctuation, still immediate
    expect(callbacks.onUserTranscript).toHaveBeenCalledWith("track order BOB12");
    await t.stop();
  });
});
