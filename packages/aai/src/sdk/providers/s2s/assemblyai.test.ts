// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { ASSEMBLYAI_S2S_API_KEY_ENV, ASSEMBLYAI_S2S_KIND, assemblyAIS2s } from "./assemblyai.ts";

describe("assemblyAIS2s", () => {
  test("is an assemblyai s2s descriptor, credentialed by the AssemblyAI key", () => {
    expect(ASSEMBLYAI_S2S_KIND).toBe("assemblyai");
    expect(ASSEMBLYAI_S2S_API_KEY_ENV).toBe("ASSEMBLYAI_API_KEY");
    expect(assemblyAIS2s()).toEqual({ kind: "assemblyai", options: {} });
  });

  test("carries the voice, languages and keyterms as given", () => {
    const options = { voice: "v", languages: ["en"], keyterms: ["AssemblyAI"] };
    expect(assemblyAIS2s(options).options).toEqual(options);
  });

  test("copies the options rather than holding the caller's object", () => {
    const options = { voice: "v" };
    const descriptor = assemblyAIS2s(options);
    options.voice = "w";
    expect(descriptor.options).toEqual({ voice: "v" });
  });
});
