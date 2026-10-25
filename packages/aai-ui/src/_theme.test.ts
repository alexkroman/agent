// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { DEFAULT_THEME, resolveClientTheme } from "./_theme.ts";

describe("resolveClientTheme", () => {
  test("nothing, and the empty token form, are the default theme", () => {
    expect(resolveClientTheme(undefined)).toBe(DEFAULT_THEME);
    expect(resolveClientTheme({})).toEqual(DEFAULT_THEME);
  });

  test("the token form fills what it names and leaves the rest to the defaults", () => {
    expect(resolveClientTheme({ primary: "#ff0000", surface: "#101010" })).toEqual({
      ...DEFAULT_THEME,
      primary: "#ff0000",
      surface: "#101010",
    });
    // A present-but-undefined token (an options bag) is not a hole.
    expect(resolveClientTheme({ primary: "#ff0000", text: undefined })).toEqual({
      ...DEFAULT_THEME,
      primary: "#ff0000",
    });
  });

  test("the preset form derives the four neutrals from the mode, light by default", () => {
    expect(resolveClientTheme({ primary: "#e55", mode: "dark" })).toEqual({
      bg: "#09090B",
      surface: "#18181B",
      text: "#FAFAFA",
      border: "#27272A",
      primary: "#e55",
    });
    expect(resolveClientTheme({ primary: "#e55", mode: "light" })).toEqual({
      ...DEFAULT_THEME,
      primary: "#e55",
    });
    // `{ primary }` is both forms and resolves alike.
    expect(resolveClientTheme({ primary: "#e55" })).toEqual({ ...DEFAULT_THEME, primary: "#e55" });
  });
});
