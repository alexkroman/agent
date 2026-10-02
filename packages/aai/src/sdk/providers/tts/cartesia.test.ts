// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  CARTESIA_API_KEY_ENV,
  CARTESIA_DEFAULT_LANGUAGE,
  CARTESIA_DEFAULT_MODEL,
  CARTESIA_DEFAULT_VOICE,
  CARTESIA_KIND,
  cartesiaTts,
  resolveCartesiaTtsSettings,
} from "./cartesia.ts";

describe("cartesiaTts", () => {
  test("writes the default voice into the descriptor, so the wire never carries none", () => {
    expect(cartesiaTts()).toEqual({
      kind: CARTESIA_KIND,
      options: { voice: CARTESIA_DEFAULT_VOICE },
    });
    expect(CARTESIA_KIND).toBe("cartesia");
    expect(CARTESIA_API_KEY_ENV).toBe("CARTESIA_API_KEY");
  });

  test("keeps a named voice and the other options", () => {
    expect(cartesiaTts({ voice: "v1", model: "sonic-3" }).options).toEqual({
      voice: "v1",
      model: "sonic-3",
    });
  });
});

describe("resolveCartesiaTtsSettings", () => {
  test("fills every unset field with the documented default", () => {
    expect(resolveCartesiaTtsSettings({})).toEqual({
      voice: CARTESIA_DEFAULT_VOICE,
      model: CARTESIA_DEFAULT_MODEL,
      language: CARTESIA_DEFAULT_LANGUAGE,
    });
  });

  test("keeps what the author set", () => {
    expect(resolveCartesiaTtsSettings({ voice: "v", model: "m", language: "fr" })).toEqual({
      voice: "v",
      model: "m",
      language: "fr",
    });
  });
});
