// Copyright 2026 the AAI authors. MIT license.
/**
 * The session-core harness every `core*.test.ts` builds on: a recording sink,
 * a spy transport, and a REAL core over a real emitter and stream — so what a
 * spec reads off the sink is what the session actually emitted and recorded.
 */

import { DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { makeAgentConfig, makeCore, makeSink } from "./_core-harness.ts";

describe("makeSink", () => {
  test("records events, audio and close reasons in order", () => {
    const { sink, events, audioChunks, closeReasons } = makeSink();
    const chunk = new Uint8Array([1]);
    sink.event({ type: "speech.started", meta: { id: "e1", at: 0 } });
    sink.playAudioChunk(chunk);
    sink.close?.("bye");
    expect(events.map((e) => e.type)).toEqual(["speech.started"]);
    expect(audioChunks).toEqual([chunk]);
    expect(closeReasons).toEqual(["bye"]);
  });
});

describe("makeAgentConfig", () => {
  test("defaults to the shipped system prompt, with overrides merged over it", () => {
    expect(makeAgentConfig()).toEqual({
      name: "test",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      greeting: "",
    });
    expect(makeAgentConfig({ name: "t", idleTimeoutMs: 5 })).toMatchObject({
      name: "t",
      idleTimeoutMs: 5,
    });
  });
});

describe("makeCore", () => {
  test("drives the spy transport and records what reaches the sink AND the stream", async () => {
    const { core, sink, transport, stream } = makeCore();
    await core.start();
    expect(transport.start).toHaveBeenCalledTimes(1);
    core.report({ type: "userTranscript.committed", text: "hello" });
    expect(sink.events.map((e) => e.type)).toContain("userTranscript.committed");
    const page = await stream.read("s-test", 0);
    expect(page.events.map((e) => e.type)).toContain("userTranscript.committed");
    await core.stop();
    expect(transport.stop).toHaveBeenCalledTimes(1);
  });

  test("an overriding client is the one that sees the session's events", async () => {
    const own = makeSink();
    const { core, sink } = makeCore({ client: own.sink });
    await core.start();
    core.report({ type: "speech.started" });
    expect(own.events.map((e) => e.type)).toContain("speech.started");
    expect(sink.events).toEqual([]);
  });
});
