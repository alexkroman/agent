// Copyright 2026 the AAI authors. MIT license.
/**
 * The chunk planner.
 *
 * Every property here is one the Sync API or the transcript depends on: a chunk
 * over the cap is REFUSED (`audio_too_long`), a gap between chunks is audio
 * nobody transcribes, and an overlap is a duplicated phrase in the output. They
 * are asserted as invariants over the whole plan rather than as expected arrays,
 * because the greedy walk's exact boundaries are an implementation detail and
 * the coverage is not.
 */
import { describe, expect, test } from "vitest";
import { fixedChunks, planChunks, type Span } from "./chunker.ts";

const RATE = 16_000;
const secs = (n: number): number => Math.round(n * RATE);
const MAX = secs(60);
const MIN_SILENCE = secs(0.3);

/** Speech from `a`s to `b`s. */
const speech = (a: number, b: number): Span => ({ start: secs(a), end: secs(b) });

/**
 * Every invariant the API and the transcript rest on, in one place.
 *
 * Returns the violations rather than asserting them, for two reasons: the
 * assertion then lives in the `test()` that owns it (biome's
 * `noMisplacedAssertion`), and a failure names the invariant that broke instead
 * of pointing at a shared line thirty tests use.
 */
function coverageViolations(spans: Span[], total: number, maxSamples: number): string[] {
  const bad: string[] = [];
  if (spans.length === 0) return ["planned no chunks at all"];
  if (spans[0]?.start !== 0) bad.push(`starts at ${spans[0]?.start}, not 0`);
  if (spans.at(-1)?.end !== total) bad.push(`ends at ${spans.at(-1)?.end}, not ${total}`);
  for (const [i, span] of spans.entries()) {
    // A zero-length chunk is an empty upload the API rejects as too short.
    if (span.end <= span.start) bad.push(`chunk ${i} is empty (${span.start}..${span.end})`);
    if (span.end - span.start > maxSamples) {
      bad.push(`chunk ${i} is ${span.end - span.start} samples, over the ${maxSamples} cap`);
    }
    // Contiguous: no dropped audio, no duplicated audio.
    const prevEnd = i > 0 ? spans[i - 1]?.end : undefined;
    if (prevEnd !== undefined && span.start !== prevEnd) {
      bad.push(`chunk ${i} starts at ${span.start}, but ${i - 1} ended at ${prevEnd}`);
    }
  }
  return bad;
}

describe("planChunks", () => {
  test("a recording under the cap is one chunk, whatever the speech looks like", () => {
    const total = secs(45);
    expect(planChunks(total, [speech(0, 10), speech(12, 44)], MAX, MIN_SILENCE)).toEqual([
      { start: 0, end: total },
    ]);
  });

  test("cuts in the MIDDLE of a silence, so both sides keep their quiet", () => {
    // One pause, 58s-59s, inside a 90s recording. The cut belongs at 58.5s —
    // giving the first chunk its trailing silence and the second its leading
    // silence, which is what the recognizer uses to place the edge words.
    const total = secs(90);
    const spans = planChunks(total, [speech(0, 58), speech(59, 90)], MAX, MIN_SILENCE);
    expect(spans).toEqual([
      { start: 0, end: secs(58.5) },
      { start: secs(58.5), end: total },
    ]);
    expect(coverageViolations(spans, total, MAX)).toEqual([]);
  });

  test("takes the LAST silence that fits, not the first", () => {
    // Pauses at 10s and 55s in a 90s recording. Cutting at the first would make
    // a 10-second chunk and leave 80 seconds still to split — a recording that
    // pauses often would become a chunk per pause, and every chunk is a request.
    const total = secs(90);
    const spans = planChunks(
      total,
      [speech(0, 10), speech(11, 55), speech(56, 90)],
      MAX,
      MIN_SILENCE,
    );
    expect(spans[0]?.end).toBe(secs(55.5));
    expect(coverageViolations(spans, total, MAX)).toEqual([]);
  });

  test("ignores a pause too short to be a boundary", () => {
    // 150 ms is an inter-word gap, not a sentence break; cutting there is the
    // mid-utterance split the whole mechanism exists to avoid. With no other
    // candidate the planner falls back to the cap.
    const total = secs(90);
    const spans = planChunks(total, [speech(0, 30), speech(30.15, 90)], MAX, MIN_SILENCE);
    expect(spans[0]?.end).toBe(MAX);
    expect(coverageViolations(spans, total, MAX)).toEqual([]);
  });

  test("force-splits a speaker who never pauses", () => {
    // The case that makes the cap non-negotiable rather than a nicety: an
    // unbroken four-minute passage has no silence to cut at, and a chunk over
    // the API's ceiling is refused outright.
    const total = secs(240);
    const spans = planChunks(total, [speech(0, 240)], MAX, MIN_SILENCE);
    expect(spans).toHaveLength(4);
    expect(coverageViolations(spans, total, MAX)).toEqual([]);
  });

  test("keeps every chunk legal across many pauses at awkward offsets", () => {
    // A long recording pausing every ~7s: the greedy walk has to keep choosing,
    // and the invariants are what matter rather than the exact boundaries.
    const total = secs(600);
    const spans: Span[] = [];
    for (let t = 0; t + 7 < 600; t += 7) spans.push(speech(t, t + 6.5));
    const plan = planChunks(total, spans, MAX, MIN_SILENCE);
    expect(coverageViolations(plan, total, MAX)).toEqual([]);
    // Every cut landed on a real silence rather than the cap.
    for (const span of plan.slice(0, -1)) expect(span.end % MAX).not.toBe(0);
  });

  test("a silence-only recording still splits, and covers", () => {
    const total = secs(200);
    expect(coverageViolations(planChunks(total, [], MAX, MIN_SILENCE), total, MAX)).toEqual([]);
  });

  test("an empty recording plans nothing", () => {
    expect(planChunks(0, [], MAX, MIN_SILENCE)).toEqual([]);
  });

  test("cuts already behind the cursor cannot stall the walk", () => {
    // Regression shape: a candidate at or before the cursor must be SKIPPED
    // rather than chosen, or the planner emits a zero-length span and loops on
    // the same cursor forever. Dense early pauses are what reach it.
    const total = secs(300);
    const dense = [speech(0, 1), speech(2, 3), speech(4, 5), speech(6, 299)];
    expect(coverageViolations(planChunks(total, dense, MAX, MIN_SILENCE), total, MAX)).toEqual([]);
  });
});

describe("fixedChunks", () => {
  test("is the no-VAD fallback: uniform windows that still cover", () => {
    const total = secs(200);
    const spans = fixedChunks(total, MAX);
    expect(spans).toHaveLength(4);
    expect(spans[0]).toEqual({ start: 0, end: MAX });
    expect(coverageViolations(spans, total, MAX)).toEqual([]);
  });
});
