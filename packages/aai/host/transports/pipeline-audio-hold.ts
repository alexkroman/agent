// Copyright 2026 the AAI authors. MIT license.
// Provisional yield: hold the agent's outgoing audio while a barge-in decision
// is pending, then either drop it (the barge-in was real) or release it (it was
// not). Used by the pipeline transport's TTS emit path.

import { PIPELINE_MAX_AUDIO_HOLD_MS } from "../../sdk/constants.ts";
import { createRestartableTimer } from "../_timer.ts";

/**
 * A hold on outgoing TTS audio, taken the moment the caller starts speaking
 * over the agent and resolved once we know whether they meant it.
 *
 * **Stopping the noise and abandoning the turn are different decisions, and the
 * transport used to make them at the same moment.** A barge-in only fires once
 * the speech clears `minBargeInWords` and `interruptionMinDurationMs` — roughly
 * a second, given ~470ms to the first STT partial — so until then the agent
 * talks straight over the caller. Waiting less is not the fix either: the
 * signals that must NOT abort a reply (a cough, "mm-hmm", "hold on a second"
 * said to someone else in the room) are indistinguishable from a real
 * interruption at their first partial, and thresholds cannot separate them —
 * measured, a stricter word gate cost 12.7 points of yield rate and bought no
 * selectivity at all.
 *
 * What separates them is what happens NEXT: an aside stops, a real interruption
 * continues. So the two decisions are split. On the first partial the agent goes
 * quiet immediately — cheap, instant, and correct for both cases. Only sustained
 * speech then aborts the turn. If the speech was an aside, the held audio is
 * released and the same reply carries on from where it was, with no
 * `[interrupted]` marker, no resume prompt, and nothing re-spoken: the caller
 * hears a brief pause rather than the agent restarting a sentence it already
 * said.
 *
 * Measured motivation: non-directed speech aborted the reply on 23 of 23
 * occasions across three benchmark runs, and the agent then sat silent a median
 * 5.9s. Separately, 10% of consecutive agent utterances repeated 60%+ of their
 * words, which is the resume path re-speaking an interrupted sentence.
 *
 * **The hold is always bounded, and expiry is the NORMAL path.** Waiting for
 * the barge-in decision to resolve sounds right and is not reachable: the
 * resolving event is the STT final, which cannot arrive until
 * `min_turn_silence` (1600ms) after the caller stops, so a timer set below that
 * does essentially all the releasing. Measured on benchmark audio, an earlier
 * 1500ms "safety net" fired 33 times against 37 barge-ins. Hence a short duck
 * (`PIPELINE_MAX_AUDIO_HOLD_MS`, 400ms) that is expected to expire, with the
 * explicit resolve paths as the early-out rather than the design. Releasing is
 * always the safe direction: the worst case is the agent finishing a sentence
 * over a caller who really was interrupting, which is the pre-existing
 * behaviour. Never releasing would be a permanently mute agent.
 */
export interface AudioHold {
  /**
   * Begin withholding audio. Idempotent, and deliberately does NOT extend an
   * existing hold — see the note on the backstop.
   */
  hold(): void;
  /**
   * Offer a chunk. Returns what should go on the wire now: the chunk itself
   * when open, nothing while held.
   */
  push(pcm: Int16Array): Int16Array[];
  /** Resolve as a false alarm: returns the held audio, in order, to be emitted. */
  release(): Int16Array[];
  /** Resolve as a real barge-in: drop the held audio unheard. */
  discard(): void;
  held(): boolean;
}

export function createAudioHold(opts: {
  /**
   * Backstop (ms). Bounds a hold whose resolve event never arrives; also caps
   * how much audio can pile up, since the buffer only grows while held.
   */
  maxHoldMs: number;
  /** Called when the backstop fires, so the transport can emit the drained audio. */
  onBackstopRelease: (chunks: Int16Array[]) => void;
}): AudioHold {
  let holding = false;
  const buffer: Int16Array[] = [];
  const backstop = createRestartableTimer(() => {
    if (!holding) return;
    const drained = drain();
    // Emitting through the transport's own path rather than returning here:
    // the timer has no caller to hand the audio back to, and audio dropped on
    // the floor at this point is speech the caller never hears.
    opts.onBackstopRelease(drained);
  });

  function drain(): Int16Array[] {
    holding = false;
    backstop.clear();
    const out = buffer.slice();
    buffer.length = 0;
    return out;
  }

  return {
    hold(): void {
      // Only the FIRST duck of a stretch arms the timer. Re-arming on every
      // partial looks reasonable ("the caller is still talking, hold longer")
      // and deadlocks: once the agent is quiet the caller says "Are you still
      // there?", each partial pushes the deadline out, and the audio is never
      // released — which makes them talk more. Shipped that way, an agent went
      // mute mid-word and the caller hung up after 35s of silence. The window
      // is measured from the first word, always.
      if (holding) return;
      holding = true;
      backstop.arm(opts.maxHoldMs);
    },
    push(pcm: Int16Array): Int16Array[] {
      if (!holding) return [pcm];
      buffer.push(pcm);
      return [];
    },
    release: drain,
    discard(): void {
      holding = false;
      backstop.clear();
      buffer.length = 0;
    },
    held(): boolean {
      return holding;
    },
  };
}

/**
 * The agent's outgoing audio path: the duck plus the three side effects of
 * actually putting a chunk on the wire.
 *
 * Bundled because they must stay in the same order and on the same side of the
 * duck. `replyTail` and the playback clock model what the CALLER has heard, so
 * a chunk being withheld must not advance either — otherwise the cut-point
 * estimate and `isPlaybackPending` describe audio nobody received.
 */
export interface AgentAudioPath {
  /** Offer a chunk: emitted now, or buffered if ducked. */
  send(pcm: Int16Array): void;
  duck(): void;
  resume(): void;
  drop(): void;
}

export function createAgentAudioPath(opts: {
  /** Advanced only for audio that really went out — see the interface doc. */
  replyTail: { onAudio(pcm: Int16Array): void };
  playbackClock: { onChunk(pcm: Int16Array): void };
  toClient: (pcm: Int16Array) => void;
  onBackstop: () => void;
}): AgentAudioPath {
  const emit = (pcm: Int16Array): void => {
    opts.replyTail.onAudio(pcm);
    opts.playbackClock.onChunk(pcm);
    opts.toClient(pcm);
  };
  const hold = createAudioHold({
    maxHoldMs: PIPELINE_MAX_AUDIO_HOLD_MS,
    onBackstopRelease: (chunks) => {
      opts.onBackstop();
      for (const chunk of chunks) emit(chunk);
    },
  });
  const flush = (chunks: Int16Array[]): void => {
    for (const chunk of chunks) emit(chunk);
  };
  return {
    send: (pcm) => flush(hold.push(pcm)),
    duck: () => hold.hold(),
    resume: () => flush(hold.release()),
    drop: () => hold.discard(),
  };
}
