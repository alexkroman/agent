// Copyright 2025 the AAI authors. MIT license.
/** Tests for the pipeline-session orchestrator (see pipeline-session.ts). */

import { describe, expect, test, vi } from "vitest";
import type { AgentConfig } from "../sdk/_internal-types.ts";
import type { ClientEvent } from "../sdk/protocol.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../sdk/types.ts";
import {
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
    sampleRate: 16_000,
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

    // Verify wire events in order
    const types = eventTypes(client.events);
    expect(types).toEqual([
      "user_transcript",
      "agent_transcript", // "Hello"
      "agent_transcript", // " there"
      "reply_done",
    ]);

    // user_transcript text matches
    expect(client.events[0]).toMatchObject({
      type: "user_transcript",
      text: "Hello there, how are you?",
    });

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
    // Wire events: user_transcript, some agent_transcript(s), then cancelled.
    // No reply_done — barge-in short-circuits the drain.
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
      "agent_transcript", // "Let me check"
      "tool_call",
      "tool_call_done",
      "agent_transcript", // " — it's sunny."
      "reply_done",
    ]);

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
