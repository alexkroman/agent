// Copyright 2026 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { TEXTBELT_KEY_ENV } from "../sdk/_owner-text-env.ts";
import { BUILTIN_TOOL_ENV } from "../sdk/derived-env.ts";
import { BRAVE_API_KEY_ENV } from "./brave-search.ts";
import { GOOGLE_PLACES_API_KEY_ENV } from "./google-places.ts";

// The deploy preflight derives a keyed builtin's variable from this table, so
// it must name the variable the builtin actually reads.
test("BUILTIN_TOOL_ENV names the variable each keyed builtin reads", () => {
  expect(BUILTIN_TOOL_ENV).toEqual({
    brave_search: BRAVE_API_KEY_ENV,
    google_places: GOOGLE_PLACES_API_KEY_ENV,
    text_me: TEXTBELT_KEY_ENV,
  });
});
