// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  ELEVENLABS_API_KEY_ENV,
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_KIND,
  elevenLabsStt,
  resolveElevenLabsSttSettings,
} from "./elevenlabs.ts";

describe("elevenLabsStt", () => {
  test("is an elevenlabs descriptor carrying the options as given", () => {
    expect(elevenLabsStt({ language: "fr" })).toEqual({
      kind: ELEVENLABS_KIND,
      options: { language: "fr" },
    });
    expect(ELEVENLABS_KIND).toBe("elevenlabs");
    expect(ELEVENLABS_API_KEY_ENV).toBe("ELEVENLABS_API_KEY");
  });
});

describe("resolveElevenLabsSttSettings", () => {
  test("defaults the model and sends no language code unless one is named", () => {
    expect(resolveElevenLabsSttSettings({})).toEqual({ model: ELEVENLABS_DEFAULT_MODEL });
  });

  test("an empty language is the same as none — auto-detection, not an empty code", () => {
    expect(resolveElevenLabsSttSettings({ language: "" })).toEqual({
      model: ELEVENLABS_DEFAULT_MODEL,
    });
  });

  test("maps a named language onto the provider's languageCode", () => {
    expect(resolveElevenLabsSttSettings({ model: "m", language: "de" })).toEqual({
      model: "m",
      languageCode: "de",
    });
  });
});
