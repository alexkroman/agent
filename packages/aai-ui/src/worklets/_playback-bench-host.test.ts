// Copyright 2026 the AAI authors. MIT license.
/**
 * `playoutVsHost` — where the host BELIEVES playback ends, against where the
 * ear actually stopped hearing it.
 *
 * Built from hand-made schedules and renders so each of the three end times
 * can be worked out in the spec: the open-loop model (every chunk plays on
 * arrival at 1.0x), the same model clamped up by the worklet's backlog
 * reports, and the ground truth from the render.
 */

import { describe, expect, test } from "vitest";
import type { Delivery, RenderResult } from "./_playback-bench-harness.ts";
import { playoutVsHost } from "./_playback-bench-host.ts";

const RATE = 24_000;

/** `ms` of 16-bit mono audio at {@link RATE}, sent at `atMs`. */
const chunk = (atMs: number, ms: number): Delivery => ({
  atMs,
  bytes: new Uint8Array(((RATE * ms) / 1000) * 2),
});

/** A render with only the fields the comparison reads. */
function render(firstMs: number, playedMs: number, progressMs: number[] = []): RenderResult {
  return {
    rendered: new Float32Array(0),
    sampleRate: RATE,
    timeToFirstAudioMs: firstMs,
    stats: {
      concealedSamples: 0,
      silentConcealedSamples: 0,
      concealmentEvents: 0,
      silentConcealmentEvents: 0,
    },
    gapsMs: [],
    progressMs,
    earMs: [],
    playedMs,
  };
}

describe("playoutVsHost", () => {
  test("the open-loop end chains the chunks from whenever each arrived", () => {
    // 100 ms at 0, then 100 ms at 50 (still playing the first): ends at 200.
    // Then 100 ms at 500, after a gap: ends at 600.
    const result = playoutVsHost({
      forwarded: [chunk(0, 100), chunk(50, 100), chunk(500, 100)],
      render: render(0, 600),
      sampleRate: RATE,
      reportIntervalMs: 50,
    });
    expect(result.openLoopEndMs).toBeCloseTo(600);
  });

  test("an ear that stopped later than the host thinks is the grace barge-in needs", () => {
    const result = playoutVsHost({
      forwarded: [chunk(0, 200)],
      // The buffer filled first: sound started at 150 and ran 200 ms.
      render: render(150, 200),
      sampleRate: RATE,
      reportIntervalMs: 50,
    });
    expect(result.realEndMs).toBe(350);
    expect(result.requiredGraceMs).toBeCloseTo(150);
  });

  test("backlog reports only ever move the host's end LATER, and shrink the grace", () => {
    const result = playoutVsHost({
      forwarded: [chunk(0, 200)],
      render: render(150, 200, [200, 150, 100]),
      sampleRate: RATE,
      reportIntervalMs: 50,
    });
    // Reports at 150, 200, 250 ms carrying 200, 150, 100 ms of backlog.
    expect(result.reportedEndMs).toBe(350);
    expect(result.requiredGraceReportingMs).toBe(0);
    expect(result.reportedEndMs).toBeGreaterThanOrEqual(result.openLoopEndMs);
  });

  test("an ear that finished early needs no grace at all", () => {
    const result = playoutVsHost({
      forwarded: [chunk(0, 200)],
      render: render(0, 100),
      sampleRate: RATE,
      reportIntervalMs: 50,
    });
    expect(result.requiredGraceMs).toBe(0);
  });
});
