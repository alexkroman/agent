// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared scaffolding for the five `ws-handler-*.test.ts` suites.
 *
 * Each of them had defined `openSocket` and `defaultConfig` itself — five
 * copies, and one had already drifted (`ws-handler-close-race.test.ts` lost
 * the `readyState` parameter, so that file could not open a CONNECTING
 * socket at all). Duplicated fixtures are the same failure the root guide
 * records for the vitest configs: they diverge silently, and the copy that
 * rots is the one nobody is looking at.
 *
 * `defaultConfig` additionally bound the sample rates to LITERALS — 16_000
 * and 24_000, written out in all five files. Those are `DEFAULT_STT_SAMPLE_RATE`
 * and `DEFAULT_TTS_SAMPLE_RATE`, so the fixture named "default" would have
 * kept its old values after a constant changed and gone on testing a config
 * the product no longer produces.
 */

import { DEFAULT_STT_SAMPLE_RATE, DEFAULT_TTS_SAMPLE_RATE } from "@alexkroman1/aai/host-internal";
import { vi } from "vitest";
import { MockWebSocket } from "./_mock-ws.ts";

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

/** Deliver a binary client frame (audio). */
export function simulateBinaryFrame(ws: MockWebSocket, frame: Uint8Array): void {
  ws.dispatchEvent(new MessageEvent("message", { data: frame }));
}

/** Deliver a text client frame (a JSON `SessionCommand`). */
export function simulateTextFrame(ws: MockWebSocket, text: string): void {
  ws.dispatchEvent(new MessageEvent("message", { data: text }));
}

/** Wait until the handler has logged that `session.start()` resolved. */
export async function waitForSessionReady(logger: {
  info: ReturnType<typeof vi.fn>;
}): Promise<void> {
  await vi.waitFor(() => {
    const calls = logger.info.mock.calls.map((c: unknown[]) => c[0]);
    if (!calls.includes("Session ready")) throw new Error("Session not ready yet");
  });
}
