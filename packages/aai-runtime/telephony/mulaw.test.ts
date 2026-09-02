// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { mulawToPcm16, pcm16ToMulaw, TELEPHONY_SAMPLE_RATE } from "./mulaw.ts";

/**
 * The eight μ-law segment boundaries as decoded values, taken from the
 * G.711 table rather than from this module — a round-trip test alone would
 * pass against a self-consistent but wrong curve.
 */
const KNOWN_DECODES: readonly (readonly [number, number])[] = [
  [0xff, 0], // +0 — μ-law is stored inverted, so silence is 0xFF on the wire
  [0x7f, 0], // -0 (μ-law has both zeros; both decode to 0 in PCM16)
  [0xfe, 8],
  [0x00, -32_124], // most negative
  [0x80, 32_124], // most positive
];

describe("mulaw", () => {
  test("carrier sample rate is 8 kHz", () => {
    expect(TELEPHONY_SAMPLE_RATE).toBe(8000);
  });

  test.each(KNOWN_DECODES)("decodes 0x%s to the G.711 value", (byte, expected) => {
    expect(mulawToPcm16(Uint8Array.of(byte))[0]).toBe(expected);
  });

  test("silence encodes to 0xFF, the inverted-zero code", () => {
    expect(pcm16ToMulaw(Int16Array.of(0))[0]).toBe(0xff);
  });

  test("every one of the 256 codes survives decode → encode", () => {
    // The exact-inverse direction: each μ-law byte decodes to a value that is
    // by construction representable, so re-encoding must return the same
    // byte. A single mismatch means the segment search and the segment table
    // disagree, which no round-trip on arbitrary PCM would localize.
    const codes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const reencoded = pcm16ToMulaw(mulawToPcm16(codes));
    // -0 (0x7F) and +0 (0xFF) both decode to 0, so the encoder maps both to
    // the positive code. Every other byte is an exact fixed point.
    expect([...reencoded].filter((byte, i) => byte !== i)).toEqual([0xff]);
  });

  test("clips beyond the representable range instead of wrapping", () => {
    const loud = Int16Array.of(32_767, -32_768);
    const decoded = mulawToPcm16(pcm16ToMulaw(loud));
    expect(decoded[0]).toBe(32_124);
    expect(decoded[1]).toBe(-32_124);
  });

  /**
   * μ-law's error bound is HYBRID, and both halves are measured over the full
   * Int16 domain (`mulawToPcm16(pcm16ToMulaw(x))` for all 65,536 values):
   *
   * | | value | attained at |
   * | --- | --- | --- |
   * | absolute floor | 7 | x = -1 -> -8, and x = -73 -> -80 |
   * | relative slope | 11/121 ~ 9.09% | x = -121 -> -132 |
   *
   * A purely RELATIVE bound cannot exist: the worst relative error over the
   * domain is **7.0**, at x = -1, and the worst absolute error is **644**, at
   * x = -32768 (which clips to -32124). Both are correct — μ-law is a
   * COMPANDING codec, so its step size grows with amplitude and a sample
   * quieter than one step is quantized to the step. The floor is what covers
   * the samples too quiet for a proportional bound to say anything about.
   */
  const MAX_ABSOLUTE_ERROR = 7;
  const MAX_RELATIVE_ERROR = 11 / 121;

  /** Every Int16 value, ascending — the domain both properties below run over. */
  function everyInt16(): Int16Array {
    const all = new Int16Array(65_536);
    for (let i = 0; i < 65_536; i++) all[i] = i - 32_768;
    return all;
  }

  /** `x` values whose round trip exceeds `max(floor, slope * |x|)`. */
  function overBound(floor: number, slope: number): number[] {
    const all = everyInt16();
    const decoded = mulawToPcm16(pcm16ToMulaw(all));
    const bad: number[] = [];
    for (let i = 0; i < all.length; i++) {
      const original = all[i] as number;
      const error = Math.abs((decoded[i] as number) - original);
      if (error > Math.max(floor, slope * Math.abs(original))) bad.push(original);
    }
    return bad;
  }

  test("round-trip error stays inside the hybrid bound for every Int16 sample", () => {
    // This replaced `worst < 0.07` over a single full-scale 440 Hz sine. That
    // assertion was false by two orders of magnitude and passed only because
    // its sample grid never lands in 1..114: the smallest nonzero sample of a
    // 30000-amplitude sine at 8 kHz is 942, so the quiet half of the codec's
    // own curve was never evaluated. A generated amplitude reddens it on the
    // first draw — see the table below.
    expect(overBound(MAX_ABSOLUTE_ERROR, MAX_RELATIVE_ERROR)).toEqual([]);
  });

  test("both constants are TIGHT — neither can be lowered", () => {
    // Without this the bound could go quietly loose, which is how the old
    // assertion's replacement would repeat its mistake in the other direction.
    expect(overBound(MAX_ABSOLUTE_ERROR - 1, MAX_RELATIVE_ERROR)).toContain(-73);
    expect(overBound(MAX_ABSOLUTE_ERROR, MAX_RELATIVE_ERROR * 0.999)).toContain(-121);
  });

  /**
   * The worst relative error of a 440 Hz sine, by amplitude — the measurement
   * that shows the old assertion was held up by amplitude alone. Each is
   * inside the hybrid bound above; none but the first is inside 0.07.
   */
  const SINE_WORST_RELATIVE: readonly (readonly [number, number])[] = [
    [30_000, 0.0231],
    [3000, 0.0426],
    [300, 0.7778],
    [100, 1.6667],
    [30, 7],
  ];

  test.each(SINE_WORST_RELATIVE)(
    "a 440 Hz sine at amplitude %i has worst relative error %f",
    (amplitude, expected) => {
      const samples = Int16Array.from({ length: 800 }, (_, i) =>
        Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / TELEPHONY_SAMPLE_RATE)),
      );
      const decoded = mulawToPcm16(pcm16ToMulaw(samples));
      let worst = 0;
      for (let i = 0; i < samples.length; i++) {
        const original = samples[i] as number;
        const error = Math.abs((decoded[i] as number) - original);
        worst = Math.max(worst, error / Math.max(Math.abs(original), 1));
      }
      expect(worst).toBeCloseTo(expected, 3);
    },
  );

  test("decode ∘ encode is MONOTONE across all 65,536 samples", () => {
    // The property that actually protects the implementation, and the one the
    // exhaustive 256-code fixed-point test above cannot see. A/B: shifting
    // `SEGMENT_ENDS` by one (`[64, 128, …]`, i.e. `2 ** (segment + 6)` instead
    // of `- 1`) leaves that test passing with the identical single mismatch
    // (`[0xff]`) while this one reports 16 inversions and the hybrid bound
    // blows out to a relative 1.0. A louder sample must never decode quieter.
    const all = everyInt16();
    const decoded = mulawToPcm16(pcm16ToMulaw(all));
    const inversions: number[] = [];
    for (let i = 1; i < all.length; i++) {
      if ((decoded[i] as number) < (decoded[i - 1] as number)) inversions.push(all[i] as number);
    }
    expect(inversions).toEqual([]);
  });

  test("preserves length in both directions", () => {
    const pcm = Int16Array.from({ length: 160 }, (_, i) => i * 37);
    expect(pcm16ToMulaw(pcm)).toHaveLength(160);
    expect(mulawToPcm16(pcm16ToMulaw(pcm))).toHaveLength(160);
  });

  test("handles empty input", () => {
    expect(pcm16ToMulaw(new Int16Array(0))).toHaveLength(0);
    expect(mulawToPcm16(new Uint8Array(0))).toHaveLength(0);
  });
});
