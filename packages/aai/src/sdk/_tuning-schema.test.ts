// Copyright 2026 the AAI authors. MIT license.
/**
 * The wire schemas of the three `PipelineTuning` groups. Each is STRICT, so a
 * flat knob spelled inside the wrong group is refused rather than dropped, and
 * each carries the cross-field rule its authoring type carries.
 */

import { describe, expect, test } from "vitest";
import { InterruptionSchema, SilenceSchema, TurnTakingSchema } from "./_tuning-schema.ts";
import { MAX_INTERRUPTION_BACKOFF_MS } from "./speak-gate-constants.ts";

describe("TurnTakingSchema", () => {
  test("accepts the group and keeps detection an open string", () => {
    expect(
      TurnTakingSchema.parse({ detection: "a-later-mode", userTurnLimit: { maxWords: 60 } }),
    ).toEqual({ detection: "a-later-mode", userTurnLimit: { maxWords: 60 } });
  });

  test("refuses an empty userTurnLimit, which caps nothing", () => {
    expect(TurnTakingSchema.safeParse({ userTurnLimit: {} }).success).toBe(false);
  });

  test("is strict: a knob from another group is refused, not dropped", () => {
    expect(TurnTakingSchema.safeParse({ minWords: 2 }).success).toBe(false);
  });
});

describe("InterruptionSchema", () => {
  test('"off" or the object, nothing else', () => {
    expect(InterruptionSchema.parse("off")).toBe("off");
    expect(InterruptionSchema.parse({ minWords: 2, backoffMs: 0 })).toEqual({
      minWords: 2,
      backoffMs: 0,
    });
    expect(InterruptionSchema.safeParse("default").success).toBe(false);
  });

  test("bounds the backoff and refuses a zero word threshold", () => {
    expect(
      InterruptionSchema.safeParse({ backoffMs: MAX_INTERRUPTION_BACKOFF_MS + 1 }).success,
    ).toBe(false);
    expect(InterruptionSchema.safeParse({ minWords: 0 }).success).toBe(false);
  });
});

describe("SilenceSchema", () => {
  test("a nudge needs its afterMs; the prompt is optional", () => {
    expect(SilenceSchema.parse({ nudge: { afterMs: 8000 } })).toEqual({ nudge: { afterMs: 8000 } });
    expect(SilenceSchema.safeParse({ nudge: { prompt: "Still there?" } }).success).toBe(false);
  });

  test("is strict", () => {
    expect(SilenceSchema.safeParse({ silenceTimeoutMs: 8000 }).success).toBe(false);
  });
});
