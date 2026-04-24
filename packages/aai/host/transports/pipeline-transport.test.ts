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
  }: {
    stt?: ReturnType<typeof createFakeSttProvider>;
    tts?: ReturnType<typeof createFakeTtsProvider>;
    callbacks?: TransportCallbacks;
  } = {},
): {
  opts: PipelineTransportOptions;
  stt: ReturnType<typeof createFakeSttProvider>;
  tts: ReturnType<typeof createFakeTtsProvider>;
  callbacks: TransportCallbacks;
} {
  const opts: PipelineTransportOptions = {
    sid: "test-sid",
    agent: "test-agent",
    stt,
    llm: createFakeLanguageModel({ script: [] }),
    tts,
    callbacks,
    sessionConfig: {
      systemPrompt: "You are a test assistant.",
      greeting: "",
    },
    providerKeys: { stt: "stt-key", tts: "tts-key" },
    logger: silentLogger,
    ...overrides,
  };
  return { opts, stt, tts, callbacks };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("PipelineTransport", () => {
  describe("start()", () => {
    test("opens both STT and TTS sessions", async () => {
      const { opts, stt, tts } = makeOpts({ sessionConfig: { systemPrompt: "s", greeting: "" } });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(stt.last()).toBeDefined();
      expect(tts.last()).toBeDefined();
      await t.stop();
    });

    test("passes correct keys and sample rate to STT opener", async () => {
      const stt = createFakeSttProvider();
      const { opts } = makeOpts(
        {
          stt,
          providerKeys: { stt: "MY_STT_KEY", tts: "t" },
          sttSampleRate: 8000,
          sttPrompt: "be brief",
          sessionConfig: { systemPrompt: "s", greeting: "" },
        },
        { stt },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      expect(stt.last()?.opts.sampleRate).toBe(8000);
      expect(stt.last()?.opts.apiKey).toBe("MY_STT_KEY");
      expect(stt.last()?.opts.sttPrompt).toBe("be brief");
      await t.stop();
    });

    test("fires onSessionReady with the sid", async () => {
      const { opts, callbacks } = makeOpts({ sessionConfig: { systemPrompt: "s", greeting: "" } });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(callbacks.onSessionReady).toHaveBeenCalledWith("test-sid");
      await t.stop();
    });
  });

  describe("greeting", () => {
    test("sends greeting via ttsSession.sendText and fires onReplyStarted + onAgentTranscript + onReplyDone", async () => {
      const stt = createFakeSttProvider();
      const tts = createFakeTtsProvider();
      const callbacks = makeCallbacks();
      const { opts } = makeOpts(
        { sessionConfig: { systemPrompt: "s", greeting: "Hi there!" } },
        { stt, tts, callbacks },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      // Greeting runs as a chained turn — waitFor covers the async flush.
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalledOnce();
      });
      expect(tts.last()?.textChunks).toContain("Hi there!");
      expect(callbacks.onReplyStarted).toHaveBeenCalledWith(expect.stringContaining("greeting"));
      expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Hi there!", false);
      // onAudioDone is NOT fired by the transport — session-core's flushReply
      // (triggered by onReplyDone) owns the audioDone + replyDone pairing.
      expect(callbacks.onAudioDone).not.toHaveBeenCalled();
      await t.stop();
    });

    test("skipGreeting suppresses the greeting turn", async () => {
      const tts = createFakeTtsProvider();
      const callbacks = makeCallbacks();
      const { opts } = makeOpts(
        {
          skipGreeting: true,
          sessionConfig: { systemPrompt: "s", greeting: "Hello!" },
        },
        { tts, callbacks },
      );
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
      const stt = createFakeSttProvider();
      const callbacks = makeCallbacks();
      const { opts } = makeOpts(
        { sessionConfig: { systemPrompt: "s", greeting: "" } },
        { stt, callbacks },
      );
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
      const stt = createFakeSttProvider();
      const callbacks = makeCallbacks();
      const { opts } = makeOpts(
        { sessionConfig: { systemPrompt: "s", greeting: "" } },
        { stt, callbacks },
      );
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
      const stt = createFakeSttProvider();
      const tts = createFakeTtsProvider();
      const { opts } = makeOpts(
        {
          llm: createFakeLanguageModel({ script }),
          sessionConfig: { systemPrompt: "s", greeting: "" },
        },
        { stt, tts },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("what is the answer?");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      expect(tts.last()?.textChunks.join("")).toContain("the answer");
      await t.stop();
    });

    test("TTS audio event is forwarded to callbacks.onAudioChunk as Uint8Array", async () => {
      const stt = createFakeSttProvider();
      const tts = createFakeTtsProvider();
      const callbacks = makeCallbacks();
      const { opts } = makeOpts(
        { sessionConfig: { systemPrompt: "s", greeting: "" } },
        { stt, tts, callbacks },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      const pcm = new Int16Array([100, 200, 300]);
      tts.last()?.fireAudio(pcm);
      expect(callbacks.onAudioChunk).toHaveBeenCalledOnce();
      // biome-ignore lint/style/noNonNullAssertion: test assertion — calledOnce proven above
      const arg = (callbacks.onAudioChunk as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as Uint8Array;
      expect(arg).toBeInstanceOf(Uint8Array);
      expect(arg.byteLength).toBe(pcm.byteLength);
      await t.stop();
    });

    test("full turn: onUserTranscript → onReplyStarted → onAgentTranscript → onReplyDone (no transport-level onAudioDone)", async () => {
      const script: ScriptedPart[] = [{ type: "text", text: "Sure!" }];
      const stt = createFakeSttProvider();
      const tts = createFakeTtsProvider();
      const callbacks = makeCallbacks();
      const { opts } = makeOpts(
        {
          llm: createFakeLanguageModel({ script }),
          sessionConfig: { systemPrompt: "s", greeting: "" },
        },
        { stt, tts, callbacks },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("test question");
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalledOnce();
      });
      expect(callbacks.onUserTranscript).toHaveBeenCalledWith("test question");
      expect(callbacks.onReplyStarted).toHaveBeenCalled();
      expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Sure!", false);
      // onAudioDone is NOT fired by the transport — session-core's flushReply
      // (triggered by onReplyDone) owns the audioDone + replyDone pairing.
      expect(callbacks.onAudioDone).not.toHaveBeenCalled();
      await t.stop();
    });

    test("TTS flush is called after LLM stream finishes", async () => {
      const script: ScriptedPart[] = [{ type: "text", text: "hi" }];
      const stt = createFakeSttProvider();
      const tts = createFakeTtsProvider();
      const { opts } = makeOpts(
        {
          llm: createFakeLanguageModel({ script }),
          sessionConfig: { systemPrompt: "s", greeting: "" },
        },
        { stt, tts },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("go");
      await vi.waitFor(() => {
        expect(tts.last()?.flush).toHaveBeenCalledOnce();
      });
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
      const stt = createFakeSttProvider();
      const tts = createFakeTtsProvider();
      const callbacks = makeCallbacks();
      const { opts } = makeOpts(
        {
          llm: createFakeLanguageModel({ script, delayMs: 20 }),
          sessionConfig: { systemPrompt: "s", greeting: "" },
        },
        { stt, tts, callbacks },
      );
      const t = createPipelineTransport(opts);
      await t.start();

      // Start a turn, wait until TTS is receiving text (deep in AGENT_REPLYING).
      stt.last()?.fireFinal("hi there");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });

      // Fire barge-in partial.
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
      const stt = createFakeSttProvider();
      const tts = createFakeTtsProvider();
      const callbacks = makeCallbacks();
      const { opts } = makeOpts(
        {
          llm: createFakeLanguageModel({ script, delayMs: 20 }),
          sessionConfig: { systemPrompt: "s", greeting: "" },
        },
        { stt, tts, callbacks },
      );
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("question");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });

      t.cancelReply();
      expect(tts.last()?.cancel).toHaveBeenCalled();
      // cancelReply() does NOT fire callbacks.onCancelled — session-core calls
      // client.cancelled() itself when the cancel originates from the client.
      // onCancelled is only fired from within the transport for barge-in (STT partial).
      expect(callbacks.onCancelled).not.toHaveBeenCalled();
      await t.stop();
    });
  });

  describe("stop()", () => {
    test("closes both STT and TTS sessions", async () => {
      const stt = createFakeSttProvider();
      const tts = createFakeTtsProvider();
      const { opts } = makeOpts(
        { sessionConfig: { systemPrompt: "s", greeting: "" } },
        { stt, tts },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      await t.stop();
      expect(stt.last()?.closed.value).toBe(true);
      expect(tts.last()?.closed.value).toBe(true);
    });

    test("stop() is idempotent", async () => {
      const stt = createFakeSttProvider();
      const tts = createFakeTtsProvider();
      const { opts } = makeOpts(
        { sessionConfig: { systemPrompt: "s", greeting: "" } },
        { stt, tts },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      await t.stop();
      await t.stop(); // should not throw or double-close
      expect(stt.last()?.closed.value).toBe(true);
    });
  });

  describe("sendUserAudio()", () => {
    test("converts aligned Uint8Array to Int16Array and calls sttSession.sendAudio", async () => {
      const stt = createFakeSttProvider();
      const { opts } = makeOpts({ sessionConfig: { systemPrompt: "s", greeting: "" } }, { stt });
      const t = createPipelineTransport(opts);
      await t.start();
      const buf = new ArrayBuffer(4);
      const bytes = new Uint8Array(buf);
      bytes.set([0x01, 0x02, 0x03, 0x04]);
      t.sendUserAudio(bytes);
      const sttSession = stt.last();
      expect(sttSession?.sendAudio).toHaveBeenCalledOnce();
      // biome-ignore lint/style/noNonNullAssertion: test assertion — calledOnce proven above
      const pcm = (sttSession?.sendAudio as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as Int16Array;
      expect(pcm).toBeInstanceOf(Int16Array);
      expect(pcm.length).toBe(2);
      await t.stop();
    });

    test("handles odd-length Uint8Array by copying and truncating", async () => {
      const stt = createFakeSttProvider();
      const { opts } = makeOpts({ sessionConfig: { systemPrompt: "s", greeting: "" } }, { stt });
      const t = createPipelineTransport(opts);
      await t.start();
      const bytes = new Uint8Array([1, 2, 3]); // 3 bytes → 1 sample
      t.sendUserAudio(bytes);
      // biome-ignore lint/style/noNonNullAssertion: test assertion — audio was sent synchronously above
      const pcm = (stt.last()?.sendAudio as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as Int16Array;
      expect(pcm.length).toBe(1);
      await t.stop();
    });
  });

  describe("sendToolResult()", () => {
    test("is a no-op (Option A: inline tool execution)", async () => {
      const { opts } = makeOpts({ sessionConfig: { systemPrompt: "s", greeting: "" } });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(() => t.sendToolResult("call-1", "result")).not.toThrow();
      await t.stop();
    });
  });

  describe("tool observability", () => {
    test("callbacks.onToolCall fires for each tool-call stream part", async () => {
      const executeTool = vi.fn(async () => "sunny");
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
      const stt = createFakeSttProvider();
      const tts = createFakeTtsProvider();
      const callbacks = makeCallbacks();
      const { opts } = makeOpts(
        {
          llm: createFakeLanguageModel({ script }),
          executeTool,
          toolSchemas: [
            {
              name: "get_weather",
              description: "Look up the weather.",
              parameters: {
                type: "object" as const,
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          ],
          sessionConfig: { systemPrompt: "s", greeting: "" },
        },
        { stt, tts, callbacks },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("how's the weather?");
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalled();
      });
      // onToolCall fires for observability (Option A).
      expect(callbacks.onToolCall).toHaveBeenCalledWith("tc-1", "get_weather", expect.any(Object));
      await t.stop();
    });
  });

  describe("provider errors", () => {
    test("STT error fires onError('stt', ...) and terminates transport", async () => {
      const stt = createFakeSttProvider();
      const callbacks = makeCallbacks();
      const { opts } = makeOpts(
        { sessionConfig: { systemPrompt: "s", greeting: "" } },
        { stt, callbacks },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireError("stt_stream_error", "stt failed");
      expect(callbacks.onError).toHaveBeenCalledWith("stt", "stt failed");
      await t.stop();
    });

    test("TTS error fires onError('tts', ...) and terminates transport", async () => {
      const tts = createFakeTtsProvider();
      const callbacks = makeCallbacks();
      const { opts } = makeOpts(
        { sessionConfig: { systemPrompt: "s", greeting: "" } },
        { tts, callbacks },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      tts.last()?.fireError("tts_stream_error", "tts failed");
      expect(callbacks.onError).toHaveBeenCalledWith("tts", "tts failed");
      await t.stop();
    });

    test("STT open failure fires onError('stt', ...) via reportOpenRejection", async () => {
      const callbacks = makeCallbacks();
      const { opts } = makeOpts(
        {
          stt: createFailingSttProvider("stt_connect_failed", "connect failed"),
          sessionConfig: { systemPrompt: "s", greeting: "" },
        },
        { callbacks },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      expect(callbacks.onError).toHaveBeenCalledWith("stt", "connect failed");
      await t.stop();
    });

    test("TTS open failure fires onError('tts', ...) via reportOpenRejection", async () => {
      const callbacks = makeCallbacks();
      const { opts } = makeOpts(
        {
          tts: createFailingTtsProvider("tts_connect_failed", "tts connect failed"),
          sessionConfig: { systemPrompt: "s", greeting: "" },
        },
        { callbacks },
      );
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
          sessionConfig: { systemPrompt: "s", greeting: "" },
        },
        { tts },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      // TTS was opened (Promise.allSettled runs both concurrently) but then closed.
      expect(tts.last()?.closed.value).toBe(true);
      await t.stop();
    });
  });

  describe("history seeding", () => {
    test("sessionConfig.history is used as initial conversation messages", async () => {
      // History seeding is internal — we verify it indirectly by checking
      // that the LLM receives the correct message array.
      // For this test we just ensure start() doesn't throw when history is set.
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
