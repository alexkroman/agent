// Copyright 2026 the AAI authors. MIT license.
// The frozen `hook-close-race` interleaving, both arms: it holds against the real journal,
// and its named law fires once the guard it catches is removed. The corpus
// floor and the defect coverage are `../interleavings.test.ts`.

import { describe, expect, test } from "vitest";
import { replay } from "../_interleaving-test-utils.ts";
import { hookCloseRace } from "./hook-close-race.ts";

describe(hookCloseRace.name, () => {
  test("holds against the real journal", async () => {
    expect(await replay(hookCloseRace), hookCloseRace.description).toEqual([]);
  });

  test(`fires when ${hookCloseRace.catches.defect} is removed`, async () => {
    const problems = await replay(hookCloseRace, hookCloseRace.catches.defect);
    // The PHRASE, not merely a non-empty list: a scenario that broke some
    // other claim under a defective store would otherwise read as proof of a
    // law it never exercised.
    expect(
      problems.join("\n"),
      `expected a problem naming "${hookCloseRace.catches.law}"`,
    ).toContain(hookCloseRace.catches.law);
  });
});
