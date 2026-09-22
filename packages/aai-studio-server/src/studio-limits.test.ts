// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { MAX_CHAT_STEPS, MAX_OUTPUT_TOKENS, studioMaxOutputTokens } from "./studio-limits.ts";

describe("studioMaxOutputTokens", () => {
  test("defaults to the constant when unset", () => {
    expect(studioMaxOutputTokens({})).toBe(MAX_OUTPUT_TOKENS);
  });

  test("an empty string means unset, not zero", () => {
    // Same `||` convention as studioLlmModelId — a Modal secret that exists
    // but is blank must not hand the model call a ceiling of NaN.
    expect(studioMaxOutputTokens({ STUDIO_MAX_OUTPUT_TOKENS: "" })).toBe(MAX_OUTPUT_TOKENS);
  });

  test("takes a positive integer override", () => {
    expect(studioMaxOutputTokens({ STUDIO_MAX_OUTPUT_TOKENS: "8000" })).toBe(8000);
  });

  test.each(["nope", "0", "-1", "1.5"])("falls back rather than pass %s to the model", (bad) => {
    // A bad value must not reach the provider: the whole point of the setting
    // is that an out-of-range ceiling truncates a step, and a truncated step
    // now has its tool calls dropped unexecuted.
    expect(studioMaxOutputTokens({ STUDIO_MAX_OUTPUT_TOKENS: bad })).toBe(MAX_OUTPUT_TOKENS);
  });

  test("the ceiling leaves real room against the step cap", () => {
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThan(16_000);
    expect(MAX_CHAT_STEPS).toBeGreaterThan(0);
  });
});
