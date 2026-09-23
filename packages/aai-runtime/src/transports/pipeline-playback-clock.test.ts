// Copyright 2026 the AAI authors. MIT license.
// Unit specs for the session-scoped playback clock. What the heard cursor
// builds on top of it is pinned in pipeline-heard.test.ts.

import { PIPELINE_PLAYBACK_GRACE_MS } from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import { createTestClock } from "../_pipeline-test-fakes.ts";
import { createPlaybackClock } from "./pipeline-playback-clock.ts";

const RATE = 24_000;
/** One PCM16 chunk of `ms` at {@link RATE}. */
const chunk = (ms: number): Int16Array => new Int16Array((RATE * ms) / 1000);

function setup() {
  const time = createTestClock();
  return { clock: createPlaybackClock(RATE, time.now), time };
}

describe("createPlaybackClock", () => {
  test("chunks queue behind one another from wherever the last one ends", () => {
    const { clock, time } = setup();
    clock.onChunk(chunk(1000));
    clock.onChunk(chunk(500));
    expect(clock.remainingMs()).toBe(1500);
    time.advance(600);
    expect(clock.remainingMs()).toBe(900);
  });

  test("a chunk after the queue drained starts from now, not from the old end", () => {
    const { clock, time } = setup();
    clock.onChunk(chunk(200));
    time.advance(1000);
    clock.onChunk(chunk(300));
    expect(clock.remainingMs()).toBe(300);
  });

  test("pending() is graced past the end; remainingMs() is not", () => {
    const { clock, time } = setup();
    clock.onChunk(chunk(400));
    time.advance(400);
    expect(clock.remainingMs()).toBe(0);
    expect(clock.pending()).toBe(true);
    expect(clock.playoutMs()).toBe(PIPELINE_PLAYBACK_GRACE_MS);
    time.advance(PIPELINE_PLAYBACK_GRACE_MS);
    expect(clock.pending()).toBe(false);
  });

  test("a client report moves the end later, never earlier", () => {
    const { clock } = setup();
    clock.onChunk(chunk(1000));
    clock.onClientReport(200);
    expect(clock.remainingMs()).toBe(1000);
    clock.onClientReport(1800);
    expect(clock.remainingMs()).toBe(1800);
  });

  test("reset forgets everything queued", () => {
    const { clock } = setup();
    clock.onChunk(chunk(1000));
    clock.reset();
    expect(clock.remainingMs()).toBe(0);
    expect(clock.pending()).toBe(false);
    expect(clock.playoutMs()).toBe(0);
  });
});
