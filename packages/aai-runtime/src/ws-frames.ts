// Copyright 2026 the AAI authors. MIT license.
// The socket primitives shared by the session-socket wiring (`ws-handler.ts`)
// and the client sink (`ws-client-sink.ts`): the minimal WebSocket shape the
// runtime accepts, the `audio_done` frame, and a send that tolerates the close
// race. Split out so those two modules need not import from each other.

import { WS_OPEN } from "@alexkroman1/aai/internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { Logger } from "./runtime-config.ts";

/**
 * Minimal WebSocket interface accepted by {@link AgentRuntime.startSession}.
 *
 * Satisfied by the standard `WebSocket` and the `ws` npm package's WebSocket.
 *
 * @public
 */
export type SessionWebSocket = {
  readonly readyState: number;
  /**
   * Bytes queued by `send()` but not yet transmitted (standard WebSocket /
   * `ws` property). Optional so minimal test doubles remain assignable; when
   * absent, the audio backpressure guard is skipped.
   *
   * Explicitly `| undefined` rather than optional alone: under
   * `exactOptionalPropertyTypes` a WRAPPER around one of these sockets — the
   * telephony bridge is one — has to forward the property through a getter,
   * and a getter cannot be conditionally absent. Every reader already
   * branches on `undefined`, so this widens nothing in practice.
   */
  readonly bufferedAmount?: number | undefined;
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

/**
 * Narrow a `ws` WebSocket to the {@link SessionWebSocket} the runtime accepts.
 *
 * The two are structurally compatible in every way that matters at runtime,
 * but not to the checker: `ws` types `addEventListener` as a generic over its
 * own event map, which is not assignable to the four overloads declared above.
 *
 * ONE helper rather than a cast per call site. Every front door over
 * `createRuntimeServer` needs this same narrowing — the `/websocket` session path,
 * host mode, the telephony bridge — and a cast repeated per door is both a
 * suppression per door and an invitation to widen one of them by accident.
 * This is the seam; nothing else may cast to `SessionWebSocket`.
 */
export function asSessionWebSocket(ws: {
  readonly readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
}): SessionWebSocket {
  return ws as unknown as SessionWebSocket;
}

/**
 * Send on a session socket, tolerating the close race between the readyState check and send.
 * @internal
 */
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
