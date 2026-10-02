// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  resolveSonioxSttSettings,
  SONIOX_API_KEY_ENV,
  SONIOX_DEFAULT_MODEL,
  SONIOX_KIND,
  sonioxStt,
} from "./soniox.ts";

describe("sonioxStt", () => {
  test("is a soniox descriptor carrying the options as given", () => {
    expect(sonioxStt({ languages: ["en", "es"] })).toEqual({
      kind: SONIOX_KIND,
      options: { languages: ["en", "es"] },
    });
    expect(SONIOX_KIND).toBe("soniox");
    expect(SONIOX_API_KEY_ENV).toBe("SONIOX_API_KEY");
  });
});

describe("resolveSonioxSttSettings", () => {
  test("defaults the model and sends no hints for no languages", () => {
    expect(resolveSonioxSttSettings({})).toEqual({ model: SONIOX_DEFAULT_MODEL });
    expect(resolveSonioxSttSettings({ languages: [] })).toEqual({ model: SONIOX_DEFAULT_MODEL });
  });

  test("maps the languages onto the provider's languageHints", () => {
    expect(resolveSonioxSttSettings({ model: "m", languages: ["en", "es"] })).toEqual({
      model: "m",
      languageHints: ["en", "es"],
    });
  });
});
