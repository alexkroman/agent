// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import type { SttOpener, SttSession } from "../../sdk/providers.ts";
import {
  createFailingSttProvider,
  createFailingTtsProvider,
  createFakeLanguageModel,
  createFakeTtsProvider,
  type ScriptedPart,
} from "../_pipeline-test-fakes.ts";
import { firstCallArg, makeOpts, useVirtualTime } from "./_pipeline-transport-harness.ts";
import { makeCallbacks } from "./_transport-recorder.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

// Turn-processing specs (STT final → LLM stream → TTS) live in
// pipeline-turn.test.ts; barge-in/interruption specs live in
// pipeline-transport-barge-in.test.ts; the greeting turn (at start and on
// reset) in pipeline-greeting.test.ts; shared helpers in
// _pipeline-transport-harness.ts.

// ─── Tests ───────────────────────────────────────────────────────────────────

useVirtualTime();

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
      await vi.advanceTimersByTimeAsync(20);
      expect(llm.calls.length).toBe(1);
      await t.stop();
    });

    // Hitting the cap used to end the turn wherever it landed — including
    // straight after a tool result, with nothing said. The reply then
    // completed "successfully" with an empty transcript, so `errorPhrase`
    // never fired either and the caller just heard the agent stop. `maxSteps`
    // now bounds TOOL steps, and the step after the budget is forced to
    // `toolChoice: "none"` so the model has to speak. This is what makes a low
    // default (3) safe; the two must not be changed apart.
    test("a turn that exhausts maxSteps spends one more step answering, tools off", async () => {
      const toolStep: ScriptedPart[] = [
        {
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "get_weather",
          input: JSON.stringify({ city: "SF" }),
        },
      ];
      const llm = createFakeLanguageModel({
        // Three tool-calling steps offered, but only two are affordable at
        // maxSteps=2 — the model would keep going if nothing stopped it.
        steps: [toolStep, toolStep, toolStep, [{ type: "text", text: "It's sunny." }]],
      });
      const { opts, stt, callbacks } = makeOpts({
        llm,
        maxSteps: 2,
        executeTool: vi.fn(async () => "sunny"),
        toolSchemas: [
          {
            type: "function" as const,
            name: "get_weather",
            description: "Look up the weather.",
            parameters: { type: "object" as const, properties: {} },
          },
        ],
      });
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("how's the weather?");
      await vi.waitFor(() => {
        expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
      });
      // Two tool steps, then exactly one forced answer step — not a third
      // tool step, and not silence.
      expect(llm.calls.length).toBe(3);
      expect(llm.calls[0]?.toolChoice).not.toEqual({ type: "none" });
      expect(llm.calls[1]?.toolChoice).not.toEqual({ type: "none" });
      expect(llm.calls[2]?.toolChoice).toEqual({ type: "none" });
      await t.stop();
    });

    test("a turn well inside the budget never reaches the forced answer step", async () => {
      // p50 is one step, so the common case must pay nothing for the above.
      const llm = createFakeLanguageModel({ script: [{ type: "text", text: "Sure." }] });
      const { opts, stt, callbacks } = makeOpts({ llm, maxSteps: 3 });
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("hi");
      await vi.waitFor(() => {
        expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
      });
      expect(llm.calls.length).toBe(1);
      expect(llm.calls[0]?.toolChoice).not.toEqual({ type: "none" });
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

    test("stop() waits for an in-flight start() and tears down the mid-connect session", async () => {
      // STT open hangs, simulating a client that disconnects while providers
      // are still connecting. stop() must not resolve until the open settles,
      // and the session that lands after the abort must be closed (not leaked).
      const closeStt = vi.fn(async () => undefined);
      const open = Promise.withResolvers<SttSession>();
      const slowStt: SttOpener = { name: "slow-stt", open: () => open.promise };
      const { opts } = makeOpts({ stt: slowStt });
      const t = createPipelineTransport(opts);

      void t.start();
      let stopResolved = false;
      const stopP = t.stop().then(() => {
        stopResolved = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(stopResolved).toBe(false); // blocked on the in-flight open

      const landed: SttSession = {
        sendAudio: vi.fn(),
        on: (() => () => undefined) as SttSession["on"],
        close: closeStt,
      };
      open.resolve(landed);
      await stopP;

      expect(stopResolved).toBe(true);
      expect(closeStt).toHaveBeenCalled();
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
    test("a tool.called report fires for each tool-call stream part", async () => {
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
        expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
      });
      expect(callbacks.reported("tool.called")).toHaveBeenCalledWith({
        type: "tool.called",
        toolCallId: "tc-1",
        toolName: "get_weather",
        args: expect.any(Object),
      });
      await t.stop();
    });
  });

  describe("provider errors", () => {
    test("STT error fires onError('stt', ...) and terminates transport", async () => {
      const { opts, stt, callbacks } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireError("stt_stream_error", "stt failed");
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "stt",
        message: "stt failed",
      });
      await t.stop();
    });

    test("TTS error fires onError('tts', ...) and terminates transport", async () => {
      const { opts, tts, callbacks } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      tts.last()?.fireError("tts_stream_error", "tts failed");
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "tts",
        message: "tts failed",
      });
      await t.stop();
    });

    test("STT open failure fires onError('stt', ...) via reportOpenRejection", async () => {
      const { opts, callbacks } = makeOpts({
        stt: createFailingSttProvider("stt_connect_failed", "connect failed"),
      });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "stt",
        message: "connect failed",
      });
      await t.stop();
    });

    test("TTS open failure fires onError('tts', ...) via reportOpenRejection", async () => {
      const { opts, callbacks } = makeOpts({
        tts: createFailingTtsProvider("tts_connect_failed", "tts connect failed"),
      });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "tts",
        message: "tts connect failed",
      });
      await t.stop();
    });

    test("a session that cannot start says so instead of holding a silent line", async () => {
      // STT and TTS open independently, so the usual failure leaves a working
      // voice and nothing to listen with. Silence is indistinguishable from a
      // dead call from the caller's side.
      const tts = createFakeTtsProvider();
      const { opts, callbacks } = makeOpts(
        {
          stt: createFailingSttProvider("stt_connect_failed", "connect timed out"),
          tts,
          startFailurePhrase: "Sorry, I cannot hear you. Please call back.",
        },
        { tts },
      );
      const t = createPipelineTransport(opts);
      await t.start();

      expect(tts.last()?.textChunks.join("")).toContain("cannot hear you");
      // Spoken, and surfaced as a transcript so captions match the audio.
      expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledWith({
        type: "agent-transcript.committed",
        text: expect.stringContaining("cannot hear you"),
      });
      // Still a failed start: the client must learn the session is dead.
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "stt",
        message: "connect timed out",
      });
      expect(callbacks.onSessionReady).not.toHaveBeenCalled();
      await t.stop();
    });

    test("stays silent when TTS is the side that failed", async () => {
      // Nothing to speak with; the phrase must not wedge the teardown waiting
      // on a provider that never opened.
      const { opts, callbacks } = makeOpts({
        tts: createFailingTtsProvider("tts_connect_failed", "tts connect failed"),
      });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(callbacks.reported("agent-transcript.committed")).not.toHaveBeenCalled();
      await t.stop();
    });

    test('startFailurePhrase "" disables the spoken failure', async () => {
      const tts = createFakeTtsProvider();
      const { opts, callbacks } = makeOpts(
        {
          stt: createFailingSttProvider("stt_connect_failed", "connect timed out"),
          tts,
          startFailurePhrase: "",
        },
        { tts },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      expect(callbacks.reported("agent-transcript.committed")).not.toHaveBeenCalled();
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "stt",
        message: "connect timed out",
      });
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

  describe("turn chain resilience", () => {
    test("a crashed turn does not wedge the turn chain (next final still runs)", async () => {
      // First turn crashes inside runReply (onReplyStarted throws) AND the
      // crash logger itself throws — the worst case for the turn serializer.
      // The chain must survive both: a rejected turnPromise would mean no
      // turn ever runs again.
      const callbacks = makeCallbacks();
      (callbacks.onReplyStarted as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error("reply sink broken");
      });
      const throwingLogger = {
        info: () => undefined,
        warn: () => undefined,
        debug: () => undefined,
        error: () => {
          throw new Error("logger broken");
        },
      };
      const { opts, stt } = makeOpts({ logger: throwingLogger }, { callbacks });
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("first turn crashes");
      await vi.waitFor(() => {
        expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(1);
      });
      stt.last()?.fireFinal("second turn still runs");
      await vi.waitFor(() => {
        expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(2);
        expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
      });
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

describe("PipelineTransport — recovery when the LLM stream fails", () => {
  // A gateway 429/500 leaves the turn with no text, so nothing reaches TTS and
  // the caller hears silence — the only trace being a `llm` session error the
  // browser surfaces without a sound. The agent says so instead.
  const failingLlm = () =>
    createFakeLanguageModel({
      script: [{ type: "error", error: new Error("Internal Server Error") }],
    });

  test("speaks the error phrase", async () => {
    const { opts, stt, tts } = makeOpts({ llm: failingLlm() });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("are you there?");

    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.join("")).toContain("Sorry, I had a problem");
    });
    await t.stop();
  });

  test("flushes TTS so the phrase is actually synthesized", async () => {
    // `runReply` skips drainTts for a turn that did not speak, and the drain is
    // what flushes the provider. AssemblyAI TTS synthesizes nothing until it is
    // flushed, so without this the "recovery" would itself be silence.
    const { opts, stt, tts } = makeOpts({ llm: failingLlm() });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("are you there?");

    await vi.waitFor(() => {
      expect(tts.last()?.flush).toHaveBeenCalled();
    });
    await t.stop();
  });

  test("emits the phrase as an agent transcript so the UI matches what was heard", async () => {
    const { opts, stt, callbacks } = makeOpts({ llm: failingLlm() });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("are you there?");

    await vi.waitFor(() => {
      expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledWith({
        type: "agent-transcript.committed",
        text: expect.stringContaining("Sorry, I had a problem"),
      });
    });
    await t.stop();
  });

  test("still reports the error to the client, NON-fatally", async () => {
    // Speaking to the caller is additive: a programmatic client must still see
    // that the turn failed rather than a normal-looking reply.
    //
    // And non-fatally, because the very next thing this transport does is speak
    // `errorPhrase` — "Could you say that again?" — and invite another turn.
    // `onError` defaults to fatal, which aai-ui answers by releasing the
    // microphone and ending the call, so the caller was asked to repeat
    // themselves into a session the client had already torn down.
    const { opts, stt, callbacks } = makeOpts({ llm: failingLlm() });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("are you there?");

    await vi.waitFor(() => {
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "llm",
        message: expect.any(String),
        fatal: false,
      });
    });
    await t.stop();
  });

  test("errorPhrase: '' disables the phrase but keeps the error", async () => {
    const { opts, stt, tts, callbacks } = makeOpts({ llm: failingLlm(), errorPhrase: "" });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("are you there?");

    await vi.waitFor(() => {
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "llm",
        message: expect.any(String),
        fatal: false,
      });
    });
    expect(tts.last()?.textChunks.join("")).toBe("");
    await t.stop();
  });

  test("a custom errorPhrase is used verbatim", async () => {
    const { opts, stt, tts } = makeOpts({
      llm: failingLlm(),
      errorPhrase: "My brain just went offline.",
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("are you there?");

    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.join("")).toContain("My brain just went offline.");
    });
    await t.stop();
  });

  test("does not speak the phrase for a successful turn", async () => {
    const script: ScriptedPart[] = [{ type: "text", text: "I am here." }];
    const { opts, stt, tts } = makeOpts({ llm: createFakeLanguageModel({ script }) });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("are you there?");

    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.join("")).toContain("I am here.");
    });
    expect(tts.last()?.textChunks.join("")).not.toContain("Sorry, I had a problem");
    await t.stop();
  });
});
