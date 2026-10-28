// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  DEFAULT_CONTINUATION_WINDOW_MS,
  MAX_CONTINUATION_WINDOW_MS,
} from "./continuation-constants.ts";

describe("continuation window constants", () => {
  test("the default is a positive window the schema's maximum admits", () => {
    expect(DEFAULT_CONTINUATION_WINDOW_MS).toBeGreaterThan(0);
    expect(DEFAULT_CONTINUATION_WINDOW_MS).toBeLessThanOrEqual(MAX_CONTINUATION_WINDOW_MS);
  });
});
