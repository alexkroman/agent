// Copyright 2026 the AAI authors. MIT license.
/**
 * The claim these fields exist to make is that the rule reaches the MODEL, so
 * the description is asserted as carefully as the validation.
 */
import { describe, expect, test } from "vitest";
import { z } from "zod";

import { clockTime, isoDate } from "./tool-fields.ts";

describe("isoDate", () => {
  test("accepts a real date and rejects one that only matches the shape", () => {
    expect(isoDate().safeParse("2026-06-08").success).toBe(true);
    // The distinction `z.iso.date()` does not make, which is why the field is
    // built on this repo's own predicate.
    expect(isoDate().safeParse("2026-02-30").success).toBe(false);
  });

  test("names the argument in the rejection", () => {
    const parsed = isoDate("the arrival date").safeParse("nope");
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      "the arrival date must be a real date in YYYY-MM-DD form",
    );
  });

  test("puts the format in the description the model reads", () => {
    // The half that saves a turn: the model learns the shape before it calls,
    // not by being refused after it has committed to an argument.
    expect(isoDate("the arrival date").description).toBe("the arrival date, YYYY-MM-DD");
    expect(z.toJSONSchema(isoDate())).toMatchObject({ description: "the date, YYYY-MM-DD" });
  });

  test("composes like any other schema", () => {
    const schema = z.object({ date: isoDate().optional() });
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ date: "2026-02-30" }).success).toBe(false);
  });
});

describe("clockTime", () => {
  test("requires a zero-padded 24-hour time", () => {
    expect(clockTime().safeParse("04:45").success).toBe(true);
    expect(clockTime().safeParse("4:45").success).toBe(false);
    expect(clockTime().safeParse("7 PM").success).toBe(false);
  });

  test("names the argument in the rejection", () => {
    const parsed = clockTime("the pickup time").safeParse("7pm");
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      "the pickup time must be a 24-hour HH:MM time, like 19:30 or 04:45",
    );
  });

  test("spells the padding out in the description", () => {
    // The padding is the half a model gets wrong unsupervised.
    expect(clockTime().description).toBe("the time, 24-hour HH:MM — 4:45 a.m. is 04:45");
  });
});
