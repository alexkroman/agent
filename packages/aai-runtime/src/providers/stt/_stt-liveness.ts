// Copyright 2026 the AAI authors. MIT license.
/**
 * Is the STT socket still listening?
 *
 * A streaming STT socket can go DEAF: it stays open, accepts audio and sends
 * no error, but stops answering — no partial, no final, nothing — while the
 * caller keeps talking. Recorded on tau2-bench retail with `universal-3-5-pro`:
 * 4 of 5 sims flagged unresponsive (the caller spoke three times running with
 * no reply) sat in a 42–90s window with zero STT events, and 11 more sims
 * lost turns the same way. A raw websocket client with no AAI code in it
 * reproduces it on the same audio, so it is the service, not our params; and
 * a FRESH socket hears again. Nothing about it reaches the transport — a deaf
 * socket looks exactly like a silent caller.
 *
 * So the provider watches what it SENDS, and reopens the socket on either of
 * two signs:
 *
 * - **Voiced audio with no turn event**: {@link STT_DEAF_VOICED_MS} of audio
 *   well above the line's own noise floor (and above an absolute floor) with
 *   no partial or final at all.
 * - **A turn left open**: a partial arrived, then nothing — no further partial
 *   and no final — for longer than the socket's own end-of-turn ceiling plus
 *   {@link STT_STUCK_MARGIN_MS}. A live socket must end that turn by then; one
 *   recorded call heard "Hello?", sent that one partial, and held the turn for
 *   16s through the caller's silence, so the voiced rule (reset by the
 *   partial, and blind to silence) could not see it. Content-blind; nothing
 * reads what was said. The last {@link STT_REPLAY_MS} of audio is kept so the
 * new socket hears the utterance that exposed the old one — replaying it took
 * a recorded replay from 5 to 54 of 58 caller utterances heard.
 *
 * @module
 */

import { rmsDbfs } from "./_input-level-ledger.ts";

/** Voiced audio with no turn event, in ms, that marks a socket deaf. @internal */
export const STT_DEAF_VOICED_MS = 2500;
/** How far above the running noise floor a frame must be to count as voiced, in dB. @internal */
export const STT_VOICED_MARGIN_DB = 15;
/**
 * The absolute level a voiced frame must also clear, in dBFS — so a line that
 * opens on digital silence (floor at -100) doesn't count room tone as speech.
 *
 * @internal
 */
export const STT_VOICED_MIN_DBFS = -45;
/** How far past the end-of-turn ceiling an open turn may sit with no event, in ms. @internal */
export const STT_STUCK_MARGIN_MS = 1500;
/** How much recent audio a reopened socket is sent first, in ms. @internal */
export const STT_REPLAY_MS = 3000;
/** How fast the noise floor rises toward a louder line, in dB per second. It falls at once. @internal */
const FLOOR_RISE_DB_PER_S = 1;

/** RMS level of `pcm`, in dBFS. */
export function levelOf(pcm: Int16Array): number {
  let sum = 0;
  for (const s of pcm) sum += s * s;
  return rmsDbfs(sum, pcm.length);
}

/** The noise floor after a frame at `level`: falls at once, rises slowly. */
function nextFloor(floor: number | undefined, level: number, ms: number): number {
  if (floor === undefined || level < floor) return level;
  return floor + (FLOOR_RISE_DB_PER_S * ms) / 1000;
}

/** One socket's liveness watch — see the module doc. @internal */
export interface SttLivenessWatch {
  /** Account for `pcm` as the next frame sent; true once the socket should be reopened. */
  observe(pcm: Int16Array): boolean;
  /** The service answered: a partial (`final` false) leaves a turn open, a final closes it. */
  heard(final: boolean): void;
  /** The last {@link STT_REPLAY_MS} of frames observed, oldest first. */
  recent(): readonly Int16Array[];
  /** A fresh socket was opened: start counting again. Keeps the floor and the recent audio. */
  reopened(): void;
}

/** @internal */
export function createSttLivenessWatch(
  sampleRate: number,
  opts: { deafMs?: number; replayMs?: number; maxTurnSilenceMs: number },
): SttLivenessWatch {
  const deafMs = opts.deafMs ?? STT_DEAF_VOICED_MS;
  const replaySamples = ((opts.replayMs ?? STT_REPLAY_MS) * sampleRate) / 1000;
  let floor: number | undefined;
  const stuckMs = opts.maxTurnSilenceMs + STT_STUCK_MARGIN_MS;
  let voicedMs = 0;
  let turnOpen = false;
  let sinceEventMs = 0;
  const frames: Int16Array[] = [];
  let buffered = 0;
  const retain = (pcm: Int16Array): void => {
    frames.push(pcm.slice());
    buffered += pcm.length;
    while (frames.length > 1 && buffered - (frames[0]?.length ?? 0) >= replaySamples) {
      buffered -= frames.shift()?.length ?? 0;
    }
  };
  return {
    observe(pcm) {
      if (pcm.length === 0) return false;
      const ms = (pcm.length * 1000) / sampleRate;
      const level = levelOf(pcm);
      floor = nextFloor(floor, level, ms);
      if (level > floor + STT_VOICED_MARGIN_DB && level > STT_VOICED_MIN_DBFS) voicedMs += ms;
      sinceEventMs += ms;
      retain(pcm);
      return deafMs > 0 && (voicedMs >= deafMs || (turnOpen && sinceEventMs >= stuckMs));
    },
    heard(final) {
      voicedMs = 0;
      sinceEventMs = 0;
      turnOpen = !final;
    },
    recent: () => frames,
    reopened() {
      voicedMs = 0;
      sinceEventMs = 0;
      turnOpen = false;
    },
  };
}
