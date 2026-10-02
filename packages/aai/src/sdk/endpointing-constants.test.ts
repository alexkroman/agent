// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  DEFAULT_MAX_TURN_SILENCE_MS as FROM_CONSTANTS_MAX,
  DEFAULT_MIN_TURN_SILENCE_MS as FROM_CONSTANTS_MIN,
} from "./constants.ts";
import {
  DEFAULT_MAX_TURN_SILENCE_MS,
  DEFAULT_MIN_TURN_SILENCE_MS,
} from "./endpointing-constants.ts";
import { DEFAULT_SPEECH_IDLE_TIMEOUT_MS } from "./pipeline-tuning-constants.ts";

describe("the AssemblyAI turn-silence pair", () => {
  test("the end-of-turn CHECK runs before the hard ceiling", () => {
    expect(DEFAULT_MIN_TURN_SILENCE_MS).toBeLessThan(DEFAULT_MAX_TURN_SILENCE_MS);
  });

  test("the speech-idle edge clears the ceiling, so a real final is never cut off", () => {
    expect(DEFAULT_SPEECH_IDLE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_MAX_TURN_SILENCE_MS);
  });

  test("`constants.ts` re-exports the same pair", () => {
    expect(FROM_CONSTANTS_MIN).toBe(DEFAULT_MIN_TURN_SILENCE_MS);
    expect(FROM_CONSTANTS_MAX).toBe(DEFAULT_MAX_TURN_SILENCE_MS);
  });
});
