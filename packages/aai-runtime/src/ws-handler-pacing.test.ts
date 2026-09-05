// Copyright 2026 the AAI authors. MIT license.
// ClientSink audio-pacing specs: the sink relays TTS audio at a bounded lead
// over real time rather than the instant a provider frame arrives, which makes
// its ordering against audio_done and against a barge-in load-bearing. Other
// wireSessionSocket lifecycle specs live in ws-handler-lifecycle.test.ts.

import { createOwnedMap } from "@alexkroman1/aai/internal";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import { describe, expect, test, vi } from "vitest";
import type { MockWebSocket } from "./_mock-ws.ts";
import { makeMockCore, silentLogger } from "./_test-utils.ts";
import { defaultConfig, openSocket } from "./_ws-handler-test-utils.ts";
import { stampSessionEvent } from "./session-event-stream.ts";
import { wireSessionSocket } from "./ws-handler.ts";

/**
 * Pacing specs. The sink relays TTS audio at a bounded lead over real time
 * rather than the instant a provider frame arrives, which also makes ordering
 * relative to `audio_done` and to a barge-in load-bearing.
 */
describe("wireSessionSocket audio pacing", () => {
  /** 24 kHz PCM16 is 48 bytes/ms, so this is 100ms of audio. */
  const CHUNK = () => new Uint8Array(4800);

  function pacedSink(): { ws: MockWebSocket; client: ClientSink } {
    const ws = openSocket();
    let client!: ClientSink;
    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: (_sid, sink) => {
        client = sink;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });
    return { ws, client };
  }

  const binaryFrames = (ws: MockWebSocket): unknown[] =>
    (ws.sent as unknown[]).filter((d) => d instanceof Uint8Array);

  const jsonTypes = (ws: MockWebSocket): string[] =>
    ws.sentJson().map((frame) => frame.type as string);

  test("holds a reply that outruns real time instead of filling the socket buffer", () => {
    vi.useFakeTimers();
    try {
      const { ws, client } = pacedSink();
      // 2s of audio, produced as fast as a TTS provider can emit it.
      for (let i = 0; i < 20; i++) client.playAudioChunk(CHUNK());

      const sent = binaryFrames(ws).length;
      expect(sent).toBeLessThan(20);
      expect(sent).toBeGreaterThan(0);

      vi.advanceTimersByTime(2000);
      expect(binaryFrames(ws)).toHaveLength(20);
    } finally {
      vi.useRealTimers();
    }
  });

  test("audio.completed waits for the audio it follows", () => {
    vi.useFakeTimers();
    try {
      const { ws, client } = pacedSink();
      for (let i = 0; i < 20; i++) client.playAudioChunk(CHUNK());
      client.event(stampSessionEvent({ type: "audio.completed" }));

      // Arriving early, audio.completed would end the turn client-side and the
      // tail of the reply would never be spoken.
      expect(jsonTypes(ws)).not.toContain("audio.completed");

      vi.advanceTimersByTime(2000);
      expect(jsonTypes(ws)).toContain("audio.completed");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a cancelled event discards audio held for the killed turn", () => {
    vi.useFakeTimers();
    try {
      const { ws, client } = pacedSink();
      for (let i = 0; i < 20; i++) client.playAudioChunk(CHUNK());
      const sentBeforeCancel = binaryFrames(ws).length;

      // The client flushes its own buffer on this event, so held audio must
      // not follow it down the socket.
      client.event(stampSessionEvent({ type: "reply.cancelled" }));
      vi.advanceTimersByTime(5000);

      expect(binaryFrames(ws)).toHaveLength(sentBeforeCancel);
    } finally {
      vi.useRealTimers();
    }
  });

  test("closing the socket stops paced sends", () => {
    vi.useFakeTimers();
    try {
      const { ws, client } = pacedSink();
      for (let i = 0; i < 20; i++) client.playAudioChunk(CHUNK());
      const sentBeforeClose = binaryFrames(ws).length;

      // CloseEvent is only a global from Node 23; the handler under test
      // reads nothing off the event beyond its type.
      ws.dispatchEvent(new (globalThis.CloseEvent ?? Event)("close"));
      vi.advanceTimersByTime(5000);

      expect(binaryFrames(ws)).toHaveLength(sentBeforeClose);
    } finally {
      vi.useRealTimers();
    }
  });
});
