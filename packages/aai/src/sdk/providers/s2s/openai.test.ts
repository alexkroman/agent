// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { OPENAI_S2S_API_KEY_ENV, OPENAI_S2S_KIND, openAIS2s } from "./openai.ts";

describe("openAIS2s", () => {
  test("is an openai-realtime descriptor, credentialed by OPENAI_API_KEY", () => {
    expect(OPENAI_S2S_KIND).toBe("openai-realtime");
    expect(OPENAI_S2S_API_KEY_ENV).toBe("OPENAI_API_KEY");
    expect(openAIS2s()).toEqual({ kind: OPENAI_S2S_KIND, options: {} });
  });

  test("carries the model, voice and url as given, with no defaults filled in", () => {
    expect(openAIS2s({ model: "gpt-realtime", voice: "marin", url: "wss://x" }).options).toEqual({
      model: "gpt-realtime",
      voice: "marin",
      url: "wss://x",
    });
  });
});
