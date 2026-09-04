// Copyright 2026 the AAI authors. MIT license.
// Turn-processing behaviors of the pipeline transport (STT final → LLM stream →
// TTS): transcript/TTS fan-out, mid-turn tool calls, below-threshold deferral,
// and turn commit. What an INTERRUPTED turn leaves in history lives in
// pipeline-turn-persistence.test.ts; lifecycle/config/error specs in
// pipeline-transport.test.ts.

import { DEAD_AIR_OPENING_PHRASE } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel, type ScriptedPart } from "../_pipeline-test-fakes.ts";
import {
  firstCallArg,
  llmCalls,
  makeOpts,
  noopToolSchema,
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
      expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledWith({
        type: "user-transcript.committed",
        text: "Hello agent",
      });
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
    expect(callbacks.reported("user-transcript.committed")).not.toHaveBeenCalled();
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
      expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalled();
    });
    expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledWith({
      type: "agent-transcript.committed",
      text: "Let me look that up. Got it. Here's the answer.",
    });
    expect(tts.last()?.textChunks.join("")).toBe("Let me look that up. Got it. Here's the answer.");
    await t.stop();
  });

  test("speaks a sub-threshold pre-tool fragment before the tool runs", async () => {
    // Regression: TTS text is coalesced, and "let me" is short and unpunctuated,
    // so it used to sit in the batch buffer for the whole tool-execution window
    // — the caller heard "Sure," then dead air. The segment boundary must
    // release it.
    const toolStarted = Promise.withResolvers<void>();
    // Holds the tool open so the assertion below lands INSIDE the execution
    // window. Waiting on `toolStarted` alone asserted an ordering the SDK does
    // not promise: the tool runs concurrently with our `fullStream` read, so
    // whether the `tool-call` part has been handled by the time `execute` is
    // entered is the SDK's scheduling, and ai@7.0.71 changed it (it wraps the
    // streaming callbacks now, one turn of the microtask queue earlier). What
    // the caller actually hears turns on the fragment being released before
    // the tool RETURNS, which is what this holds the window open to state.
    const finishTool = Promise.withResolvers<void>();
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
        await finishTool.promise;
        return "result";
      }),
      toolSchemas: [noopToolSchema],
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("look it up");

    await toolStarted.promise;
    // Everything spoken before the tool call reaches TTS while the tool is
    // still running — nothing sits in the batch buffer for the window.
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.join("")).toBe("Sure, let me");
    });
    finishTool.resolve();

    await vi.waitFor(() => {
      expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalled();
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
      expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalled();
    });
    expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledWith({
      type: "agent-transcript.committed",
      text: "First sentence. Second sentence.",
    });
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
      expect(callbacks.reported("reply.completed")).toHaveBeenCalledOnce();
    });
    expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledWith({
      type: "user-transcript.committed",
      text: "test question",
    });
    expect(callbacks.onReplyStarted).toHaveBeenCalled();
    expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledWith({
      type: "agent-transcript.committed",
      text: "Sure!",
    });
    // onAudioDone is owned by session-core's flushReply, not the transport.
    expect(callbacks.reported("audio.completed")).not.toHaveBeenCalled();
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
      expect(callbacks.reported("reply.completed")).toHaveBeenCalledOnce();
    });
    expect(tts.last()?.flush).not.toHaveBeenCalled();
    expect(callbacks.reported("agent-transcript.committed")).not.toHaveBeenCalled();
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
      expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledWith({
        type: "agent-transcript.committed",
        text: expect.stringContaining("Found your account."),
      });
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
      expect(callbacks.reported("reply.completed")).toHaveBeenCalledOnce();
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
    expect(callbacks.reported("reply.cancelled")).not.toHaveBeenCalled();
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
    expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledWith({
      type: "user-transcript.committed",
      text: "track order BOB12",
    });
    await t.stop();
  });
});
