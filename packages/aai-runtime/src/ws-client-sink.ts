// Copyright 2026 the AAI authors. MIT license.
// The client-facing sink for a session socket: JSON text frames for events,
// raw PCM16 binary frames for audio, and the audio pacer that decides when
// each goes out. Split out of `ws-handler.ts`, which owns the socket
// lifecycle (handshake, keepalive, resume, teardown).

import { MAX_CLIENT_WS_BUFFERED_BYTES } from "@alexkroman1/aai/host-internal";
import { WS_OPEN } from "@alexkroman1/aai/internal";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import { createAudioPacer } from "./audio-pacer.ts";
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
 * through an {@link createAudioPacer} at a bounded lead rather than the instant
 * a provider frame arrives — otherwise a whole reply lands in the socket buffer
 * at once and a slow link turns that into seconds of invisible queue. The pacer
 * owns two ordering rules that follow from holding audio back: end-of-reply
 * frames are queued behind it (`audio.completed` and `reply.completed` — an early turn
 * boundary truncates the reply client-side, or hands its remaining audio to the
 * next turn), and a `reply.cancelled`/`session.reset` event discards it (the client flushes
 * its own buffer on those, so held audio would arrive as an orphan fragment).
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
  const pacer = createAudioPacer({
    sendAudio: (chunk) => safeSend(ws, chunk, log),
    sampleRate: ttsSampleRate,
    ...omitUndefined({ leadMs: audioLeadMs }),
  });
  const client: ClientSink = {
    get open() {
      return ws.readyState === WS_OPEN;
    },
    event(e) {
      // Both events tell the client to drop its playback buffer, so whatever
      // this turn still has queued here is dead audio.
      if (e.type === "reply.cancelled" || e.type === "session.reset") pacer.clear();
      // Both of these close out the turn the held audio belongs to, so neither
      // may overtake it — see the pacer's ordering rules. `audio.completed` is
      // the stronger case: the playback worklet takes it as "this is all there
      // is", so an early one truncates the reply. Every other event is
      // conversation-critical and goes out now — and pays no closure for the
      // privilege: only a DEFERRED send needs something to defer with, and this
      // runs per event on a live call.
      if (e.type === "reply.completed" || e.type === "audio.completed") {
        const frame = JSON.stringify(e);
        pacer.pushAfterAudio(() => safeSend(ws, frame, log));
        return;
      }
      safeSend(ws, JSON.stringify(e), log);
    },
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
      pacer.push(chunk);
    },
    close(reason) {
      try {
        ws.close?.(WS_CLOSE_NORMAL, reason);
      } catch (err) {
        log.debug("ws: sink close failed", { error: errorMessage(err) });
      }
    },
  };
  return { client, stopPacing: pacer.stop };
}
