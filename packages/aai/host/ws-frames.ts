// Copyright 2026 the AAI authors. MIT license.
// The socket primitives shared by the session-socket wiring (`ws-handler.ts`)
// and the client sink (`ws-client-sink.ts`): the minimal WebSocket shape the
// runtime accepts, the `audio_done` frame, and a send that tolerates the close
// race. Split out so those two modules need not import from each other.

import { WS_OPEN } from "../sdk/constants.ts";
import { errorMessage } from "../sdk/utils.ts";
import type { Logger } from "./runtime-config.ts";

/**
 * Minimal WebSocket interface accepted by {@link wireSessionSocket}.
 *
 * Satisfied by the standard `WebSocket` and the `ws` npm package's WebSocket.
 */
export type SessionWebSocket = {
  readonly readyState: number;
  /**
   * Bytes queued by `send()` but not yet transmitted (standard WebSocket /
   * `ws` property). Optional so minimal test doubles remain assignable; when
   * absent, the audio backpressure guard is skipped.
   */
  readonly bufferedAmount?: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  /** Close the connection (standard WebSocket / `ws` method). */
  close?(code?: number, reason?: string): void;
  /**
   * Send a WebSocket ping frame (`ws`-only; the browser API has no equivalent).
   * Optional so test doubles and any non-`ws` socket stay assignable — when
   * absent the keepalive is skipped rather than emulated with a protocol
   * message, which would reach the client as unexpected session traffic.
   */
  ping?(): void;
  addEventListener(type: "open", listener: () => void): void;
  /**
   * Split from `"open"` so the close listener can read the frame's `code` and
   * `reason` — the only evidence of *why* a session ended. Both are optional:
   * an abrupt drop arrives with no close frame at all, and minimal test
   * doubles that invoke the listener with no argument stay assignable.
   */
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
};

export const AUDIO_DONE_FRAME = JSON.stringify({
  type: "audio_done",
} satisfies { type: "audio_done" });

/** Send on a session socket, tolerating the close race between the readyState check and send. */
export function safeSend(ws: SessionWebSocket, data: string | Uint8Array, log: Logger): void {
  try {
    if (ws.readyState !== WS_OPEN) return;
    ws.send(data);
  } catch (err) {
    log.debug?.("safeSend: socket closed between readyState check and send", {
      error: errorMessage(err),
    });
  }
}
