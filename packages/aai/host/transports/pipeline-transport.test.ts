// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import {
  createFailingSttProvider,
  createFailingTtsProvider,
  createFakeLanguageModel,
  createFakeTtsProvider,
  type ScriptedPart,
} from "../_pipeline-test-fakes.ts";
import { firstCallArg, makeOpts } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

// Turn-processing specs (STT final → LLM stream → TTS) live in
// pipeline-turn.test.ts; shared helpers in _pipeline-transport-harness.ts.

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

    test("omits temperature when not set (avoids warnings on models that ignore it)", async () => {
      const llm = createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] });
      const { opts, stt } = makeOpts({ llm });
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("hi");
      await vi.waitFor(() => {
        expect(llm.calls.length).toBeGreaterThan(0);
      });
      expect(llm.calls[0]?.temperature).toBeUndefined();
      await t.stop();
    });

    test("forwards an explicit temperature override to doStream", async () => {
      const llm = createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] });
      const { opts, stt } = makeOpts({ llm, temperature: 0.4 });
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("hi");
      await vi.waitFor(() => {
        expect(llm.calls.length).toBeGreaterThan(0);
      });
      expect(llm.calls[0]?.temperature).toBe(0.4);
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

    test("partial STT after the turn finished but with client audio still playing triggers cancel", async () => {
      // Synthesis outruns real-time playback: the server-side turn completes
      // (turnController null) while the client still holds buffered audio.
      // "Stop" arriving in that window must still cancel, or the buffered
      // speech plays out in full.
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script: [{ type: "text", text: "20, 19, 18…" }] }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("count down from 20");
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalled();
      });

      // 10 s of PCM16 at the default 24 kHz — client playback lags well behind.
      tts.last()?.fireAudio(new Int16Array(240_000));

      stt.last()?.firePartial("stop");
      expect(callbacks.onCancelled).toHaveBeenCalled();
      expect(tts.last()?.cancel).toHaveBeenCalled();
      await t.stop();
    });

    test("final STT with client audio still playing cancels stale audio before the new turn", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("count down from 20");
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalled();
      });

      tts.last()?.fireAudio(new Int16Array(240_000));

      stt.last()?.fireFinal("stop that");
      expect(callbacks.onCancelled).toHaveBeenCalled();
      expect(tts.last()?.cancel).toHaveBeenCalled();
      // The new turn still runs after the stale audio is cancelled.
      await vi.waitFor(() => {
        expect(callbacks.onUserTranscript).toHaveBeenCalledWith("stop that");
      });
      await t.stop();
    });

    test("partial STT when idle with no pending playback does not cancel", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("hi");
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalled();
      });

      // No audio was forwarded, so nothing can be playing client-side.
      stt.last()?.firePartial("hello again");
      expect(callbacks.onCancelled).not.toHaveBeenCalled();
      expect(tts.last()?.cancel).not.toHaveBeenCalled();
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
