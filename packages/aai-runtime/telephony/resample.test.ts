// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createResampler } from "./resample.ts";

function sine(frequency: number, rate: number, samples: number, amplitude = 20_000): Int16Array {
  return Int16Array.from({ length: samples }, (_, i) =>
    Math.round(amplitude * Math.sin((2 * Math.PI * frequency * i) / rate)),
  );
}

/**
 * Amplitude of one frequency component, via a single DFT bin.
 *
 * Every call site picks a length that makes the frequency an exact bin, so
 * no window is needed and a clean tone reads as its true amplitude.
 */
function toneAmplitude(samples: Int16Array, frequency: number, rate: number): number {
  let real = 0;
  let imaginary = 0;
  for (let i = 0; i < samples.length; i++) {
    const angle = (2 * Math.PI * frequency * i) / rate;
    real += (samples[i] as number) * Math.cos(angle);
    imaginary -= (samples[i] as number) * Math.sin(angle);
  }
  return (2 * Math.hypot(real, imaginary)) / samples.length;
}

describe("createResampler", () => {
  test("passes through unchanged when the rates match", () => {
    const resampler = createResampler(8000, 8000);
    const input = sine(440, 8000, 160);
    expect(resampler.process(input)).toBe(input);
  });

  test("downsampling produces the expected number of samples", () => {
    const resampler = createResampler(24_000, 8000);
    // 480 input samples at 24 kHz is 20 ms — one carrier frame's worth of
    // audio, which is 160 samples at 8 kHz.
    expect(resampler.process(sine(440, 24_000, 480))).toHaveLength(160);
  });

  test("upsampling produces the expected number of samples", () => {
    const resampler = createResampler(8000, 16_000);
    expect(resampler.process(sine(440, 8000, 160))).toHaveLength(320);
  });

  test("holds the rate over many chunks rather than drifting", () => {
    // A per-chunk phase reset shows up as a slow accumulation of extra or
    // missing samples, which sounds like a gradually rising pitch.
    const resampler = createResampler(24_000, 8000);
    let produced = 0;
    for (let chunk = 0; chunk < 200; chunk++) {
      produced += resampler.process(sine(440, 24_000, 481)).length;
    }
    // 200 chunks of 481 input samples at 3:1 is 32066.67 output samples.
    expect(produced).toBeGreaterThanOrEqual(32_066);
    expect(produced).toBeLessThanOrEqual(32_067);
  });

  test("preserves a speech-band tone through a downsample", () => {
    const resampler = createResampler(24_000, 8000);
    const output = resampler.process(sine(1000, 24_000, 2400));
    // Skip the filter's startup ramp; 63 taps at 24 kHz is 21 output samples.
    const steady = output.subarray(100);
    expect(toneAmplitude(steady, 1000, 8000)).toBeGreaterThan(18_000);
  });

  test("rejects a tone above the output Nyquist instead of folding it in", () => {
    // THE anti-aliasing test. 6 kHz sampled at 24 kHz has nowhere to go in an
    // 8 kHz stream: naive decimation folds it to |6000 - 8000| = 2000 Hz at
    // nearly full amplitude, landing a loud whistle in the middle of the
    // speech band. The filter must leave essentially nothing there.
    const resampler = createResampler(24_000, 8000);
    const output = resampler.process(sine(6000, 24_000, 2400));
    const steady = output.subarray(100);
    expect(toneAmplitude(steady, 2000, 8000)).toBeLessThan(200); // < -40 dB
  });

  test("chunked conversion is identical to converting the whole stream", () => {
    // The property that fails the moment a converter is rebuilt per chunk —
    // and the failure is a click at every chunk boundary, not a wrong length.
    const input = sine(700, 24_000, 2400);
    const whole = createResampler(24_000, 8000).process(input);

    const chunked = createResampler(24_000, 8000);
    const pieces: number[] = [];
    for (let offset = 0; offset < input.length; offset += 173) {
      pieces.push(...chunked.process(input.subarray(offset, offset + 173)));
    }
    expect(pieces).toEqual([...whole]);
  });

  test("survives an empty chunk without losing its place", () => {
    const resampler = createResampler(24_000, 8000);
    const first = resampler.process(sine(440, 24_000, 480));
    expect(resampler.process(new Int16Array(0))).toHaveLength(0);
    const second = resampler.process(sine(440, 24_000, 480));
    expect(first).toHaveLength(160);
    expect(second).toHaveLength(160);
  });

  test("the fused decimator reproduces filter-then-interpolate sample for sample", () => {
    // These numbers were produced by the implementation this one replaced — a
    // 63-tap FIR run over every input sample, then a linear interpolator that
    // stepped over two outputs in three. The one-pass decimator evaluates the
    // filter only where an output reads it, which is a rearrangement of the
    // same arithmetic rather than a new filter, so the samples must be
    // IDENTICAL and not merely close. Two chunks, because the second one is
    // what proves the carried history and phase agree too.
    const resampler = createResampler(24_000, 8000);
    const chunk = (phase: number): Int16Array =>
      Int16Array.from({ length: 24 }, (_, i) =>
        Math.round(
          12_000 * Math.sin((2 * Math.PI * 440 * (i + phase)) / 24_000) +
            7000 * Math.sin((2 * Math.PI * 5200 * (i + phase)) / 24_000),
        ),
      );
    expect([...resampler.process(chunk(0))]).toEqual([0, -4, 2, -2, 15, -41, 92, -155]);
    expect([...resampler.process(chunk(24))]).toEqual([
      243, -350, 482, 2708, 4881, 8846, 10_893, 11_972,
    ]);
  });

  test("a non-integer ratio still decimates, with the fractional phase kept", () => {
    // 22.05 kHz is not a rate this bridge negotiates today, but the phase is
    // fractional there and that is the branch where the right-hand neighbour
    // carries real weight — the one the integer path never evaluates.
    const resampler = createResampler(22_050, 8000);
    const output = resampler.process(sine(1000, 22_050, 2205));
    const steady = output.subarray(100);
    expect(toneAmplitude(steady, 1000, 8000)).toBeGreaterThan(18_000);
  });

  test("does not overflow PCM16 on a full-scale input", () => {
    // The windowed sinc overshoots on transients, so the interpolator's clamp
    // is what stops a loud passage from wrapping to the opposite polarity.
    const resampler = createResampler(24_000, 8000);
    const square = Int16Array.from({ length: 2400 }, (_, i) =>
      Math.floor(i / 12) % 2 === 0 ? 32_767 : -32_768,
    );
    for (const sample of resampler.process(square)) {
      expect(sample).toBeGreaterThanOrEqual(-32_768);
      expect(sample).toBeLessThanOrEqual(32_767);
    }
  });
});
