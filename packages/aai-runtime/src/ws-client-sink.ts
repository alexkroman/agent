// Copyright 2026 the AAI authors. MIT license.
// The client-facing sink for a session socket: JSON text frames for events,
// raw PCM16 binary frames for audio, and the audio pacer that decides when
// each goes out. Split out of `ws-handler.ts`, which owns the socket
// lifecycle (handshake, keepalive, resume, teardown).

import { MAX_CLIENT_WS_BUFFERED_BYTES } from "@alexkroman1/aai/host-internal";
import { WS_OPEN } from "@alexkroman1/aai/internal";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import { errorMessage } from "@alexkroman1/aai/utils";
import { createPacedClientSink } from "./paced-client-sink.ts";
import type { Logger } from "./runtime-config.ts";
import { type SessionWebSocket, safeSend } from "./ws-frames.ts";

/** WebSocket close code sent when a stalled client is disconnected (policy violation). */
const WS_CLOSE_POLICY_VIOLATION = 1008;

/** Normal closure — used for server-initiated session retirement. */
const WS_CLOSE_NORMAL = 1000;

/**
 * Creates a {@link ClientSink} backed by a plain WebSocket.
 *
 * Session events are sent as JSON text frames; audio chunks are sent as raw
 * PCM16 binary frames.
 *
 * Audio pacing: TTS synthesis outruns real-time playback, so audio goes out
 * through {@link createPacedClientSink} at a bounded lead rather than the
 * instant a provider frame arrives — otherwise a whole reply lands in the socket
 * buffer at once and a slow link turns that into seconds of invisible queue.
 * The ordering rules that follow from holding audio back are documented there.
 *
 * Audio backpressure: the pacer keeps the socket buffer small in the ordinary
 * case, so `bufferedAmount` past {@link MAX_CLIENT_WS_BUFFERED_BYTES} (~87 s of
 * 24 kHz PCM16) now means a genuinely stalled link — the sink logs once and
 * closes the connection, which runs the normal session teardown. The client may
 * reconnect and resume via its sessionId. Sockets without `bufferedAmount` skip
 * the guard.
 */
export function createClientSink(
  ws: SessionWebSocket,
  log: Logger,
  ttsSampleRate: number,
  audioLeadMs?: number,
): { client: ClientSink; stopPacing: () => void } {
  let closedForBackpressure = false;
  // The socket itself, unpaced: frames and audio go out the moment they are
  // handed over. Pacing and its ordering rules are `paced-client-sink.ts`'s,
  // which is the same wrapper every other kind of client sink gets.
  const raw = {
    get open() {
      return ws.readyState === WS_OPEN;
    },
    event(e) {
      safeSend(ws, JSON.stringify(e), log);
    },
    playAudioChunk(chunk) {
      safeSend(ws, chunk, log);
    },
    close(reason) {
      try {
        ws.close?.(WS_CLOSE_NORMAL, reason);
      } catch (err) {
        log.debug("ws: sink close failed", { error: errorMessage(err) });
      }
    },
  } satisfies ClientSink;
  const paced = createPacedClientSink(raw, { sampleRate: ttsSampleRate, leadMs: audioLeadMs });
  const client: ClientSink = {
    get open() {
      return raw.open;
    },
    event: paced.client.event,
    // The stalled-link guard runs BEFORE the pacer, as it always has: a chunk
    // that arrives while the socket is already backed up past the budget is
    // dropped and the connection closed, rather than queued behind audio the
    // client is never going to receive.
    playAudioChunk(chunk) {
      const buffered = ws.bufferedAmount;
      if (buffered !== undefined && buffered > MAX_CLIENT_WS_BUFFERED_BYTES) {
        if (!closedForBackpressure) {
          closedForBackpressure = true;
          log.warn("ws: client audio backlog exceeded; closing stalled connection", {
            bufferedBytes: buffered,
            maxBufferedBytes: MAX_CLIENT_WS_BUFFERED_BYTES,
          });
          try {
            ws.close?.(WS_CLOSE_POLICY_VIOLATION, "audio backlog exceeded");
          } catch (err) {
            log.debug("ws: close after audio backlog failed", { error: errorMessage(err) });
          }
        }
        return;
      }
      paced.client.playAudioChunk(chunk);
    },
    close: raw.close,
  };
  return { client, stopPacing: paced.stopPacing };
}
