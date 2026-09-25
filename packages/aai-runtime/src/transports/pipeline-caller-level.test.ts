// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  CALLER_LEVEL_VETO_DB,
  CALLER_LEVEL_WINDOW,
  createCallerLevel,
} from "./pipeline-caller-level.ts";

/** Commit `peaks` as caller turns, each read against the reference at the time. */
function commit(level: ReturnType<typeof createCallerLevel>, ...peaks: number[]): void {
  for (const peak of peaks) level.onCommitted(level.read(peak));
}

describe("createCallerLevel", () => {
  test("fails open until two utterances have committed", () => {
    const level = createCallerLevel();
    expect(level.read(-60)).toEqual({ peakDb: -60, quiet: false });
    commit(level, -16);
    expect(level.read(-60)).toEqual({ peakDb: -60, quiet: false });
    commit(level, -16);
    expect(level.read(-60)).toEqual({ peakDb: -60, refDb: -16, quiet: true });
  });

  test("fails open without a peak, whatever the reference", () => {
    const level = createCallerLevel();
    commit(level, -16, -15);
    expect(level.read(undefined)).toEqual({ refDb: -15.5, quiet: false });
    expect(level.read(Number.NaN).quiet).toBe(false);
  });

  test(`quiet is strictly more than ${CALLER_LEVEL_VETO_DB} dB below the reference`, () => {
    const level = createCallerLevel();
    commit(level, -16, -16);
    expect(level.read(-16 - CALLER_LEVEL_VETO_DB).quiet).toBe(false);
    expect(level.read(-16 - CALLER_LEVEL_VETO_DB - 0.01).quiet).toBe(true);
    // The measured shapes: background audio at about -34 dBFS is quiet, a soft
    // backchannel at about -25 dBFS is not.
    expect(level.read(-33.9).quiet).toBe(true);
    expect(level.read(-24.6).quiet).toBe(false);
  });

  test("quiet utterances never move the reference", () => {
    const level = createCallerLevel();
    commit(level, -16, -16);
    commit(level, -40, -40, -40, -40, -40, -40, -40, -40, -40);
    expect(level.read(-35)).toEqual({ peakDb: -35, refDb: -16, quiet: true });
  });

  test(`the reference is the median of the last ${CALLER_LEVEL_WINDOW} committed peaks`, () => {
    const level = createCallerLevel();
    commit(level, -18, -14, -2);
    // One shout does not drag the reference up: median of -18, -14, -2.
    expect(level.read(-20).refDb).toBe(-14);
    commit(level, -10, -10, -10, -10, -10, -10, -10);
    // -18 and -14 have aged out of the window; seven -10s and the -2 remain.
    expect(level.read(-20).refDb).toBe(-10);
  });
});
