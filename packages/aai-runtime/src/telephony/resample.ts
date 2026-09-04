// Copyright 2026 the AAI authors. MIT license.
/**
 * Streaming sample-rate conversion between the session's PCM16 rate and the
 * carrier's 8 kHz.
 *
 * **Rate conversion belongs at the edge, and the telephony bridge IS the
 * edge.** The host deliberately does not resample for its own clients (see
 * "The host does not resample" in `packages/aai/CLAUDE.md`) — every other
 * client owns its rate, so asking it to send the advertised rate is both
 * cheaper and more honest than papering over it in the hot path. A phone
 * carrier is the one client that cannot comply: 8 kHz μ-law is what the PSTN
 * carries, in both directions, and there is nothing on the far side to ask.
 * So the conversion sits here, in the adapter, exactly where that rule puts
 * it — and the session stack above stays rate-agnostic and untouched.
 *
 * Two directions, two different jobs:
 *
 * - **Downsampling** (agent speech, 16/24 kHz → 8 kHz) must LOW-PASS FIRST.
 *   Decimating without it folds everything from 4 kHz up back into the
 *   speech band, and TTS output has real energy there — the result is not
 *   subtle, but it reads as a poor phone line rather than as a defect, which
 *   is exactly the kind of bug that ships. A 63-tap Hamming-windowed sinc is
 *   evaluated where the decimator reads it, in one pass — see
 *   {@link createDecimator} for why that is a rearrangement of the same
 *   arithmetic and not a different filter.
 * - **Upsampling** (caller speech, 8 kHz → 16/24 kHz) needs no filter. The
 *   source is already band-limited to ~3.4 kHz by the carrier, so there is
 *   no content between 4 kHz and the new Nyquist to alias, and linear
 *   interpolation's images sit above everything STT looks at. Adding a
 *   filter here would cost CPU on the every-20ms path to remove nothing.
 *
 * Both directions are STATEFUL and must stay that way: a converter rebuilt
 * per chunk restarts its phase and its filter history every 20 ms, which
 * puts a discontinuity at every chunk boundary — 50 clicks a second, audible
 * as a buzz at the frame rate and, on the inbound path, a transcript that
 * degrades for no visible reason.
 */

/** Taps in the anti-alias filter. See the transition-width note in `designLowPass`. */
const FIR_TAPS = 63;

/**
 * Anti-alias cutoff, as a fraction of the OUTPUT rate's Nyquist.
 *
 * 0.9 puts the corner at 3.6 kHz for an 8 kHz output — just above the
 * ~3.4 kHz the carrier itself passes, so the filter removes what would alias
 * without eating any band the caller was ever going to hear.
 */
const CUTOFF_FRACTION = 0.9;

/** Converts PCM16 at one rate to PCM16 at another, across successive chunks. */
export type Resampler = {
  /** Convert one chunk. The returned array is freshly allocated. */
  process(input: Int16Array): Int16Array;
};

function sinc(x: number): number {
  if (x === 0) return 1;
  const piX = Math.PI * x;
  return Math.sin(piX) / piX;
}

/**
 * A Hamming-windowed sinc low-pass, normalized to unity DC gain.
 *
 * `cutoff` is in cycles per input sample (0–0.5). At 63 taps the transition
 * band is roughly 3.3/63 ≈ 0.052 cycles/sample — ~1.3 kHz against a 24 kHz
 * input, which keeps the passband intact out to ~3 kHz while reaching the
 * Hamming stopband (-53 dB) before the 4 kHz fold point.
 */
function designLowPass(cutoff: number, taps: number): Float64Array {
  const coefficients = new Float64Array(taps);
  const center = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    const value = 2 * cutoff * sinc(2 * cutoff * (i - center)) * window;
    coefficients[i] = value;
    sum += value;
  }
  // Normalize so a DC input passes at exactly unity — otherwise the windowed
  // truncation shifts the level by a fraction of a dB, which compounds
  // across a call's worth of chunks in the μ-law encoder's low segments.
  for (let i = 0; i < taps; i++) coefficients[i] = (coefficients[i] as number) / sum;
  return coefficients;
}

/**
 * One filtered sample: `sum(coefficients[k] * x[n - k])`, reading `history` for
 * the indices that fall before this chunk.
 *
 * `history` holds the `taps` most recent input samples with `x[-1]` last — ONE
 * more than the convolution itself needs, because the interpolator's left
 * neighbour at the top of a chunk is the previous chunk's final sample, and
 * `filtered(-1)` reaches back `taps` samples from there.
 *
 * Group delay is a constant `(taps-1)/2` input samples — ~1.3 ms at 24 kHz,
 * below anything the turn-taking logic measures.
 */
function filteredAt(
  coefficients: Float64Array,
  history: Float64Array,
  input: Int16Array,
  n: number,
): number {
  const taps = coefficients.length;
  let acc = 0;
  for (let k = 0; k < taps; k++) {
    const j = n - k;
    acc +=
      (coefficients[k] as number) * (j >= 0 ? (input[j] as number) : (history[taps + j] as number));
  }
  return acc;
}

/**
 * Keep the `history.length` most recent input samples for the next chunk.
 *
 * A chunk shorter than the history SHIFTS what is already there rather than
 * replacing it, so a run of tiny chunks cannot lose samples out of the middle.
 */
function carryHistory(history: Float64Array, input: Int16Array): void {
  const taps = history.length;
  if (input.length >= taps) {
    history.set(input.subarray(input.length - taps));
    return;
  }
  history.copyWithin(0, input.length);
  history.set(input, taps - input.length);
}

function clampToPcm16(value: number): number {
  const rounded = Math.round(value);
  if (rounded > 32_767) return 32_767;
  if (rounded < -32_768) return -32_768;
  return rounded;
}

/**
 * Linear interpolation at a fixed rate ratio, carrying the phase and the
 * final sample of each chunk into the next.
 */
function createInterpolator(step: number): (input: Int16Array) => Int16Array {
  let previous = 0;
  let phase = 0;
  return (input) => {
    // One output per `step` inputs, plus slack for a phase that starts mid-step.
    const output = new Int16Array(Math.ceil(input.length / step) + 2);
    let written = 0;
    for (const sample of input) {
      while (phase < 1) {
        output[written++] = clampToPcm16(previous + (sample - previous) * phase);
        phase += step;
      }
      phase -= 1;
      previous = sample;
    }
    return output.subarray(0, written);
  };
}

/**
 * Filter and decimate in ONE pass, evaluating the anti-alias FIR only where an
 * output sample actually reads it.
 *
 * Filtering the whole chunk and then interpolating computed one 63-tap
 * convolution per INPUT sample and threw away everything the decimator stepped
 * over: at 24 kHz → 8 kHz that is two outputs in three discarded, ~1.5M
 * multiply-accumulates a second per call against the ~500k the conversion
 * needs. Here each output evaluates the filter at its left neighbour, and at
 * its right neighbour only when the phase is fractional — at an integer ratio
 * (both rates this bridge ever sees: 16 kHz and 24 kHz down to 8 kHz) the
 * phase is always 0, the right neighbour has weight 0, and exactly one
 * convolution runs per output. Measured on the phase schedule: 3.00x fewer at
 * 24 kHz, 2.00x at 16 kHz, and still 1.38x at a non-integer ratio.
 *
 * It also drops the two Float64Array allocations per chunk (the padded input
 * and the filtered output) — 100 a second per live call — leaving only the
 * PCM16 result the caller receives.
 *
 * The output is **sample-for-sample identical** to filter-then-interpolate,
 * which is a property worth keeping: the same coefficients accumulate in the
 * same order over the same operands, and the linear blend is the same
 * expression, so this is a rearrangement of the work rather than a new filter.
 * `resample.test.ts` pins the exact samples.
 */
function createDecimator(
  coefficients: Float64Array,
  step: number,
): (input: Int16Array) => Int16Array {
  const history = new Float64Array(coefficients.length);
  let phase = 0;
  return (input) => {
    const output = new Int16Array(Math.ceil(input.length / step) + 2);
    let written = 0;
    for (let n = 0; n < input.length; n++) {
      let left: number | undefined;
      let right: number | undefined;
      while (phase < 1) {
        left ??= filteredAt(coefficients, history, input, n - 1);
        // At phase 0 the right neighbour is multiplied by 0 — not computing it
        // is the whole saving, and dropping the term keeps the arithmetic
        // identical rather than merely close.
        if (phase !== 0) right ??= filteredAt(coefficients, history, input, n);
        output[written++] = clampToPcm16(
          right === undefined ? left : left + (right - left) * phase,
        );
        phase += step;
      }
      phase -= 1;
    }
    carryHistory(history, input);
    return output.subarray(0, written);
  };
}

/**
 * Build a converter from `inputRate` to `outputRate`.
 *
 * Equal rates return a pass-through rather than a degenerate filter — the
 * telephony bridge asks for both directions unconditionally, and an agent
 * already running at 8 kHz should pay nothing for that.
 */
export function createResampler(inputRate: number, outputRate: number): Resampler {
  if (inputRate === outputRate) return { process: (input) => input };

  if (outputRate >= inputRate) return { process: createInterpolator(inputRate / outputRate) };

  const cutoff = (CUTOFF_FRACTION * (outputRate / 2)) / inputRate;
  const filter = designLowPass(cutoff, FIR_TAPS);
  return { process: createDecimator(filter, inputRate / outputRate) };
}
