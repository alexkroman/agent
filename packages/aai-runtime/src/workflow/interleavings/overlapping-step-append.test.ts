// Copyright 2026 the AAI authors. MIT license.
// The frozen `overlapping-step-append` interleaving, both arms: it holds against the real journal,
// and its named law fires once the guard it catches is removed. The corpus
// floor and the defect coverage are `../interleavings.test.ts`.

import { describe, expect, test } from "vitest";
import { replay } from "../_interleaving-test-utils.ts";
import { overlappingStepAppend } from "./overlapping-step-append.ts";

describe(overlappingStepAppend.name, () => {
  test("holds against the real journal", async () => {
    expect(await replay(overlappingStepAppend), overlappingStepAppend.description).toEqual([]);
  });

  test(`fires when ${overlappingStepAppend.catches.defect} is removed`, async () => {
    const problems = await replay(overlappingStepAppend, overlappingStepAppend.catches.defect);
    // The PHRASE, not merely a non-empty list: a scenario that broke some
    // other claim under a defective store would otherwise read as proof of a
    // law it never exercised.
    expect(
      problems.join("\n"),
      `expected a problem naming "${overlappingStepAppend.catches.law}"`,
    ).toContain(overlappingStepAppend.catches.law);
  });
});
