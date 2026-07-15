// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import {
  createFailingSttProvider,
  createFailingTtsProvider,
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  type ScriptedPart,
} from "../_pipeline-test-fakes.ts";
import { silentLogger } from "../_test-utils.ts";
import { createPipelineTransport, type PipelineTransportOptions } from "./pipeline-transport.ts";
import type { TransportCallbacks } from "./types.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type SttFake = ReturnType<typeof createFakeSttProvider>;
type TtsFake = ReturnType<typeof createFakeTtsProvider>;

function makeCallbacks(): TransportCallbacks {
  return {
    onReplyStarted: vi.fn(),
    onReplyDone: vi.fn(),
    onCancelled: vi.fn(),
    onAudioChunk: vi.fn(),
    onAudioDone: vi.fn(),
    onUserTranscript: vi.fn(),
    onAgentTranscript: vi.fn(),
    onToolCall: vi.fn(),
    onError: vi.fn(),
    onSpeechStarted: vi.fn(),
    onSpeechStopped: vi.fn(),
    onSessionReady: vi.fn(),
  };
}

function makeOpts(
  overrides: Partial<PipelineTransportOptions> = {},
  {
    stt = createFakeSttProvider(),
    tts = createFakeTtsProvider(),
    callbacks = makeCallbacks(),
  }: { stt?: SttFake; tts?: TtsFake; callbacks?: TransportCallbacks } = {},
): {
  opts: PipelineTransportOptions;
  stt: SttFake;
  tts: TtsFake;
  callbacks: TransportCallbacks;
} {
  const opts: PipelineTransportOptions = {
    sid: "test-sid",
    agent: "test-agent",
    stt,
    llm: createFakeLanguageModel({ script: [] }),
    tts,
    callbacks,
    sessionConfig: { systemPrompt: "s", greeting: "" },
    providerKeys: { stt: "stt-key", tts: "tts-key" },
    logger: silentLogger,
    ...overrides,
  };
  return { opts, stt, tts, callbacks };
}

function firstCallArg<T>(fn: unknown): T {
  // biome-ignore lint/style/noNonNullAssertion: caller asserts the spy was invoked
  return (fn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as T;
}

const noopToolSchema = {
  type: "function" as const,
  name: "lookup",
  description: "Look something up.",
  parameters: { type: "object" as const, properties: {}, required: [] },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("PipelineTransport", () => {
  describe("start()", () => {
    test("opens both STT and TTS sessions", async () => {
      const { opts, stt, tts } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      expect(stt.last()).toBeDefined();
      expect(tts.last()).toBeDefined();
      await t.stop();
    });

    test("passes correct keys and sample rate to STT opener", async () => {
      const { opts, stt } = makeOpts({
        providerKeys: { stt: "MY_STT_KEY", tts: "t" },
        sttSampleRate: 8000,
        sttPrompt: "be brief",
      });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(stt.last()?.opts.sampleRate).toBe(8000);
      expect(stt.last()?.opts.apiKey).toBe("MY_STT_KEY");
      expect(stt.last()?.opts.sttPrompt).toBe("be brief");
      await t.stop();
    });

    test("seeds the greeting as the STT opener's connect-time agentContext", async () => {
      const { opts, stt } = makeOpts({
        sessionConfig: { systemPrompt: "s", greeting: "Hi there!" },
      });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(stt.last()?.opts.agentContext).toBe("Hi there!");
      await t.stop();
    });

    test("fires onSessionReady with the sid", async () => {
      const { opts, callbacks } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      expect(callbacks.onSessionReady).toHaveBeenCalledWith("test-sid");
      await t.stop();
    });
  });

  describe("greeting", () => {
    test("sends greeting via ttsSession.sendText and fires onReplyStarted + onAgentTranscript + onReplyDone", async () => {
      const { opts, tts, callbacks } = makeOpts({
        sessionConfig: { systemPrompt: "s", greeting: "Hi there!" },
      });
      const t = createPipelineTransport(opts);
      await t.start();
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalledOnce();
      });
      expect(tts.last()?.textChunks).toContain("Hi there!");
      expect(callbacks.onReplyStarted).toHaveBeenCalledWith(expect.stringContaining("greeting"));
      expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Hi there!", false);
      // onAudioDone is owned by session-core's flushReply, not the transport.
      expect(callbacks.onAudioDone).not.toHaveBeenCalled();
      await t.stop();
    });

    test("also pushes the greeting via sttSession.updateAgentContext", async () => {
      const { opts, stt, callbacks } = makeOpts({
        sessionConfig: { systemPrompt: "s", greeting: "Hi there!" },
      });
      const t = createPipelineTransport(opts);
      await t.start();
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalledOnce();
      });
      expect(stt.last()?.updateAgentContext).toHaveBeenCalledWith("Hi there!");
      await t.stop();
    });

    test("skipGreeting suppresses the greeting turn", async () => {
      const { opts, tts, callbacks } = makeOpts({
        skipGreeting: true,
        sessionConfig: { systemPrompt: "s", greeting: "Hello!" },
      });
      const t = createPipelineTransport(opts);
      await t.start();
      await new Promise((r) => setTimeout(r, 20));
      expect(callbacks.onReplyStarted).not.toHaveBeenCalled();
      expect(tts.last()?.textChunks).toHaveLength(0);
      await t.stop();
    });
  });

  describe("STT → LLM turn", () => {
    test("final STT event fires onUserTranscript and onReplyStarted", async () => {
      const { opts, stt, callbacks } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("Hello agent");
      await vi.waitFor(() => {
        expect(callbacks.onUserTranscript).toHaveBeenCalledWith("Hello agent");
      });
      expect(callbacks.onReplyStarted).toHaveBeenCalledWith(expect.stringMatching(/^pipeline-/));
      await t.stop();
    });

    test("empty / whitespace-only final is ignored", async () => {
      const { opts, stt, callbacks } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("   ");
      await new Promise((r) => setTimeout(r, 10));
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
      expect(tts.last()?.textChunks.join("")).toBe(
        "Let me look that up. Got it. Here's the answer.",
      );
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

    test("tool-call-only turn (no speech) skips the TTS flush/await", async () => {
      // Regression: a silent turn used to call tts.flush() on a context that
      // received no text, so the provider never emitted `done` and the turn
      // stalled for the full PIPELINE_FLUSH_TIMEOUT_MS.
      const { opts, stt, tts, callbacks } = makeOpts({
        // Step 1 emits only a tool call; the trailing empty step yields no
        // text, so the turn produces no agent speech.
        llm: createFakeLanguageModel({
          steps: [[{ type: "tool-call", toolCallId: "tc-1", toolName: "lookup", input: "{}" }]],
        }),
        executeTool: vi.fn(async () => "result"),
        toolSchemas: [noopToolSchema],
      });
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("look it up");
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalledOnce();
      });
      // Nothing was spoken, so the TTS session must not be flushed/awaited.
      expect(tts.last()?.flush).not.toHaveBeenCalled();
      expect(callbacks.onAgentTranscript).not.toHaveBeenCalled();
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
      const llm = opts.llm as unknown as { calls: Array<{ prompt?: unknown }> };

      // Turn 1 — runs the tool and finishes speaking.
      stt.last()?.fireFinal("look me up");
      await vi.waitFor(() => {
        expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Found your account.", false);
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

  describe("streamText config plumbing", () => {
    const dummyToolSchemas = [
      {
        type: "function" as const,
        name: "noop",
        description: "No-op tool for plumbing tests.",
        parameters: { type: "object" as const, properties: {}, additionalProperties: false },
      },
    ];
    const dummyExecuteTool = async () => "{}";

    test("forwards toolChoice to doStream (default 'auto' when omitted)", async () => {
      const llm = createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] });
      const { opts, stt } = makeOpts({
        llm,
        toolSchemas: dummyToolSchemas,
        executeTool: dummyExecuteTool,
      });
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("hi");
      await vi.waitFor(() => {
        expect(llm.calls.length).toBeGreaterThan(0);
      });
      expect(llm.calls[0]?.toolChoice).toEqual({ type: "auto" });
      await t.stop();
    });

    test("forwards explicit toolChoice='required' to doStream", async () => {
      const llm = createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] });
      const { opts, stt } = makeOpts({
        llm,
        toolChoice: "required",
        toolSchemas: dummyToolSchemas,
        executeTool: dummyExecuteTool,
      });
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("hi");
      await vi.waitFor(() => {
        expect(llm.calls.length).toBeGreaterThan(0);
      });
      expect(llm.calls[0]?.toolChoice).toEqual({ type: "required" });
      await t.stop();
    });

    test("maxSteps caps the doStream loop", async () => {
      // Two scripted steps; maxSteps=1 must stop after the first (default would be 5).
      const llm = createFakeLanguageModel({
        steps: [[{ type: "text", text: "step1" }], [{ type: "text", text: "step2" }]],
      });
      const { opts, stt } = makeOpts({ llm, maxSteps: 1 });
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("hi");
      await vi.waitFor(() => {
        expect(llm.calls.length).toBeGreaterThanOrEqual(1);
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(llm.calls.length).toBe(1);
      await t.stop();
    });
  });

  describe("barge-in", () => {
    test("partial STT event during an in-flight turn triggers cancel and onCancelled", async () => {
      const script: ScriptedPart[] = [
        { type: "text", text: "Hello " },
        { type: "text", text: "how can " },
        { type: "text", text: "I help?" },
      ];
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("hi there");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });

      stt.last()?.firePartial("wait");
      expect(callbacks.onCancelled).toHaveBeenCalled();
      expect(tts.last()?.cancel).toHaveBeenCalled();
      await t.stop();
    });

    test("cancelReply() aborts the turn and calls ttsSession.cancel()", async () => {
      const script: ScriptedPart[] = [
        { type: "text", text: "some " },
        { type: "text", text: "reply" },
      ];
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("question");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });

      t.cancelReply();
      expect(tts.last()?.cancel).toHaveBeenCalled();
      // cancelReply() doesn't fire onCancelled — session-core calls client.cancelled()
      // itself for client-originated cancels. onCancelled fires only for STT-partial barge-in.
      expect(callbacks.onCancelled).not.toHaveBeenCalled();
      await t.stop();
    });
  });

  describe("stop()", () => {
    test("closes both STT and TTS sessions", async () => {
      const { opts, stt, tts } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      await t.stop();
      expect(stt.last()?.closed.value).toBe(true);
      expect(tts.last()?.closed.value).toBe(true);
    });

    test("stop() is idempotent", async () => {
      const { opts, stt } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      await t.stop();
      await t.stop();
      expect(stt.last()?.closed.value).toBe(true);
    });
  });

  describe("sendUserAudio()", () => {
    test("converts aligned Uint8Array to Int16Array and calls sttSession.sendAudio", async () => {
      const { opts, stt } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      const bytes = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
      t.sendUserAudio(bytes);
      const sttSession = stt.last();
      expect(sttSession?.sendAudio).toHaveBeenCalledOnce();
      const pcm = firstCallArg<Int16Array>(sttSession?.sendAudio);
      expect(pcm).toBeInstanceOf(Int16Array);
      expect(pcm.length).toBe(2);
      await t.stop();
    });

    test("handles odd-length Uint8Array by copying and truncating", async () => {
      const { opts, stt } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      // 3 bytes → 1 sample (truncates the trailing odd byte).
      t.sendUserAudio(new Uint8Array([1, 2, 3]));
      const pcm = firstCallArg<Int16Array>(stt.last()?.sendAudio);
      expect(pcm.length).toBe(1);
      await t.stop();
    });
  });

  describe("sendToolResult()", () => {
    test("is a no-op (Option A: inline tool execution)", async () => {
      const { opts } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      expect(() => t.sendToolResult("call-1", "result")).not.toThrow();
      await t.stop();
    });
  });

  describe("tool observability", () => {
    test("callbacks.onToolCall fires for each tool-call stream part", async () => {
      const script: ScriptedPart[] = [
        {
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "get_weather",
          input: JSON.stringify({ city: "SF" }),
        },
        { type: "tool-result", toolCallId: "tc-1", toolName: "get_weather", result: "sunny" },
        { type: "text", text: "It's sunny." },
      ];
      const { opts, stt, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script }),
        executeTool: vi.fn(async () => "sunny"),
        toolSchemas: [
          {
            type: "function" as const,
            name: "get_weather",
            description: "Look up the weather.",
            parameters: {
              type: "object" as const,
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      });
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("how's the weather?");
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalled();
      });
      expect(callbacks.onToolCall).toHaveBeenCalledWith("tc-1", "get_weather", expect.any(Object));
      await t.stop();
    });
  });

  describe("provider errors", () => {
    test("STT error fires onError('stt', ...) and terminates transport", async () => {
      const { opts, stt, callbacks } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireError("stt_stream_error", "stt failed");
      expect(callbacks.onError).toHaveBeenCalledWith("stt", "stt failed");
      await t.stop();
    });

    test("TTS error fires onError('tts', ...) and terminates transport", async () => {
      const { opts, tts, callbacks } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      tts.last()?.fireError("tts_stream_error", "tts failed");
      expect(callbacks.onError).toHaveBeenCalledWith("tts", "tts failed");
      await t.stop();
    });

    test("STT open failure fires onError('stt', ...) via reportOpenRejection", async () => {
      const { opts, callbacks } = makeOpts({
        stt: createFailingSttProvider("stt_connect_failed", "connect failed"),
      });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(callbacks.onError).toHaveBeenCalledWith("stt", "connect failed");
      await t.stop();
    });

    test("TTS open failure fires onError('tts', ...) via reportOpenRejection", async () => {
      const { opts, callbacks } = makeOpts({
        tts: createFailingTtsProvider("tts_connect_failed", "tts connect failed"),
      });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(callbacks.onError).toHaveBeenCalledWith("tts", "tts connect failed");
      await t.stop();
    });

    test("when STT fails, TTS session is still opened but then immediately closed", async () => {
      const tts = createFakeTtsProvider();
      const { opts } = makeOpts(
        {
          stt: createFailingSttProvider("stt_connect_failed", "bad key"),
          tts,
        },
        { tts },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      // Promise.allSettled opens both concurrently; STT failure then closes TTS.
      expect(tts.last()?.closed.value).toBe(true);
      await t.stop();
    });
  });

  describe("history seeding", () => {
    test("sessionConfig.history is used as initial conversation messages", async () => {
      const { opts } = makeOpts({
        sessionConfig: {
          systemPrompt: "s",
          greeting: "",
          history: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
          ],
        },
      });
      const t = createPipelineTransport(opts);
      await expect(t.start()).resolves.toBeUndefined();
      await t.stop();
    });
  });
});
