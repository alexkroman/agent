// Copyright 2026 the AAI authors. MIT license.
/**
 * How loud was the inbound audio under a transcript's words?
 *
 * A ledger of per-block levels over the PCM16 an STT session has actually
 * SENT to its service, indexed on that service's own audio axis: sample 0 is
 * the first sample sent on this socket, so a word timestamp the service
 * reports (milliseconds into the stream it received) lands on the block that
 * carried it. That is why the ledger lives in the provider rather than in the
 * transport — audio the provider drops before sending (a stalled link, see
 * `_audio-gate.ts`) never advances the service's clock, and a ledger fed
 * upstream of that drop would drift off it. A reconnect opens a new session
 * and so a new ledger: the service's clock restarts, and so does this one.
 *
 * Levels are RMS in dBFS over fixed {@link LEVEL_BLOCK_MS} blocks, carried
 * across frame boundaries so a block always spans the same number of samples
 * however the frames were cut. Only the last {@link LEVEL_LEDGER_MS} are
 * kept.
 *
 * @module
 */

/** Width of one level block, in ms. @internal */
export const LEVEL_BLOCK_MS = 50;
/** How much level history a ledger retains, in ms. @internal */
export const LEVEL_LEDGER_MS = 30_000;
/** Padding either side of a word span when looking up its peak, in ms. @internal */
export const LEVEL_SPAN_PAD_MS = 100;
/**
 * The floor a level is clamped to, in dBFS. Digital silence is `-Infinity`,
 * which neither compares usefully nor survives a JSON log line.
 *
 * @internal
 */
export const LEVEL_FLOOR_DBFS = -100;

/** RMS of a sum of squares over `n` PCM16 samples, in dBFS. @internal */
export function rmsDbfs(sumSquares: number, n: number): number {
  if (n <= 0 || sumSquares <= 0) return LEVEL_FLOOR_DBFS;
  const db = 20 * Math.log10(Math.sqrt(sumSquares / n) / 32_768);
  return Math.max(LEVEL_FLOOR_DBFS, db);
}

/** Per-block level history of one STT socket's outbound audio. @internal */
export interface InputLevelLedger {
  /** Account for `pcm` as the next samples sent to the service. */
  record(pcm: Int16Array): void;
  /**
   * The loudest block overlapping `[startMs, endMs]` (padded by
   * {@link LEVEL_SPAN_PAD_MS}), in dBFS, or `undefined` when no retained,
   * completed block overlaps it — a span the ledger cannot see has no level,
   * rather than a quiet one.
   */
  peakDbfs(startMs: number, endMs: number): number | undefined;
}

/** Create an {@link InputLevelLedger} for audio at `sampleRate`. @internal */
export function createInputLevelLedger(sampleRate: number): InputLevelLedger {
  const blockSamples = Math.max(1, Math.round((sampleRate * LEVEL_BLOCK_MS) / 1000));
  const capacity = Math.ceil(LEVEL_LEDGER_MS / LEVEL_BLOCK_MS);
  const levels = new Float64Array(capacity);
  /** Completed blocks since the socket opened; block `i` is at `levels[i % capacity]`. */
  let completed = 0;
  let pendingSumSquares = 0;
  let pendingSamples = 0;

  return {
    record(pcm: Int16Array): void {
      for (const sample of pcm) {
        pendingSumSquares += sample * sample;
        pendingSamples += 1;
        if (pendingSamples === blockSamples) {
          levels[completed % capacity] = rmsDbfs(pendingSumSquares, pendingSamples);
          completed += 1;
          pendingSumSquares = 0;
          pendingSamples = 0;
        }
      }
    },

    peakDbfs(startMs: number, endMs: number): number | undefined {
      if (!(Number.isFinite(startMs) && Number.isFinite(endMs)) || endMs < startMs) {
        return undefined;
      }
      const msPerBlock = (blockSamples * 1000) / sampleRate;
      const first = Math.max(
        Math.floor((startMs - LEVEL_SPAN_PAD_MS) / msPerBlock),
        completed - capacity,
        0,
      );
      const last = Math.min(Math.floor((endMs + LEVEL_SPAN_PAD_MS) / msPerBlock), completed - 1);
      if (last < first) return undefined;
      let peak = LEVEL_FLOOR_DBFS;
      for (let i = first; i <= last; i++) peak = Math.max(peak, levels[i % capacity] ?? peak);
      return peak;
    },
  };
}
