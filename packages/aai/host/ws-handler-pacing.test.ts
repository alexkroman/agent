// Copyright 2026 the AAI authors. MIT license.
// ClientSink audio-pacing specs: the sink relays TTS audio at a bounded lead
// over real time rather than the instant a provider frame arrives, which makes
// its ordering against audio_done and against a barge-in load-bearing. Other
// wireSessionSocket lifecycle specs live in ws-handler-lifecycle.test.ts.

import { describe, expect, test, vi } from "vitest";
import type { ClientSink } from "../sdk/protocol.ts";
import { MockWebSocket } from "./_mock-ws.ts";
import { makeMockCore, silentLogger } from "./_test-utils.ts";
import { wireSessionSocket } from "./ws-handler.ts";

const defaultConfig = { audioFormat: "pcm16" as const, sampleRate: 16_000, ttsSampleRate: 24_000 };

function openSocket(readyState: number = MockWebSocket.OPEN): MockWebSocket {
  const ws = new MockWebSocket("ws://test");
  ws.readyState = readyState;
  return ws;
}
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
      sessions: new Map(),
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
    (ws.sent as unknown[])
      .filter((d): d is string => typeof d === "string")
      .map((s) => (JSON.parse(s) as { type: string }).type);

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

  test("audio_done waits for the audio it follows", () => {
    vi.useFakeTimers();
    try {
      const { ws, client } = pacedSink();
      for (let i = 0; i < 20; i++) client.playAudioChunk(CHUNK());
      client.playAudioDone();

      // Arriving early, audio_done would end the turn client-side and the
      // tail of the reply would never be spoken.
      expect(jsonTypes(ws)).not.toContain("audio_done");

      vi.advanceTimersByTime(2000);
      expect(jsonTypes(ws)).toContain("audio_done");
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
      client.event({ type: "cancelled" });
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

      ws.dispatchEvent(new CloseEvent("close"));
      vi.advanceTimersByTime(5000);

      expect(binaryFrames(ws)).toHaveLength(sentBeforeClose);
    } finally {
      vi.useRealTimers();
    }
  });
});
