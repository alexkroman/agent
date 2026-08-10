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

  test("round-trips a full-scale sine within μ-law's quantization error", () => {
    // μ-law is ~8 bits logarithmic, so error scales with amplitude: the
    // guarantee worth asserting is RELATIVE, not a fixed LSB count.
    const samples = Int16Array.from({ length: 800 }, (_, i) =>
      Math.round(30_000 * Math.sin((2 * Math.PI * 440 * i) / TELEPHONY_SAMPLE_RATE)),
    );
    const decoded = mulawToPcm16(pcm16ToMulaw(samples));
    let worst = 0;
    for (let i = 0; i < samples.length; i++) {
      const original = samples[i] as number;
      const error = Math.abs((decoded[i] as number) - original);
      worst = Math.max(worst, error / Math.max(Math.abs(original), 1));
    }
    // μ-law's step size is ~6.25% of the sample value in the upper segments.
    expect(worst).toBeLessThan(0.07);
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
