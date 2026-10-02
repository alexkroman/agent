// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared scaffolding for the `ws-handler-*.test.ts` suites, held once so the
 * copies cannot diverge.
 */

import { DEFAULT_STT_SAMPLE_RATE, DEFAULT_TTS_SAMPLE_RATE } from "@alexkroman1/aai/host-internal";
import { MockWebSocket } from "../_mock-ws.ts";

/**
 * The `readyConfig` a session is wired with. Rates come from the constants
 * rather than literals so "default" keeps meaning the product's default.
 */
export const defaultConfig = {
  audioFormat: "pcm16" as const,
  sampleRate: DEFAULT_STT_SAMPLE_RATE,
  ttsSampleRate: DEFAULT_TTS_SAMPLE_RATE,
};

/** A mock socket in `readyState` (OPEN unless a spec wants the pre-open case). */
export function openSocket(readyState: number = MockWebSocket.OPEN): MockWebSocket {
  const ws = new MockWebSocket("ws://test");
  ws.readyState = readyState;
  return ws;
}

/** Deliver a client frame: binary is audio, text a JSON `SessionCommand`. */
export function simulateFrame(ws: MockWebSocket, data: string | Uint8Array): void {
  ws.dispatchEvent(new MessageEvent("message", { data }));
}
