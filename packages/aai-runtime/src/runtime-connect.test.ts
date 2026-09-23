// Copyright 2026 the AAI authors. MIT license.
/**
 * `connectSession` — a session over caller-owned audio I/O, with no socket.
 *
 * Driven through the REAL runtime and pipeline transport over the in-memory
 * provider fakes, because what `connect` promises is that a sink gets the whole
 * lifecycle a browser socket gets. A spec over a mocked session could only show
 * the wiring, not that a turn actually completes.
 */

import type { SessionEvent } from "@alexkroman1/aai";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  registerFakeProviders,
} from "./_pipeline-test-fakes.ts";
import { makeAgent, makeClientSink, silentLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";
import { connectSession } from "./runtime-connect.ts";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup() {
  const stt = createFakeSttProvider();
  const tts = createFakeTtsProvider();
  const fakes = registerFakeProviders({
    stt,
    tts,
    llm: createFakeLanguageModel({ script: [{ type: "text", text: "Hello there." }] }),
  });
  const runtime = createRuntime({
    agent: makeAgent({ greeting: "" }),
    env: fakes.env,
    stt: fakes.stt,
    tts: fakes.tts,
    llm: fakes.llm,
    logger: silentLogger,
  });
  cleanups.push(() => fakes.unregister());
  cleanups.push(() => runtime.shutdown());
  return { runtime, stt, tts };
}

function eventTypes(sink: ClientSink): string[] {
  return (sink.event as ReturnType<typeof vi.fn>).mock.calls.map(([e]) => (e as SessionEvent).type);
}

describe("connectSession", () => {
  test("announces the session on the sink before it returns", () => {
    const { runtime } = setup();
    const sink = makeClientSink();

    const connection = connectSession(runtime, sink);

    expect(connection.readyConfig).toEqual(runtime.readyConfig);
    const [configured] = (sink.event as ReturnType<typeof vi.fn>).mock.calls[0] as [SessionEvent];
    expect(configured).toMatchObject({
      type: "session.configured",
      sessionId: connection.id,
      sampleRate: runtime.readyConfig.sampleRate,
    });
    connection.close();
  });

  test("user audio sent while the session is starting reaches STT once it is ready", async () => {
    const { runtime, stt } = setup();
    const connection = connectSession(runtime, makeClientSink());

    // Sent synchronously, before `start()` has opened the STT stream — the
    // attached session buffers it rather than dropping it.
    connection.sendAudio(new Uint8Array(640));

    await vi.waitFor(() => {
      expect(stt.last()?.audioFrames.length).toBeGreaterThan(0);
    });
    connection.close();
  });

  test("a committed user turn produces a reply on the sink", async () => {
    const { runtime, stt, tts } = setup();
    const sink = makeClientSink();
    const connection = connectSession(runtime, sink);
    connection.sendCommand({ type: "audio_ready" });
    await vi.waitFor(() => expect(stt.last()).toBeDefined());

    stt.last()?.fireFinal("Hi.");

    await vi.waitFor(() => expect(eventTypes(sink)).toContain("reply.completed"), {
      timeout: 4000,
    });
    expect(tts.last()?.textChunks.join("")).toContain("Hello there.");
    connection.close();
  });

  test("close() stops the session, and `ended` settles after its cleanup", async () => {
    const { runtime, stt } = setup();
    const onSessionEnd = vi.fn();
    const sink = makeClientSink();
    const connection = connectSession(runtime, sink, { onSessionEnd });
    await vi.waitFor(() => expect(stt.last()).toBeDefined());

    connection.close();
    connection.close(); // idempotent
    await connection.ended;

    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(onSessionEnd).toHaveBeenCalledWith(connection.id, sink);
    expect(stt.last()?.closed.value).toBe(true);
  });

  test("input after close is dropped rather than reaching a stopped session", async () => {
    const { runtime, stt } = setup();
    const connection = connectSession(runtime, makeClientSink());
    await vi.waitFor(() => expect(stt.last()).toBeDefined());
    connection.close();
    await connection.ended;
    const frames = stt.last()?.audioFrames.length ?? 0;

    connection.sendAudio(new Uint8Array(640));

    expect(stt.last()?.audioFrames.length ?? 0).toBe(frames);
  });

  test("a resume by id evicts the previous connection and ends it", async () => {
    const { runtime, stt } = setup();
    const first = makeClientSink({ close: vi.fn() });
    const one = connectSession(runtime, first);
    await vi.waitFor(() => expect(stt.last()).toBeDefined());

    const two = connectSession(runtime, makeClientSink(), { resumeFrom: one.id });

    expect(two.id).toBe(one.id);
    expect(first.close).toHaveBeenCalledWith("session resumed by another connection");
    // The runtime closed the sink, so it detached the connection itself —
    // nobody else was going to.
    await one.ended;
    two.close();
    await two.ended;
  });

  test("runtime.shutdown() ends a connected session and settles `ended`", async () => {
    const { runtime, stt } = setup();
    const onSessionEnd = vi.fn();
    const sink = makeClientSink();
    const connection = connectSession(runtime, sink, { onSessionEnd });
    await vi.waitFor(() => expect(stt.last()).toBeDefined());

    await runtime.shutdown();
    await connection.ended;

    expect(onSessionEnd).toHaveBeenCalledWith(connection.id, sink);
    expect(stt.last()?.closed.value).toBe(true);
  });

  test("an invalid command is dropped, not thrown", () => {
    const { runtime } = setup();
    const connection = connectSession(runtime, makeClientSink());
    expect(() =>
      connection.sendCommand({ type: "playback_progress", bufferedMs: -1 }),
    ).not.toThrow();
    connection.close();
  });
});
