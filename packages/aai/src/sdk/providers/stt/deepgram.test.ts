// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  DEEPGRAM_API_KEY_ENV,
  DEEPGRAM_DEFAULT_ENDPOINTING_MS,
  DEEPGRAM_DEFAULT_LANGUAGE,
  DEEPGRAM_DEFAULT_MODEL,
  DEEPGRAM_KIND,
  deepgramStt,
  resolveDeepgramSttSettings,
} from "./deepgram.ts";

describe("deepgramStt", () => {
  test("is a deepgram descriptor carrying the options as given", () => {
    expect(deepgramStt({ model: "nova-2", apiKeyEnv: "DG_KEY" })).toEqual({
      kind: DEEPGRAM_KIND,
      options: { model: "nova-2", apiKeyEnv: "DG_KEY" },
    });
    expect(DEEPGRAM_KIND).toBe("deepgram");
    expect(DEEPGRAM_API_KEY_ENV).toBe("DEEPGRAM_API_KEY");
  });

  test("copies the options, so a later mutation of the caller's object changes nothing", () => {
    const options = { model: "nova-3" };
    const descriptor = deepgramStt(options);
    options.model = "nova-2";
    expect(descriptor.options).toEqual({ model: "nova-3" });
  });
});

describe("resolveDeepgramSttSettings", () => {
  test("fills every unset field with the documented default", () => {
    expect(resolveDeepgramSttSettings({})).toEqual({
      model: DEEPGRAM_DEFAULT_MODEL,
      language: DEEPGRAM_DEFAULT_LANGUAGE,
      endpointingMs: DEEPGRAM_DEFAULT_ENDPOINTING_MS,
    });
  });

  test("keeps what the author set, a zero endpointing window included", () => {
    expect(resolveDeepgramSttSettings({ model: "nova-2", language: "es", endpointing: 0 })).toEqual(
      { model: "nova-2", language: "es", endpointingMs: 0 },
    );
  });
});
