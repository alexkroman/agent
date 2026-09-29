// Copyright 2026 the AAI authors. MIT license.
/**
 * Real-time pacing for ANY client sink — the half of `ws-client-sink.ts` that
 * never knew it was talking to a socket.
 *
 * TTS synthesis outruns playback, so a reply's audio goes out through an
 * {@link createAudioPacer} at a bounded lead rather than the instant a provider
 * frame arrives. Holding audio back is what creates the two ordering rules this
 * wrapper owns, and they are the same for a browser socket, a phone call or a
 * speaker on the developer's desk:
 *
 * - `audio.completed` and `reply.completed` close out the turn the held audio
 *   belongs to, so neither may overtake it. An early `audio.completed` is read
 *   by a player as "this is all there is" and truncates the reply.
 * - `reply.cancelled` and `session.reset` discard it. Both tell the client to
 *   drop its own playback buffer, so held audio arriving afterwards would be an
 *   orphan fragment of a reply nobody is listening to any more.
 *
 * Everything else is conversation-critical and goes straight through.
 *
 * It used to live inside the WebSocket sink, which made pacing a property of
 * the WIRE: a session reaching its client any other way — `connectSession`,
 * the console — would have had to re-derive both rules. Now the socket sink is
 * this wrapper plus a stalled-link guard, and any other sink gets the same
 * rules by construction.
 */

import type { ClientSink } from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { createAudioPacer } from "./audio-pacer.ts";

/**
 * How long past the playout clock `endSession` waits before it closes.
 *
 * The clock says when the far end has PLAYED what was sent if it plays the
 * instant a frame lands. It does not: a browser holds a jitter cushion before
 * it starts, a carrier buffers, and the frames spend a network hop getting
 * there. Half a second covers all three on an ordinary link; what it costs is
 * half a second of line open after the goodbye, which a caller does not hear.
 */
export const END_SESSION_PLAYOUT_MARGIN_MS = 500;

/**
 * Longest `endSession` waits for the current reply to end before it closes
 * anyway. A reply that never completes — a provider that stalls mid-goodbye,
 * or a tool that ended the session outside any reply — must not hold a phone
 * line open; 30 s is past any spoken goodbye and the model's own deadline.
 */
export const END_SESSION_REPLY_TIMEOUT_MS = 30_000;

/** Options for {@link createPacedClientSink}. */
export type PacedClientSinkOptions = {
  /** Sample rate of the agent audio the session emits (its `ttsSampleRate`). */
  sampleRate: number;
  /**
   * Lead ceiling in ms. Defaults to `CLIENT_AUDIO_LEAD_MS`;
   * `UNPACED_AUDIO_LEAD_MS` keeps the ordering rules and drops the metering.
   */
  leadMs?: number | undefined;
};

/** What {@link createPacedClientSink} returns. */
export type PacedClientSink = {
  client: ClientSink;
  /** Release the pacer's pending timer, and a pending {@link PacedClientSink.endAfterReply}. */
  stopPacing: () => void;
  /**
   * `endSession(ctx)`'s half: run `close` once the current reply has been
   * HEARD — its `reply.completed` has gone out behind its audio and the playout
   * clock has run down, plus {@link END_SESSION_PLAYOUT_MARGIN_MS}. A barge-in
   * (`reply.cancelled`) closes at once: the caller interrupted the goodbye.
   * Bounded by {@link END_SESSION_REPLY_TIMEOUT_MS}. `afterReply: false` closes
   * now. A second request is ignored.
   */
  endAfterReply: (request: { afterReply: boolean }, close: () => void) => void;
};

/**
 * Wrap `raw` so its audio is paced and its turn-closing events wait for it.
 *
 * Returns the paced sink and a `stopPacing` that releases the pacer's pending
 * timer. Call it when the far end goes away: a paced send left scheduled would
 * fire into a closed connection, and the timer would outlive the session.
 *
 * **It also owns ending a session after its goodbye**, because the playout
 * clock that says when a reply has been heard is the pacer's and nothing else
 * has it — see {@link PacedClientSink.endAfterReply}.
 */
export function createPacedClientSink(
  raw: ClientSink,
  options: PacedClientSinkOptions,
): PacedClientSink {
  const pacer = createAudioPacer({
    sendAudio: (chunk) => raw.playAudioChunk(chunk),
    sampleRate: options.sampleRate,
    ...omitUndefined({ leadMs: options.leadMs }),
  });
  /** The close an `endAfterReply` is waiting to run, until it has run. */
  let pendingClose: (() => void) | null = null;
  /** Whether an end was asked for at all — the second request is ignored. */
  let endRequested = false;
  let endTimer: ReturnType<typeof setTimeout> | null = null;

  function clearEndTimer(): void {
    if (endTimer === null) return;
    clearTimeout(endTimer);
    endTimer = null;
  }

  /** Run the pending close after `delayMs` (now, for none), replacing the reply deadline. */
  function closeAfter(delayMs: number): void {
    const close = pendingClose;
    if (close === null) return;
    pendingClose = null;
    clearEndTimer();
    if (delayMs <= 0) {
      close();
      return;
    }
    endTimer = setTimeout(() => {
      endTimer = null;
      close();
    }, delayMs);
  }

  const client: ClientSink = {
    get open() {
      return raw.open;
    },
    event(e) {
      if (e.type === "reply.cancelled" || e.type === "session.reset") pacer.clear();
      // Only a DEFERRED send needs a closure to defer with, and this runs per
      // event on a live call — so the common case pays for none.
      if (e.type === "reply.completed" || e.type === "audio.completed") {
        pacer.pushAfterAudio(() => {
          raw.event(e);
          // Everything before this frame has been SENT; what is left is the
          // far end playing it, which is what the clock measures.
          if (e.type === "reply.completed" && pendingClose !== null) {
            closeAfter(pacer.playoutRemainingMs() + END_SESSION_PLAYOUT_MARGIN_MS);
          }
        });
        return;
      }
      raw.event(e);
      if (e.type === "reply.cancelled" && pendingClose !== null) closeAfter(0);
    },
    playAudioChunk(chunk) {
      pacer.push(chunk);
    },
    close(reason) {
      raw.close?.(reason);
    },
  };
  return {
    client,
    stopPacing: () => {
      pacer.stop();
      clearEndTimer();
      pendingClose = null;
    },
    endAfterReply(request, close) {
      if (endRequested) return;
      endRequested = true;
      if (!request.afterReply) {
        close();
        return;
      }
      pendingClose = close;
      endTimer = setTimeout(() => closeAfter(0), END_SESSION_REPLY_TIMEOUT_MS);
    },
  };
}
