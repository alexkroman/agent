// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  createSttLivenessWatch,
  STT_DEAF_VOICED_MS,
  STT_REPLAY_MS,
  STT_STUCK_MARGIN_MS,
} from "./_stt-liveness.ts";

const SR = 16_000;
/** `ms` of a constant-amplitude square wave: RMS = `amp` / 32768. */
function frame(ms: number, amp: number): Int16Array {
  const out = new Int16Array((SR * ms) / 1000);
  for (let i = 0; i < out.length; i++) out[i] = i % 2 === 0 ? amp : -amp;
  return out;
}
const NOISE = 330; // ≈ -40 dBFS, the tau2 line's background
const SPEECH = 6000; // ≈ -15 dBFS

/** Feed `ms` of 100 ms frames; true if any frame asked for a reopen. */
function feed(watch: ReturnType<typeof createSttLivenessWatch>, ms: number, amp: number): boolean {
  let fired = false;
  for (let t = 0; t < ms; t += 100) fired = watch.observe(frame(100, amp)) || fired;
  return fired;
}

describe("STT liveness watch", () => {
  test("voiced audio with no turn event asks for a reopen once it reaches the deaf window", () => {
    const watch = createSttLivenessWatch(SR, { maxTurnSilenceMs: 3500 });
    expect(feed(watch, 2000, NOISE)).toBe(false);
    expect(feed(watch, STT_DEAF_VOICED_MS - 100, SPEECH)).toBe(false);
    expect(feed(watch, 100, SPEECH)).toBe(true);
  });

  test("any turn event resets the count, and so does a reopen", () => {
    const watch = createSttLivenessWatch(SR, { maxTurnSilenceMs: 3500 });
    feed(watch, 1000, NOISE);
    feed(watch, 2000, SPEECH);
    watch.heard(true);
    expect(feed(watch, 2000, SPEECH)).toBe(false);
    expect(feed(watch, 500, SPEECH)).toBe(true);
    watch.reopened();
    expect(feed(watch, 2000, SPEECH)).toBe(false);
  });

  test("a turn a partial opened and nothing ended is a stuck socket, even in silence", () => {
    const watch = createSttLivenessWatch(SR, { maxTurnSilenceMs: 3500 });
    feed(watch, 1000, NOISE);
    feed(watch, 1000, SPEECH);
    watch.heard(false);
    expect(feed(watch, 3500 + STT_STUCK_MARGIN_MS - 100, NOISE)).toBe(false);
    expect(feed(watch, 100, NOISE)).toBe(true);
  });

  test("after a final, silence is just silence", () => {
    const watch = createSttLivenessWatch(SR, { maxTurnSilenceMs: 3500 });
    feed(watch, 1000, SPEECH);
    watch.heard(false);
    watch.heard(true);
    expect(feed(watch, 60_000, NOISE)).toBe(false);
  });

  test("the line's own noise never counts, however long it runs", () => {
    const watch = createSttLivenessWatch(SR, { maxTurnSilenceMs: 3500 });
    expect(feed(watch, 60_000, NOISE)).toBe(false);
  });

  test("room tone after digital silence is not speech: it must also clear an absolute floor", () => {
    // A line opening on zeros puts the floor at -100 dBFS; -55 dBFS hiss is
    // 45 dB above it, yet nobody is talking.
    const watch = createSttLivenessWatch(SR, { maxTurnSilenceMs: 3500 });
    feed(watch, 1000, 0);
    expect(feed(watch, 10_000, 58)).toBe(false);
  });

  test("keeps only the last replay window of audio, oldest first", () => {
    const watch = createSttLivenessWatch(SR, { maxTurnSilenceMs: 3500 });
    for (let i = 0; i < 50; i++) watch.observe(frame(100, 100 + i));
    const recent = watch.recent();
    const ms = recent.reduce((n, f) => n + (f.length * 1000) / SR, 0);
    expect(ms).toBeGreaterThanOrEqual(STT_REPLAY_MS);
    expect(ms).toBeLessThan(STT_REPLAY_MS + 100);
    expect(recent.at(-1)?.[0]).toBe(149);
  });
});
