// Copyright 2026 the AAI authors. MIT license.
/**
 * The pacing wrapper on its own, over a plain sink — the rules
 * `ws-handler-pacing.test.ts` pins through a socket, stated against the
 * transport-neutral half so a non-socket sink is held to them too.
 */

import type { ClientSink, SessionEvent } from "@alexkroman1/aai/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { UNPACED_AUDIO_LEAD_MS } from "./audio-pacer.ts";
import { createPacedClientSink } from "./paced-client-sink.ts";
import { stampSessionEvent } from "./session-event-stream.ts";

/** 24 kHz PCM16 is 48 bytes/ms, so this is 100ms of audio. */
const CHUNK = () => new Uint8Array(4800);

type Recorded = { kind: "audio" } | { kind: "event"; type: string };

function recordingSink(): { sink: ClientSink; log: Recorded[]; close: ReturnType<typeof vi.fn> } {
  const log: Recorded[] = [];
  const close = vi.fn();
  return {
    log,
    close,
    sink: {
      open: true,
      event: (e: SessionEvent) => log.push({ kind: "event", type: e.type }),
      playAudioChunk: () => log.push({ kind: "audio" }),
      close,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createPacedClientSink", () => {
  test("meters audio to real time rather than relaying it all at once", () => {
    const { sink, log } = recordingSink();
    const { client } = createPacedClientSink(sink, { sampleRate: 24_000 });

    for (let i = 0; i < 30; i++) client.playAudioChunk(CHUNK());
    expect(log.length).toBeLessThan(30);

    vi.advanceTimersByTime(3000);
    expect(log).toHaveLength(30);
  });

  test("audio.completed and reply.completed wait behind held audio", () => {
    const { sink, log } = recordingSink();
    const { client } = createPacedClientSink(sink, { sampleRate: 24_000 });

    for (let i = 0; i < 30; i++) client.playAudioChunk(CHUNK());
    client.event(stampSessionEvent({ type: "audio.completed" }));
    client.event(stampSessionEvent({ type: "reply.completed" }));
    vi.advanceTimersByTime(3000);

    const kinds = log.map((r) => (r.kind === "audio" ? "audio" : r.type));
    expect(kinds.slice(-2)).toEqual(["audio.completed", "reply.completed"]);
    expect(kinds.filter((k) => k === "audio")).toHaveLength(30);
  });

  test("reply.cancelled discards held audio and goes out immediately", () => {
    const { sink, log } = recordingSink();
    const { client } = createPacedClientSink(sink, { sampleRate: 24_000 });

    for (let i = 0; i < 30; i++) client.playAudioChunk(CHUNK());
    const sentBefore = log.length;
    client.event(stampSessionEvent({ type: "reply.cancelled" }));
    vi.advanceTimersByTime(3000);

    expect(log.at(sentBefore)).toEqual({ kind: "event", type: "reply.cancelled" });
    expect(log).toHaveLength(sentBefore + 1);
  });

  test("an unpaced sink relays every frame at once but keeps the ordering", () => {
    const { sink, log } = recordingSink();
    const { client } = createPacedClientSink(sink, {
      sampleRate: 24_000,
      leadMs: UNPACED_AUDIO_LEAD_MS,
    });

    for (let i = 0; i < 30; i++) client.playAudioChunk(CHUNK());
    client.event(stampSessionEvent({ type: "audio.completed" }));

    expect(log).toHaveLength(31);
    expect(log.at(-1)).toEqual({ kind: "event", type: "audio.completed" });
  });

  test("stopPacing drops held audio; close passes through", () => {
    const { sink, log, close } = recordingSink();
    const { client, stopPacing } = createPacedClientSink(sink, { sampleRate: 24_000 });

    for (let i = 0; i < 30; i++) client.playAudioChunk(CHUNK());
    const sent = log.length;
    stopPacing();
    vi.advanceTimersByTime(3000);
    client.close?.("bye");

    expect(log).toHaveLength(sent);
    expect(close).toHaveBeenCalledWith("bye");
  });
});
