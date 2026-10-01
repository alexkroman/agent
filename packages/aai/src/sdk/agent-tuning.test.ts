// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for the pipeline tuning vocabulary: the one runtime value it
 * declares (the list of turn-detection modes this release implements) and the
 * type shapes an author writes against.
 */

import { describe, expect, expectTypeOf, test } from "vitest";
import {
  KNOWN_TURN_DETECTION_MODES,
  type PipelineTuning,
  type SilenceNudge,
  type TurnDetectionMode,
  type TurnTakingTuning,
  type UserTurnLimit,
} from "./agent-tuning.ts";

describe("KNOWN_TURN_DETECTION_MODES", () => {
  test("names exactly the two modes the runtime implements, once each", () => {
    expect([...KNOWN_TURN_DETECTION_MODES]).toEqual(["auto", "manual"]);
    expect(new Set(KNOWN_TURN_DETECTION_MODES).size).toBe(KNOWN_TURN_DETECTION_MODES.length);
  });

  test("is exactly the known half written inline in TurnDetectionMode, so the two cannot drift", () => {
    expectTypeOf<
      (typeof KNOWN_TURN_DETECTION_MODES)[number] | (string & {})
    >().toEqualTypeOf<TurnDetectionMode>();
    expectTypeOf<(typeof KNOWN_TURN_DETECTION_MODES)[number]>().toEqualTypeOf<"auto" | "manual">();
  });
});

describe("TurnDetectionMode", () => {
  test("admits a mode a later release adds, as well as the known ones", () => {
    // Open on purpose: an unknown mode is a warning at config time, not a
    // compile error, so an agent written for a newer runtime still builds.
    expectTypeOf<"auto">().toExtend<TurnDetectionMode>();
    expectTypeOf<"semantic-v2">().toExtend<TurnDetectionMode>();
    expectTypeOf<number>().not.toExtend<TurnDetectionMode>();
  });
});

describe("PipelineTuning", () => {
  test("every group and every field is optional, so an empty object is a valid declaration", () => {
    const none: PipelineTuning = {};
    expect(Object.keys(none)).toEqual([]);
    expectTypeOf<Required<TurnTakingTuning>["detection"]>().toEqualTypeOf<TurnDetectionMode>();
    expectTypeOf<Required<TurnTakingTuning>["userTurnLimit"]>().toEqualTypeOf<UserTurnLimit>();
  });

  test("the nudge's timeout is REQUIRED inside its optional object", () => {
    // The dependency the old flat pair needed a run-time guard for.
    expectTypeOf<SilenceNudge["afterMs"]>().toEqualTypeOf<number>();
    expectTypeOf<{ prompt: string }>().not.toExtend<SilenceNudge>();
  });

  test("a user turn limit takes an explicit `undefined` for either bound", () => {
    // What a schema-inferred config hands over under `exactOptionalPropertyTypes`.
    const limit: UserTurnLimit = { maxWords: undefined, maxDurationMs: 30_000 };
    expect(limit.maxDurationMs).toBe(30_000);
    expectTypeOf<UserTurnLimit["maxWords"]>().toEqualTypeOf<number | undefined>();
  });
});
