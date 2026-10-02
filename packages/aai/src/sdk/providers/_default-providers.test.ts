// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { defaultProviders } from "./_default-providers.ts";
import { assemblyAIPipeline } from "./assemblyai-pipeline.ts";
import { cartesiaTts } from "./tts/cartesia.ts";

describe("defaultProviders", () => {
  test("fills all three stages of a config that declares none", () => {
    expect(defaultProviders({})).toEqual(assemblyAIPipeline());
  });

  test("fills only the stages a config left unset", () => {
    const fill = defaultProviders({ tts: cartesiaTts() });
    expect(fill).toEqual({ stt: assemblyAIPipeline().stt, llm: assemblyAIPipeline().llm });
    expect(fill && "tts" in fill).toBe(false);
  });

  test("fills nothing for a complete pipeline, an s2s agent, or a text agent", () => {
    expect(defaultProviders(assemblyAIPipeline())).toBeNull();
    expect(defaultProviders({ s2s: { kind: "assemblyai", options: {} } })).toBeNull();
    expect(defaultProviders({ mode: "text" })).toBeNull();
  });

  test("treats a null stage as unset", () => {
    expect(defaultProviders({ stt: null, llm: null, tts: null })).toEqual(assemblyAIPipeline());
  });
});
