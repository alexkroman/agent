// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_THEME, resolveClientTheme } from "./_theme.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("a blank token", () => {
  test('is ignored with a warning, never written as "" — the default fills it', () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // `--aai-primary: ;` is what `""` used to become: an empty custom property,
    // and every primary-coloured control transparent with nothing saying why.
    expect(resolveClientTheme({ primary: "", surface: "#101010" })).toEqual({
      ...DEFAULT_THEME,
      surface: "#101010",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/theme\.primary is "" and was ignored/);
  });

  test("in the preset form falls back to the ground's ink, which the dark ground needs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(resolveClientTheme({ primary: "", mode: "dark" })).toMatchObject({
      bg: "#09090B",
      primary: "#FAFAFA",
    });
    expect(resolveClientTheme({ primary: "" })).toEqual(DEFAULT_THEME);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("colour syntax is not validated — the browser is the authority", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(resolveClientTheme({ primary: "not-a-color" }).primary).toBe("not-a-color");
    expect(warn).not.toHaveBeenCalled();
  });
});
