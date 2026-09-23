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
 * the WIRE: a session reaching its client any other way — `runtime.connect`,
 * the console — would have had to re-derive both rules. Now the socket sink is
 * this wrapper plus a stalled-link guard, and any other sink gets the same
 * rules by construction.
 */

import type { ClientSink } from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { createAudioPacer } from "./audio-pacer.ts";

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

/**
 * Wrap `raw` so its audio is paced and its turn-closing events wait for it.
 *
 * Returns the paced sink and a `stopPacing` that releases the pacer's pending
 * timer. Call it when the far end goes away: a paced send left scheduled would
 * fire into a closed connection, and the timer would outlive the session.
 */
export function createPacedClientSink(
  raw: ClientSink,
  options: PacedClientSinkOptions,
): { client: ClientSink; stopPacing: () => void } {
  const pacer = createAudioPacer({
    sendAudio: (chunk) => raw.playAudioChunk(chunk),
    sampleRate: options.sampleRate,
    ...omitUndefined({ leadMs: options.leadMs }),
  });
  const client: ClientSink = {
    get open() {
      return raw.open;
    },
    event(e) {
      if (e.type === "reply.cancelled" || e.type === "session.reset") pacer.clear();
      // Only a DEFERRED send needs a closure to defer with, and this runs per
      // event on a live call — so the common case pays for none.
      if (e.type === "reply.completed" || e.type === "audio.completed") {
        pacer.pushAfterAudio(() => raw.event(e));
        return;
      }
      raw.event(e);
    },
    playAudioChunk(chunk) {
      pacer.push(chunk);
    },
    close(reason) {
      raw.close?.(reason);
    },
  };
  return { client, stopPacing: pacer.stop };
}
