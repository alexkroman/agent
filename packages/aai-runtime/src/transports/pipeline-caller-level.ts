// Copyright 2026 the AAI authors. MIT license.
/**
 * Is this utterance the CALLER, or something the caller's microphone picked
 * up? The relative-level veto on barge-in.
 *
 * Pipeline mode transcribes everything in the caller's channel. A television
 * behind the caller, or a quiet aside, comes back from the STT as ordinary
 * text, and at one interim word it barges in on the reply: the audio the
 * caller was listening to is destroyed and the aside is committed as a turn
 * the model answers. Measured on recorded calls with a television in the
 * room: non-caller audio peaked at RMS ≤ 658 (int16, about -34 dBFS) while
 * every real caller message peaked at ≥ 5268 (about -16 dBFS) — an 18 dB
 * margin, with the quietest real utterance (a backchannel "mm-hmm", 1922,
 * about -25 dBFS) still well inside it.
 *
 * So each transcript's loudest audio (`SttTurnMeta.inputPeakDbfs`, measured
 * by the provider on its own audio clock) is compared with the caller's
 * running speech level, and one more than {@link CALLER_LEVEL_VETO_DB} below
 * it is QUIET. The rule is deliberately narrow:
 *
 * - **It only ever blocks.** A quiet utterance may not barge in; nothing about
 *   level can START a barge-in the other rules declined.
 * - **It fails OPEN.** No peak (a provider without word timings, a span the
 *   ledger no longer covers) or no reference yet (fewer than
 *   {@link CALLER_LEVEL_MIN_SAMPLES} committed utterances) is never quiet.
 * - **The reference is the caller's own committed speech**: the median peak of
 *   the last {@link CALLER_LEVEL_WINDOW} committed turns that were not quiet
 *   themselves, so a dropped aside — or one committed while the agent was
 *   silent — cannot drag the reference down toward the noise it is there to
 *   reject. A median, so one shout or one mumble does not move it either.
 *
 * It reads no playback clock and no wall-clock onset estimate: both sides of
 * the comparison are levels of audio the service really received.
 *
 * @module
 */

/**
 * How far below the caller's reference an utterance's peak must be to count
 * as quiet, in dB. The measured gap between the loudest non-caller audio and
 * the quietest real caller message was ~18 dB; 12 leaves room on both sides.
 *
 * @internal
 */
export const CALLER_LEVEL_VETO_DB = 12;
/** Committed utterances the reference is the median of. @internal */
export const CALLER_LEVEL_WINDOW = 8;
/** Committed utterances needed before any utterance can be quiet. @internal */
export const CALLER_LEVEL_MIN_SAMPLES = 2;

/** One utterance's level, set against the caller's reference. @internal */
export interface CallerLevelReading {
  /** The utterance's loudest audio, dBFS (one decimal), when the provider reported it. */
  peakDb?: number;
  /** The caller's reference level, dBFS (one decimal), once established. */
  refDb?: number;
  /** More than {@link CALLER_LEVEL_VETO_DB} below the reference. Never true without both. */
  quiet: boolean;
}

/** The caller's running speech level. @internal */
export interface CallerLevel {
  /** Read `peakDbfs` (the transcript's `inputPeakDbfs`) against the reference. */
  read(peakDbfs: number | undefined): CallerLevelReading;
  /** A caller turn committed with this reading — feeds the reference unless quiet. */
  onCommitted(reading: CallerLevelReading): void;
}

const round1 = (db: number): number => Math.round(db * 10) / 10;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Create a {@link CallerLevel} with no reference yet. @internal */
export function createCallerLevel(): CallerLevel {
  const peaks: number[] = [];
  const reference = (): number | undefined =>
    peaks.length >= CALLER_LEVEL_MIN_SAMPLES ? median(peaks) : undefined;

  return {
    read(peakDbfs: number | undefined): CallerLevelReading {
      const refDb = reference();
      if (peakDbfs === undefined || !Number.isFinite(peakDbfs)) {
        return refDb === undefined ? { quiet: false } : { refDb: round1(refDb), quiet: false };
      }
      const peakDb = round1(peakDbfs);
      if (refDb === undefined) return { peakDb, quiet: false };
      return { peakDb, refDb: round1(refDb), quiet: peakDbfs < refDb - CALLER_LEVEL_VETO_DB };
    },

    onCommitted(reading: CallerLevelReading): void {
      if (reading.quiet || reading.peakDb === undefined) return;
      peaks.push(reading.peakDb);
      if (peaks.length > CALLER_LEVEL_WINDOW) peaks.shift();
    },
  };
}
