// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  RIME_API_KEY_ENV,
  RIME_DEFAULT_LANGUAGE,
  RIME_DEFAULT_MODEL,
  RIME_DEFAULT_VOICE,
  RIME_KIND,
  resolveRimeTtsSettings,
  rimeTts,
} from "./rime.ts";

describe("rimeTts", () => {
  test("writes the default voice into the descriptor, so the wire never carries none", () => {
    expect(rimeTts()).toEqual({ kind: RIME_KIND, options: { voice: RIME_DEFAULT_VOICE } });
    expect(RIME_KIND).toBe("rime");
    expect(RIME_API_KEY_ENV).toBe("RIME_API_KEY");
  });

  test("keeps a named voice and the other options", () => {
    expect(rimeTts({ voice: "astra", apiKeyEnv: "MY_RIME" }).options).toEqual({
      voice: "astra",
      apiKeyEnv: "MY_RIME",
    });
  });
});

describe("resolveRimeTtsSettings", () => {
  test("fills every unset field with the documented default — a three-letter language", () => {
    expect(resolveRimeTtsSettings({})).toEqual({
      voice: RIME_DEFAULT_VOICE,
      model: RIME_DEFAULT_MODEL,
      language: RIME_DEFAULT_LANGUAGE,
    });
    expect(RIME_DEFAULT_LANGUAGE).toHaveLength(3);
  });

  test("keeps what the author set", () => {
    expect(resolveRimeTtsSettings({ voice: "v", model: "m", language: "spa" })).toEqual({
      voice: "v",
      model: "m",
      language: "spa",
    });
  });
});
