// Copyright 2026 the AAI authors. MIT license.
/**
 * G.711 μ-law (PCMU) — the codec every phone carrier speaks.
 *
 * Twilio Media Streams and Telnyx media streaming both carry 8 kHz mono
 * μ-law, base64'd inside a JSON frame, in both directions. Nothing else is
 * negotiable on those transports, so this conversion is unconditional on the
 * telephony path rather than a format option.
 *
 * The implementation is the canonical Sun `g711.c` one, kept sample-exact
 * rather than approximated: μ-law is a *piecewise* logarithmic encoding whose
 * segment boundaries a "close enough" curve does not reproduce, and the
 * damage shows up as a quiet distortion floor that reads as a bad line rather
 * than as a bug in here.
 *
 * Decode is table-driven (256 entries, built once); encode runs the segment
 * search per sample, which at 8 kHz is 8000 iterations of a 4-step loop per
 * second of speech — far below anything worth a 64 KB table.
 *
 * ## What the round trip guarantees, and why it is not a relative bound
 *
 * Measured over the full Int16 domain, `mulawToPcm16(pcm16ToMulaw(x))` is
 * within `max(7, (11 / 121) * |x|)` of `x` — an absolute FLOOR of 7 plus a
 * relative slope of ~9.09%, both tight (`mulaw.test.ts` asserts that neither
 * can be lowered). A purely relative bound does not exist: the worst relative
 * error is **7.0**, at x = -1, which encodes to the lowest nonzero code and
 * decodes to -8. That is companding working, not a defect — the step size
 * grows with amplitude, so a sample quieter than one step is quantized to the
 * step — but it means an assertion of the form "relative error < 6.25%" is
 * false for every quiet sample. The one that used to live here read
 * `worst < 0.07` over a single amplitude-30000 sine, whose smallest nonzero
 * sample is 942; the same sine at amplitude 30 measures 7.0.
 *
 * The property that protects this implementation is MONOTONICITY, which holds
 * across all 65,536 values: a louder sample never decodes quieter. Shifting
 * `SEGMENT_ENDS` by one leaves the exhaustive 256-code fixed-point test
 * passing and breaks monotonicity in 16 places.
 */

/** μ-law's DC bias, added before the segment search and removed after. */
const BIAS = 0x84;

/** Largest magnitude μ-law can represent, in the encoder's 14-bit domain. */
const CLIP = 8159;

/**
 * Upper bound of each μ-law segment, in the encoder's 14-bit domain — the
 * G.711 table, which is `2 ** (segment + 6) - 1`. Decimal because the hex
 * spelling the standard uses trips the numeric-separator lint, and
 * `0x1_ff` is not the standard's spelling either.
 */
const SEGMENT_ENDS = [63, 127, 255, 511, 1023, 2047, 4095, 8191] as const;

/** Sample rate every phone carrier streams at. */
export const TELEPHONY_SAMPLE_RATE = 8000;

/** Decode one μ-law byte to a signed 16-bit sample. */
function decodeSample(byte: number): number {
  // The encoding is stored inverted (so silence is 0xFF on the wire and a
  // dropped line reads as loud noise rather than as valid quiet audio).
  const value = ~byte & 0xff;
  const magnitude = (((value & 0x0f) << 3) + BIAS) << ((value & 0x70) >> 4);
  return (value & 0x80) !== 0 ? BIAS - magnitude : magnitude - BIAS;
}

/** All 256 μ-law byte values decoded once, indexed by the byte itself. */
const DECODE_TABLE: Int16Array = (() => {
  const table = new Int16Array(256);
  for (let byte = 0; byte < 256; byte++) table[byte] = decodeSample(byte);
  return table;
})();

/**
 * Which μ-law segment a 14-bit magnitude falls in.
 *
 * Linear rather than binary search: eight entries, and the low segments —
 * where speech spends most of its samples — are the ones found first.
 */
function segmentOf(magnitude: number): number {
  for (let segment = 0; segment < SEGMENT_ENDS.length; segment++) {
    const end = SEGMENT_ENDS[segment];
    if (end !== undefined && magnitude <= end) return segment;
  }
  return SEGMENT_ENDS.length;
}

/** Encode one signed 16-bit sample to a μ-law byte. */
function encodeSample(sample: number): number {
  // μ-law's domain is 14-bit; the low two bits of a PCM16 sample are below
  // its resolution everywhere and are discarded before the segment search.
  let value = sample >> 2;
  // The sign is carried as an XOR mask so the inversion above costs nothing.
  let mask: number;
  if (value < 0) {
    value = -value;
    mask = 0x7f;
  } else {
    mask = 0xff;
  }
  if (value > CLIP) value = CLIP;
  value += BIAS >> 2;
  const segment = segmentOf(value);
  // Past the last segment the magnitude is already clipped, so this is the
  // saturated code rather than a computed one.
  if (segment >= SEGMENT_ENDS.length) return 0x7f ^ mask;
  return (((segment << 4) | ((value >> (segment + 1)) & 0x0f)) ^ mask) & 0xff;
}

/** Decode a μ-law byte stream to PCM16 samples. */
export function mulawToPcm16(mulaw: Uint8Array): Int16Array {
  const pcm = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    // Indexed by a `& 0xff` byte, so the entry always exists;
    // `noUncheckedIndexedAccess` cannot see that.
    pcm[i] = DECODE_TABLE[mulaw[i] as number] as number;
  }
  return pcm;
}

/** Encode PCM16 samples to a μ-law byte stream. */
export function pcm16ToMulaw(pcm: Int16Array): Uint8Array {
  const mulaw = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    mulaw[i] = encodeSample(pcm[i] as number);
  }
  return mulaw;
}
