// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  createInputLevelLedger,
  LEVEL_FLOOR_DBFS,
  LEVEL_LEDGER_MS,
  rmsDbfs,
} from "./_input-level-ledger.ts";

const RATE = 16_000;
/** `ms` of a constant-magnitude square wave, whose RMS is exactly `amplitude`. */
function tone(amplitude: number, ms: number): Int16Array {
  const out = new Int16Array((RATE * ms) / 1000);
  for (let i = 0; i < out.length; i++) out[i] = i % 2 === 0 ? amplitude : -amplitude;
  return out;
}
const dbfs = (rms: number): number => 20 * Math.log10(rms / 32_768);

describe("rmsDbfs", () => {
  test("is RMS against int16 full scale, clamped at the floor", () => {
    expect(rmsDbfs(32_768 ** 2 * 10, 10)).toBeCloseTo(0, 6);
    expect(rmsDbfs(658 ** 2 * 4, 4)).toBeCloseTo(-33.94, 2);
    expect(rmsDbfs(5268 ** 2 * 4, 4)).toBeCloseTo(-15.88, 2);
    expect(rmsDbfs(0, 800)).toBe(LEVEL_FLOOR_DBFS);
    expect(rmsDbfs(1, 0)).toBe(LEVEL_FLOOR_DBFS);
  });
});

describe("createInputLevelLedger", () => {
  test("indexes levels on the samples sent, so a word span finds the audio under it", () => {
    const ledger = createInputLevelLedger(RATE);
    ledger.record(tone(600, 1000)); // 0-1000 ms: quiet background
    ledger.record(tone(6000, 500)); // 1000-1500 ms: the caller
    ledger.record(tone(600, 1000)); // 1500-2500 ms: quiet again

    expect(ledger.peakDbfs(1100, 1400)).toBeCloseTo(dbfs(6000), 6);
    expect(ledger.peakDbfs(200, 700)).toBeCloseTo(dbfs(600), 6);
    // The 100 ms pad reaches the loud block from a span that ends 80 ms short.
    expect(ledger.peakDbfs(500, 920)).toBeCloseTo(dbfs(6000), 6);
    expect(ledger.peakDbfs(1700, 2300)).toBeCloseTo(dbfs(600), 6);
  });

  test("a block spans a fixed number of samples however the frames were cut", () => {
    const whole = createInputLevelLedger(RATE);
    const cut = createInputLevelLedger(RATE);
    const audio = new Int16Array([...tone(300, 500), ...tone(9000, 30), ...tone(300, 470)]);
    whole.record(audio);
    // 20 ms frames, the way a telephony client sends them.
    for (let i = 0; i < audio.length; i += 320) cut.record(audio.subarray(i, i + 320));
    for (const [start, end] of [
      [0, 1000],
      [450, 560],
      [700, 900],
    ] as const) {
      expect(cut.peakDbfs(start, end)).toBe(whole.peakDbfs(start, end));
    }
  });

  test("a span it has no completed audio for has no level, rather than a quiet one", () => {
    const ledger = createInputLevelLedger(RATE);
    expect(ledger.peakDbfs(0, 500)).toBeUndefined();
    ledger.record(tone(4000, 1000));
    expect(ledger.peakDbfs(5000, 6000)).toBeUndefined();
    expect(ledger.peakDbfs(Number.NaN, 100)).toBeUndefined();
    expect(ledger.peakDbfs(600, 500)).toBeUndefined();
  });

  test("keeps only the last LEVEL_LEDGER_MS of history", () => {
    const ledger = createInputLevelLedger(RATE);
    ledger.record(tone(8000, 1000));
    ledger.record(tone(500, LEVEL_LEDGER_MS));
    // The loud second has been overwritten; a span over it only sees what is left.
    expect(ledger.peakDbfs(0, 800)).toBeUndefined();
    expect(ledger.peakDbfs(0, 5000)).toBeCloseTo(dbfs(500), 6);
  });

  test("a new ledger starts its axis at zero, as a reconnected socket's clock does", () => {
    const first = createInputLevelLedger(RATE);
    first.record(tone(7000, 2000));
    const second = createInputLevelLedger(RATE);
    second.record(tone(400, 2000));
    expect(first.peakDbfs(500, 1500)).toBeCloseTo(dbfs(7000), 6);
    expect(second.peakDbfs(500, 1500)).toBeCloseTo(dbfs(400), 6);
  });
});
