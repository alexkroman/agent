// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { HEARD_AUDIO_LAG_MS, PIPELINE_PLAYBACK_GRACE_MS } from "./playback-timing-constants.ts";

describe("playback timing", () => {
  test("both are positive millisecond budgets", () => {
    expect(PIPELINE_PLAYBACK_GRACE_MS).toBeGreaterThan(0);
    expect(HEARD_AUDIO_LAG_MS).toBeGreaterThan(0);
  });

  test("the heard-audio lag is a correction inside the playback grace, not beyond it", () => {
    expect(HEARD_AUDIO_LAG_MS).toBeLessThan(PIPELINE_PLAYBACK_GRACE_MS);
  });
});
