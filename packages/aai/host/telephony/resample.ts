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
 *   is exactly the kind of bug that ships. A 63-tap Hamming-windowed sinc
 *   runs ahead of the interpolator on this path.
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
 * A stateful FIR, carrying the `taps - 1` samples of history that the next
 * chunk's leading outputs depend on. Group delay is a constant `(taps-1)/2`
 * input samples — ~1.3 ms at 24 kHz, below anything the turn-taking logic
 * measures.
 */
function createFir(coefficients: Float64Array): (input: Int16Array) => Float64Array {
  const taps = coefficients.length;
  const history = new Float64Array(taps - 1);
  return (input) => {
    const padded = new Float64Array(history.length + input.length);
    padded.set(history, 0);
    for (let i = 0; i < input.length; i++) padded[history.length + i] = input[i] as number;

    const output = new Float64Array(input.length);
    for (let n = 0; n < input.length; n++) {
      let acc = 0;
      for (let k = 0; k < taps; k++) {
        acc += (coefficients[k] as number) * (padded[history.length + n - k] as number);
      }
      output[n] = acc;
    }
    // Carry the tail forward. When a chunk is shorter than the history the
    // slice is taken from `padded`, which already holds the old history — so
    // a run of tiny chunks cannot lose samples out of the middle.
    history.set(padded.subarray(padded.length - history.length));
    return output;
  };
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
function createInterpolator(step: number): (input: Int16Array | Float64Array) => Int16Array {
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
 * Build a converter from `inputRate` to `outputRate`.
 *
 * Equal rates return a pass-through rather than a degenerate filter — the
 * telephony bridge asks for both directions unconditionally, and an agent
 * already running at 8 kHz should pay nothing for that.
 */
export function createResampler(inputRate: number, outputRate: number): Resampler {
  if (inputRate === outputRate) return { process: (input) => input };

  const interpolate = createInterpolator(inputRate / outputRate);
  if (outputRate >= inputRate) return { process: interpolate };

  const cutoff = (CUTOFF_FRACTION * (outputRate / 2)) / inputRate;
  const filter = createFir(designLowPass(cutoff, FIR_TAPS));
  return { process: (input) => interpolate(filter(input)) };
}
