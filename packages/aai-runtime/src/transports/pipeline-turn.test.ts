// Copyright 2026 the AAI authors. MIT license.
// Turn-processing behaviors of the pipeline transport (STT final → LLM stream →
// TTS): transcript/TTS fan-out, mid-turn tool calls, below-threshold deferral,
// and turn commit. What an INTERRUPTED turn leaves in history lives in
// pipeline-turn-persistence.test.ts; lifecycle/config/error specs in
// pipeline-transport.test.ts.

import type { Message } from "@alexkroman1/aai";
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
    // The other half of the same push: with no dialog declaring keyterms the
    // session asks for the DESCRIPTOR's list back, which is what `undefined`
    // means on that seam — never "clear them".
    expect(stt.last()?.updateKeyterms).toHaveBeenCalledWith(undefined);
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

// The transport's half of the per-turn prompt seam: `sessionConfig.systemPrompt`
// is READ at each turn rather than captured at construction. The resolution
// itself is specced in pipeline-llm-stream.test.ts; this is the wiring.
describe("PipelineTransport — the system prompt is read per turn", () => {
  /** The `system` message of a recorded `doStream` call. */
  function systemOf(call: { prompt?: unknown }): string {
    const prompt = call.prompt;
    if (!Array.isArray(prompt)) throw new Error("no prompt array on the recorded call");
    const system = prompt.find((m) => (m as { role?: string }).role === "system");
    return String((system as { content?: unknown } | undefined)?.content ?? "");
  }

  test("a thunk in sessionConfig reaches the model, and its answer can MOVE mid-call", async () => {
    // Two turns on one session with a phase change between them — the case a
    // captured string cannot express, and the one where the second turn calls
    // no tool so nothing else could have told the model where the call is.
    let phase = "intake";
    const { opts, stt } = makeOpts({
      sessionConfig: { systemPrompt: () => `Phase: ${phase}.`, greeting: "" },
      llm: createFakeLanguageModel({
        steps: [[{ type: "text", text: "one" }], [{ type: "text", text: "two" }]],
      }),
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.fireFinal("first question");
    await vi.waitFor(() => {
      expect(llmCalls(opts).calls).toHaveLength(1);
    });
    phase = "wrap-up";
    stt.last()?.fireFinal("second question");
    await vi.waitFor(() => {
      expect(llmCalls(opts).calls).toHaveLength(2);
    });

    const calls = llmCalls(opts).calls;
    expect(systemOf(calls[0] ?? {})).toBe("Phase: intake.");
    expect(systemOf(calls[1] ?? {})).toBe("Phase: wrap-up.");
    await t.stop();
  });

  test("a plain string still reaches the model unchanged", async () => {
    // The default every shipped agent takes. It must send the same bytes it
    // sent before the option grew a second member.
    const { opts, stt } = makeOpts({
      sessionConfig: { systemPrompt: "Be terse.", greeting: "" },
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("hello");
    await vi.waitFor(() => {
      expect(llmCalls(opts).calls).toHaveLength(1);
    });
    expect(systemOf(llmCalls(opts).calls[0] ?? {})).toBe("Be terse.");
    await t.stop();
  });
});

describe("PipelineTransport — a tool reads what an earlier tool answered", () => {
  /** A recorded `doStream` call's prompt messages. */
  function messagesOf(call: { prompt?: unknown }): unknown[] {
    const prompt = call.prompt;
    if (!Array.isArray(prompt)) throw new Error("no prompt array on the recorded call");
    return prompt;
  }

  test("the SECOND tool call of a turn sees the first call's result in ctx.messages", async () => {
    // The capability `Message`'s `"tool"` arm exists for, and the one nothing
    // produced: a tool chain's later steps could see the user's words and the
    // agent's, and not one thing any tool had returned. The step's own
    // assistant/`tool` message pair only reaches the LLM view when the step
    // ENDS, so waiting for it means the next call in the same reply still reads
    // a history with a hole in it.
    const seen: (readonly Message[])[] = [];
    const { opts, stt, callbacks } = makeOpts({
      llm: createFakeLanguageModel({
        steps: [
          [{ type: "tool-call", toolCallId: "tc-1", toolName: "lookup", input: "{}" }],
          [{ type: "tool-call", toolCallId: "tc-2", toolName: "lookup", input: "{}" }],
          [{ type: "text", text: "Tuesday." }],
        ],
      }),
      executeTool: async (_name, _args, _sid, messages) => {
        seen.push(messages ?? []);
        return `{"eta":"tue","call":${seen.length}}`;
      },
      toolSchemas: [noopToolSchema],
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("where is my order");
    await vi.waitFor(() => {
      expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalled();
    });

    expect(seen).toHaveLength(2);
    // The first call has only the caller's turn — a tool never reads its own
    // result back.
    expect(seen[0]).toEqual([{ role: "user", content: "where is my order" }]);
    expect(seen[1]).toEqual([
      { role: "user", content: "where is my order" },
      {
        role: "tool",
        content: '{"eta":"tue","call":1}',
        toolName: "lookup",
        toolCallId: "tc-1",
      },
    ]);
    await t.stop();
  });

  test("the result survives into the NEXT turn, and never reaches the model twice", async () => {
    // The LLM view already carries the step's own `tool` message; a second copy
    // seeded from the conversation view would be an orphan result — the shape
    // both providers reject outright (`capLlm`).
    const seen: (readonly Message[])[] = [];
    const { opts, stt, callbacks } = makeOpts({
      llm: createFakeLanguageModel({
        steps: [
          [{ type: "tool-call", toolCallId: "tc-1", toolName: "lookup", input: "{}" }],
          [{ type: "text", text: "Tuesday." }],
          [{ type: "tool-call", toolCallId: "tc-2", toolName: "lookup", input: "{}" }],
          [{ type: "text", text: "Still Tuesday." }],
        ],
      }),
      executeTool: async (_name, _args, _sid, messages) => {
        seen.push(messages ?? []);
        return "eta=tue";
      },
      toolSchemas: [noopToolSchema],
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("where is my order");
    await vi.waitFor(() => {
      expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledTimes(1);
    });
    stt.last()?.fireFinal("are you sure");
    await vi.waitFor(() => {
      expect(seen).toHaveLength(2);
    });

    expect(seen[1]).toEqual([
      { role: "user", content: "where is my order" },
      { role: "tool", content: "eta=tue", toolName: "lookup", toolCallId: "tc-1" },
      { role: "assistant", content: "Tuesday." },
      { role: "user", content: "are you sure" },
    ]);
    await t.stop();
  });

  test("a resumed conversation gives a tool the same history a live one does", async () => {
    // `seedHistory` is what a reconnect hands the transport, rebuilt from the
    // session's own event log (`session-event-history.ts`). Its `tool` messages
    // reach `ctx.messages` and NOT the LLM view.
    const seen: (readonly Message[])[] = [];
    const { opts, stt, callbacks } = makeOpts({
      llm: createFakeLanguageModel({
        steps: [
          [{ type: "tool-call", toolCallId: "tc-9", toolName: "lookup", input: "{}" }],
          [{ type: "text", text: "Still Tuesday." }],
        ],
      }),
      executeTool: async (_name, _args, _sid, messages) => {
        seen.push(messages ?? []);
        return "eta=tue";
      },
      toolSchemas: [noopToolSchema],
    });
    const t = createPipelineTransport(opts);
    await t.start();
    t.seedHistory?.([
      { role: "user", content: "where is my order" },
      { role: "tool", content: "eta=tue", toolName: "lookup", toolCallId: "tc-1" },
      { role: "assistant", content: "Tuesday." },
    ]);
    stt.last()?.fireFinal("are you sure");
    await vi.waitFor(() => {
      expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalled();
    });

    expect(seen[0]).toEqual([
      { role: "user", content: "where is my order" },
      { role: "tool", content: "eta=tue", toolName: "lookup", toolCallId: "tc-1" },
      { role: "assistant", content: "Tuesday." },
      { role: "user", content: "are you sure" },
    ]);
    // And the model's own context is untouched by it. A seeded result has no
    // assistant `tool-call` message to answer, so it may not enter the LLM view
    // as a `tool` message (both providers reject an orphan outright) NOR be
    // mapped to an assistant one, which would tell the model it had SAID the
    // tool's serialized output. The check is on the CONTENT for that second
    // reason: a role check alone passes for the mapping that is wrong.
    expect(JSON.stringify(messagesOf(llmCalls(opts).calls[0] ?? {}))).not.toContain("eta=tue");
    await t.stop();
  });
});

describe("PipelineTransport — the model-tuning knobs reach the request", () => {
  /** Run one turn and hand back what the provider was called with. */
  async function oneTurn(
    overrides: Parameters<typeof makeOpts>[0],
  ): Promise<Record<string, unknown>> {
    const { opts, stt } = makeOpts(overrides);
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("hello");
    // A poll rather than an assertion: this helper runs outside a `test()`
    // body, where Biome refuses `expect`.
    await vi.waitFor(() => {
      if (llmCalls(opts).calls.length === 0) throw new Error("no LLM call yet");
    });
    const call = llmCalls(opts).calls[0] ?? {};
    await t.stop();
    return call;
  }

  test("maxOutputTokens reaches the provider call", async () => {
    expect(await oneTurn({ maxOutputTokens: 256 })).toMatchObject({ maxOutputTokens: 256 });
  });

  test("unset, the provider is asked for no cap at all", async () => {
    // Forwarded by PRESENCE, like `temperature`: `streamText` normalizes an
    // absent key to `undefined` on the way to the provider, and an agent that
    // set nothing must not end up sending a number somebody guessed.
    expect(await oneTurn({})).toMatchObject({ maxOutputTokens: undefined });
  });

  test("maxRetries is accepted at this layer", async () => {
    // It is the AI SDK's own retry WRAPPER rather than a provider parameter, so
    // it is not visible in the recorded call — what this pins is that passing
    // it does not break the request. Its scope rule is covered where it can be:
    // `config-rules-scope.test.ts` refuses it in s2s and keeps `0` from being
    // swallowed by a default.
    expect(await oneTurn({ maxRetries: 0 })).toMatchObject({ maxOutputTokens: undefined });
  });
});
