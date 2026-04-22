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
