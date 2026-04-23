// Copyright 2025 the AAI authors. MIT license.
/** Tests for the pipeline-session orchestrator (see pipeline-session.ts). */

import { describe, expect, test, vi } from "vitest";
import type { AgentConfig } from "../sdk/_internal-types.ts";
import type { ClientEvent } from "../sdk/protocol.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../sdk/types.ts";
import {
  createFailingSttProvider,
  createFailingTtsProvider,
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  type ScriptedPart,
} from "./_pipeline-test-fakes.ts";
import { makeClient, silentLogger } from "./_test-utils.ts";
import { createPipelineSession, type PipelineSessionOptions } from "./pipeline-session.ts";

const CONFIG: AgentConfig = {
  name: "pipeline-agent",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  greeting: "",
};

function makeOpts(overrides: Partial<PipelineSessionOptions> = {}): {
  opts: PipelineSessionOptions;
  stt: ReturnType<typeof createFakeSttProvider>;
  tts: ReturnType<typeof createFakeTtsProvider>;
  client: ReturnType<typeof makeClient>;
} {
  const stt = createFakeSttProvider();
  const tts = createFakeTtsProvider();
  const client = makeClient();
  const opts: PipelineSessionOptions = {
    id: "sess-1",
    agent: "pipeline-agent",
    client,
    agentConfig: CONFIG,
    toolSchemas: [],
    executeTool: vi.fn(async () => "ok"),
    stt,
    llm: createFakeLanguageModel({ script: [] }),
    tts,
    sttApiKey: "stt-key",
    ttsApiKey: "tts-key",
    sttSampleRate: 16_000,
    ttsSampleRate: 24_000,
    logger: silentLogger,
    ...overrides,
  };
  return { opts, stt, tts, client };
}

function eventTypes(events: readonly unknown[]): string[] {
  return events.map((e) => (e as ClientEvent).type);
}

describe("createPipelineSession — happy path", () => {
  test("STT final → LLM stream → TTS sendText/flush → reply_done", async () => {
    const script: ScriptedPart[] = [
      { type: "text", text: "Hello" },
      { type: "text", text: " there" },
    ];
    const { opts, stt, tts, client } = makeOpts({
      llm: createFakeLanguageModel({ script }),
    });

    const session = createPipelineSession(opts);
    await session.start();

    const sttSession = stt.last();
    expect(sttSession).toBeDefined();
    const ttsSession = tts.last();
    expect(ttsSession).toBeDefined();
    if (!(sttSession && ttsSession)) return;

    sttSession.firePartial("Hello");
    sttSession.fireFinal("Hello there, how are you?");
    await session.waitForTurn();

    // Verify TTS received each text-delta, then a flush
    expect(ttsSession.textChunks).toEqual(["Hello", " there"]);
    expect(ttsSession.flush).toHaveBeenCalledTimes(1);

    // Verify wire events in order — the pipeline emits a single
    // `agent_transcript` with the full accumulated reply (not one per
    // delta) so the UI renders one assistant message per turn.
    const types = eventTypes(client.events);
    expect(types).toEqual(["user_transcript", "agent_transcript", "reply_done"]);

    // user_transcript text matches
    expect(client.events[0]).toMatchObject({
      type: "user_transcript",
      text: "Hello there, how are you?",
    });
    expect(client.events[1]).toMatchObject({
      type: "agent_transcript",
      text: "Hello there",
    });

    await session.stop();
  });
});

describe("createPipelineSession — greeting", () => {
  test("onAudioReady sends greeting to TTS and emits agent_transcript + reply_done", async () => {
    const { opts, tts, client } = makeOpts({
      agentConfig: {
        name: "pipeline-agent",
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        greeting: "Hi! I'm pipeline mode.",
      },
    });

    const session = createPipelineSession(opts);
    await session.start();

    const ttsSession = tts.last();
    if (!ttsSession) throw new Error("TTS didn't open");

    session.onAudioReady();
    await session.waitForTurn();

    expect(ttsSession.textChunks).toEqual(["Hi! I'm pipeline mode."]);
    expect(ttsSession.flush).toHaveBeenCalledTimes(1);

    const types = eventTypes(client.events);
    expect(types).toEqual(["agent_transcript", "reply_done"]);
    expect(client.events[0]).toMatchObject({
      type: "agent_transcript",
      text: "Hi! I'm pipeline mode.",
    });

    await session.stop();
  });

  test("skipGreeting=true suppresses the greeting turn", async () => {
    const { opts, tts, client } = makeOpts({
      agentConfig: {
        name: "pipeline-agent",
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        greeting: "Hello there.",
      },
      skipGreeting: true,
    });

    const session = createPipelineSession(opts);
    await session.start();

    const ttsSession = tts.last();
    if (!ttsSession) throw new Error("TTS didn't open");

    session.onAudioReady();
    await session.waitForTurn();

    expect(ttsSession.sendText).not.toHaveBeenCalled();
    expect(ttsSession.flush).not.toHaveBeenCalled();
    expect(client.events).toEqual([]);

    await session.stop();
  });

  test("empty greeting is a no-op", async () => {
    const { opts, tts, client } = makeOpts();
    // CONFIG already has greeting: ""
    const session = createPipelineSession(opts);
    await session.start();

    const ttsSession = tts.last();
    if (!ttsSession) throw new Error("TTS didn't open");

    session.onAudioReady();
    await session.waitForTurn();

    expect(ttsSession.sendText).not.toHaveBeenCalled();
    expect(client.events).toEqual([]);

    await session.stop();
  });

  test("passes sttSampleRate / ttsSampleRate through to providers", async () => {
    const { opts, stt, tts } = makeOpts({
      sttSampleRate: 16_000,
      ttsSampleRate: 24_000,
    });
    const session = createPipelineSession(opts);
    await session.start();

    expect(stt.last()?.opts.sampleRate).toBe(16_000);
    expect(tts.last()?.opts.sampleRate).toBe(24_000);

    await session.stop();
  });
});

describe("createPipelineSession — empty utterance", () => {
  test("whitespace-only final skips reply (no TTS, no LLM, no wire events)", async () => {
    const llm = createFakeLanguageModel({ script: [{ type: "text", text: "unexpected" }] });
    const doStreamSpy = vi.spyOn(
      llm as unknown as { doStream: (...a: unknown[]) => unknown },
      "doStream",
    );

    const { opts, stt, tts, client } = makeOpts({ llm });
    const session = createPipelineSession(opts);
    await session.start();

    const sttSession = stt.last();
    const ttsSession = tts.last();
    if (!(sttSession && ttsSession)) throw new Error("providers didn't open");

    sttSession.firePartial("   ");
    sttSession.fireFinal("   ");
    await session.waitForTurn();

    expect(doStreamSpy).not.toHaveBeenCalled();
    expect(ttsSession.sendText).not.toHaveBeenCalled();
    expect(ttsSession.flush).not.toHaveBeenCalled();
    expect(client.events).toEqual([]);

    await session.stop();
  });
});

describe("createPipelineSession — barge-in", () => {
  test("stt.partial during AGENT_REPLYING aborts LLM, cancels TTS, emits cancelled", async () => {
    // Script with delayMs so we can fire a partial between parts.
    const script: ScriptedPart[] = [
      { type: "text", text: "Hello " },
      { type: "text", text: "how can " },
      { type: "text", text: "I help?" },
    ];
    const { opts, stt, tts, client } = makeOpts({
      llm: createFakeLanguageModel({ script, delayMs: 20 }),
    });

    const session = createPipelineSession(opts);
    await session.start();

    const sttSession = stt.last();
    const ttsSession = tts.last();
    if (!(sttSession && ttsSession)) throw new Error("providers didn't open");

    // Kick off a reply.
    sttSession.firePartial("hi");
    sttSession.fireFinal("hi there");
    // Wait until at least one text delta has been forwarded to TTS so we're
    // firmly in AGENT_REPLYING before the barge-in partial.
    await vi.waitFor(() => {
      expect(ttsSession.sendText.mock.calls.length).toBeGreaterThan(0);
    });

    // Barge-in: user starts speaking again.
    sttSession.firePartial("wait");
    await session.waitForTurn();

    // TTS.cancel must have been called exactly once.
    expect(ttsSession.cancel).toHaveBeenCalledTimes(1);
    // Wire events: user_transcript then cancelled. No agent_transcript
    // (the pipeline only emits it after the LLM stream finishes cleanly)
    // and no reply_done — barge-in short-circuits both the stream and
    // the drain.
    const types = eventTypes(client.events);
    expect(types).toContain("user_transcript");
    expect(types).toContain("cancelled");
    expect(types).not.toContain("reply_done");
    expect(types.indexOf("cancelled")).toBeGreaterThan(types.indexOf("user_transcript"));

    // After the barge-in lands, the state machine is back to USER_SPEAKING.
    // A new final should start a fresh turn.
    await session.stop();
  });
});

describe("createPipelineSession — tool calls", () => {
  test("tool-call and tool-result parts emit wire events; reply_done still fires", async () => {
    const script: ScriptedPart[] = [
      { type: "text", text: "Let me check" },
      {
        type: "tool-call",
        toolCallId: "tc-1",
        toolName: "get_weather",
        input: JSON.stringify({ city: "SF" }),
      },
      {
        type: "tool-result",
        toolCallId: "tc-1",
        toolName: "get_weather",
        result: "sunny, 72F",
      },
      { type: "text", text: " — it's sunny." },
    ];
    const { opts, stt, tts, client } = makeOpts({
      llm: createFakeLanguageModel({ script }),
    });

    const session = createPipelineSession(opts);
    await session.start();

    const sttSession = stt.last();
    const ttsSession = tts.last();
    if (!(sttSession && ttsSession)) throw new Error("providers didn't open");

    sttSession.fireFinal("how's the weather?");
    await session.waitForTurn();

    const types = eventTypes(client.events);
    expect(types).toEqual([
      "user_transcript",
      "tool_call",
      "tool_call_done",
      "agent_transcript", // combined: "Let me check — it's sunny."
      "reply_done",
    ]);
    expect(client.events.find((e) => (e as ClientEvent).type === "agent_transcript")).toMatchObject(
      {
        type: "agent_transcript",
        text: "Let me check — it's sunny.",
      },
    );

    const toolCall = client.events.find((e) => (e as ClientEvent).type === "tool_call");
    expect(toolCall).toMatchObject({
      type: "tool_call",
      toolCallId: "tc-1",
      toolName: "get_weather",
    });
    const toolDone = client.events.find((e) => (e as ClientEvent).type === "tool_call_done");
    expect(toolDone).toMatchObject({
      type: "tool_call_done",
      toolCallId: "tc-1",
      result: "sunny, 72F",
    });

    await session.stop();
  });
});

describe("createPipelineSession — multi-step tool loop", () => {
  test("streamText loops across multiple tool calls when maxSteps > 1", async () => {
    // 4 steps: three tool calls (each in its own model step), then a final
    // text completion. Without `stopWhen: stepCountIs(n)` the AI SDK v6
    // default is a single step, so tool loops would terminate after the
    // first tool-result and `executeTool` would only fire once.
    const steps: ScriptedPart[][] = [
      [
        {
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "get_weather",
          input: JSON.stringify({ city: "SF" }),
        },
      ],
      [
        {
          type: "tool-call",
          toolCallId: "tc-2",
          toolName: "get_weather",
          input: JSON.stringify({ city: "LA" }),
        },
      ],
      [
        {
          type: "tool-call",
          toolCallId: "tc-3",
          toolName: "get_weather",
          input: JSON.stringify({ city: "NY" }),
        },
      ],
      [{ type: "text", text: "Weather for all three cities retrieved." }],
    ];
    const executeTool = vi.fn(
      async (name: string, args: Readonly<Record<string, unknown>>) =>
        `result-${name}-${(args as { city?: string }).city ?? "?"}`,
    );
    const { opts, stt, tts, client } = makeOpts({
      llm: createFakeLanguageModel({ steps }),
      executeTool,
      toolSchemas: [
        {
          name: "get_weather",
          description: "Look up the weather for a city.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      agentConfig: { ...CONFIG, maxSteps: 5 },
    });

    const session = createPipelineSession(opts);
    await session.start();

    const sttSession = stt.last();
    const ttsSession = tts.last();
    if (!(sttSession && ttsSession)) throw new Error("providers didn't open");

    sttSession.fireFinal("weather everywhere?");
    await session.waitForTurn();

    // All three tool calls ran.
    expect(executeTool).toHaveBeenCalledTimes(3);
    const toolCallEvents = client.events.filter((e) => (e as ClientEvent).type === "tool_call");
    expect(toolCallEvents).toHaveLength(3);

    // And the reply finished with a final text + reply_done, proving the
    // loop actually terminated naturally rather than being cut short.
    const types = eventTypes(client.events);
    expect(types).toContain("reply_done");
    expect(ttsSession.textChunks).toEqual(["Weather for all three cities retrieved."]);

    await session.stop();
  });
});

describe("createPipelineSession — STT error", () => {
  test("stt error emits single error wire event with code stt", async () => {
    const { opts, stt, client } = makeOpts();
    const session = createPipelineSession(opts);
    await session.start();

    const sttSession = stt.last();
    if (!sttSession) throw new Error("STT didn't open");

    sttSession.fireError("stt_stream_error", "oops");

    const errors = client.events.filter((e) => (e as ClientEvent).type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "error",
      code: "stt",
      message: "oops",
    });

    await session.stop();
  });
});

describe("createPipelineSession — duplicate final", () => {
  test("second final during AGENT_REPLYING aborts prior turn and starts new one", async () => {
    // Multi-part first step with delay so the first turn is still streaming
    // when the second final arrives.
    const steps: ScriptedPart[][] = [
      [
        { type: "text", text: "first " },
        { type: "text", text: "reply " },
        { type: "text", text: "continues" },
      ],
      [{ type: "text", text: "second reply" }],
    ];
    const { opts, stt, tts, client } = makeOpts({
      llm: createFakeLanguageModel({ steps, delayMs: 20 }),
    });

    const session = createPipelineSession(opts);
    await session.start();

    const sttSession = stt.last();
    const ttsSession = tts.last();
    if (!(sttSession && ttsSession)) throw new Error("providers didn't open");

    sttSession.fireFinal("first question");
    await vi.waitFor(() => {
      expect(ttsSession.sendText.mock.calls.length).toBeGreaterThan(0);
    });

    // Second final arrives mid-reply.
    sttSession.fireFinal("second question");
    await session.waitForTurn();

    // TTS.cancel fires once to abandon the first turn's audio.
    expect(ttsSession.cancel).toHaveBeenCalledTimes(1);

    // Both user transcripts reach the client.
    const userTranscripts = client.events.filter(
      (e) => (e as ClientEvent).type === "user_transcript",
    );
    expect(userTranscripts).toHaveLength(2);

    // Second reply's text was synthesized.
    expect(ttsSession.textChunks).toContain("second reply");

    // Exactly one reply_done (for the second turn).
    const replyDones = client.events.filter((e) => (e as ClientEvent).type === "reply_done");
    expect(replyDones).toHaveLength(1);

    await session.stop();
  });
});

describe("createPipelineSession — flush timeout/abort", () => {
  test("flush that never drains does not wedge stop()", async () => {
    // autoDoneOnFlush: false → TTS never fires `done`, so flushTtsAndWait must
    // resolve via the turn-abort signal when stop() fires.
    const script: ScriptedPart[] = [{ type: "text", text: "hi" }];
    const tts = createFakeTtsProvider({ autoDoneOnFlush: false });
    const { opts, stt, client } = makeOpts({
      llm: createFakeLanguageModel({ script }),
      tts,
    });

    const session = createPipelineSession(opts);
    await session.start();

    const sttSession = stt.last();
    const ttsSession = tts.last();
    if (!(sttSession && ttsSession)) throw new Error("providers didn't open");

    sttSession.fireFinal("hi");
    // Wait until the turn has reached the flush step — without this guard,
    // stop() aborts the controller before flushTtsAndWait is even called.
    await vi.waitFor(() => {
      expect(ttsSession.flush).toHaveBeenCalledTimes(1);
    });
    await session.stop();

    // Turn aborted before reply_done could fire.
    const types = eventTypes(client.events);
    expect(types).not.toContain("reply_done");
  });
});

describe("createPipelineSession — mid-session provider errors", () => {
  test("STT error during reply aborts turn and stops further transcripts", async () => {
    const script: ScriptedPart[] = [{ type: "text", text: "reply" }];
    const { opts, stt, tts, client } = makeOpts({
      llm: createFakeLanguageModel({ script, delayMs: 20 }),
    });

    const session = createPipelineSession(opts);
    await session.start();

    const sttSession = stt.last();
    const ttsSession = tts.last();
    if (!(sttSession && ttsSession)) throw new Error("providers didn't open");

    sttSession.fireFinal("first");
    await vi.waitFor(() => {
      expect(ttsSession.sendText.mock.calls.length).toBeGreaterThan(0);
    });
    sttSession.fireError("stt_stream_error", "socket died");
    await session.waitForTurn();

    const errors = client.events.filter((e) => (e as ClientEvent).type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "stt", message: "socket died" });

    // Turn was aborted (TTS cancelled).
    expect(ttsSession.cancel).toHaveBeenCalled();

    // Further STT events are no-ops.
    sttSession.fireFinal("ignored after error");
    await session.waitForTurn();
    const userTranscripts = client.events.filter(
      (e) => (e as ClientEvent).type === "user_transcript",
    );
    expect(userTranscripts).toHaveLength(1);

    await session.stop();
  });

  test("TTS error during reply aborts turn and stops further user transcripts", async () => {
    const script: ScriptedPart[] = [{ type: "text", text: "reply" }];
    const { opts, stt, tts, client } = makeOpts({
      llm: createFakeLanguageModel({ script, delayMs: 20 }),
    });

    const session = createPipelineSession(opts);
    await session.start();

    const sttSession = stt.last();
    const ttsSession = tts.last();
    if (!(sttSession && ttsSession)) throw new Error("providers didn't open");

    sttSession.fireFinal("first");
    await vi.waitFor(() => {
      expect(ttsSession.sendText.mock.calls.length).toBeGreaterThan(0);
    });
    ttsSession.fireError("tts_stream_error", "socket died");
    await session.waitForTurn();

    const errors = client.events.filter((e) => (e as ClientEvent).type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "tts", message: "socket died" });

    sttSession.fireFinal("should be ignored");
    await session.waitForTurn();
    const userTranscripts = client.events.filter(
      (e) => (e as ClientEvent).type === "user_transcript",
    );
    expect(userTranscripts).toHaveLength(1);

    await session.stop();
  });

  test("cancel/reset/history are no-ops after terminate", async () => {
    const { opts, stt, client } = makeOpts();
    const session = createPipelineSession(opts);
    await session.start();

    const sttSession = stt.last();
    if (!sttSession) throw new Error("STT didn't open");

    sttSession.fireError("stt_stream_error", "dead");
    await session.waitForTurn();

    const eventsBefore = client.events.length;

    session.onCancel();
    session.onReset();
    session.onHistory([{ role: "user", content: "nope" }]);

    expect(client.events).toHaveLength(eventsBefore);

    await session.stop();
  });
});

describe("createPipelineSession — atomic provider open", () => {
  test("STT is closed when TTS open fails, session becomes terminated", async () => {
    const stt = createFakeSttProvider();
    const failingTts = createFailingTtsProvider("tts_connect_failed", "bad key");

    const { opts, client } = makeOpts({ stt, tts: failingTts });
    const session = createPipelineSession(opts);
    await session.start();

    const sttSession = stt.last();
    expect(sttSession).toBeDefined();
    expect(sttSession?.closed.value).toBe(true);

    const errors = client.events.filter((e) => (e as ClientEvent).type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "tts", message: "bad key" });

    // Session terminated — further STT events are no-ops (even though
    // listeners were never wired, terminate() also ensures onCancel etc. work).
    sttSession?.fireFinal("ignored");
    await session.waitForTurn();
    const userTranscripts = client.events.filter(
      (e) => (e as ClientEvent).type === "user_transcript",
    );
    expect(userTranscripts).toHaveLength(0);

    await session.stop();
  });

  test("TTS is never opened when STT open fails", async () => {
    const failingStt = createFailingSttProvider("stt_connect_failed", "bad key");
    const tts = createFakeTtsProvider();
    const ttsOpenSpy = vi.spyOn(tts, "open");

    const { opts, client } = makeOpts({ stt: failingStt, tts });
    const session = createPipelineSession(opts);
    await session.start();

    // STT and TTS open concurrently via Promise.allSettled — TTS.open is
    // still called, but once STT fails its result is discarded and the TTS
    // session is closed.
    expect(ttsOpenSpy).toHaveBeenCalledTimes(1);
    const ttsSession = tts.last();
    expect(ttsSession?.closed.value).toBe(true);

    const errors = client.events.filter((e) => (e as ClientEvent).type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "stt", message: "bad key" });

    await session.stop();
  });
});
