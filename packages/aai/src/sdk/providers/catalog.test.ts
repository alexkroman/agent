// Copyright 2026 the AAI authors. MIT license.
/** The provider catalog: one definition per vendor, and every factory stamped by its own. */

import { describe, expect, it } from "vitest";
import {
  LLM_PROVIDERS,
  PROVIDER_CATALOG,
  S2S_PROVIDERS,
  STT_PROVIDERS,
  TTS_PROVIDERS,
} from "./catalog.ts";
import { KNOWN_LLM_PROVIDERS, llm } from "./llm/llm.ts";
import { assemblyAIS2s } from "./s2s/assemblyai.ts";
import { openAIS2s } from "./s2s/openai.ts";
import { assemblyAIStt } from "./stt/assemblyai.ts";
import { deepgramStt } from "./stt/deepgram.ts";
import { elevenLabsStt } from "./stt/elevenlabs.ts";
import { localStt } from "./stt/local.ts";
import { sonioxStt } from "./stt/soniox.ts";
import { assemblyAITts } from "./tts/assemblyai.ts";
import { cartesiaTts } from "./tts/cartesia.ts";
import { rimeTts } from "./tts/rime.ts";

describe("PROVIDER_CATALOG", () => {
  it("names each kind once per stage — the key the runtime's opener tables join on", () => {
    for (const stage of ["stt", "llm", "tts", "s2s"] as const) {
      const kinds = PROVIDER_CATALOG.filter((d) => d.stage === stage).map((d) => d.kind);
      expect(new Set(kinds).size, stage).toBe(kinds.length);
      expect(kinds.length, stage).toBeGreaterThan(0);
    }
  });

  it("is every stage list, and each list holds only its own stage", () => {
    const lists = [STT_PROVIDERS, Object.values(LLM_PROVIDERS), TTS_PROVIDERS, S2S_PROVIDERS];
    expect(PROVIDER_CATALOG.length).toBe(lists.reduce((n, l) => n + l.length, 0));
    for (const d of STT_PROVIDERS) expect(d.stage, d.kind).toBe("stt");
    for (const d of TTS_PROVIDERS) expect(d.stage, d.kind).toBe("tts");
    for (const d of S2S_PROVIDERS) expect(d.stage, d.kind).toBe("s2s");
  });

  it("keys LLM_PROVIDERS by exactly the built-in provider names", () => {
    expect(Object.keys(LLM_PROVIDERS).sort()).toEqual([...KNOWN_LLM_PROVIDERS].sort());
    for (const [key, d] of Object.entries(LLM_PROVIDERS)) {
      expect(d.kind, String(key)).toBe(key);
      expect(d.stage, String(key)).toBe("llm");
    }
  });

  it("gives every credentialed provider an env var, and only the local model none", () => {
    const free = PROVIDER_CATALOG.filter((d) => d.envVar === "").map((d) => d.kind);
    expect(free).toEqual(["local"]);
  });

  it("is where each factory's `kind` comes from", () => {
    // The factory is the derivation: a descriptor names the definition's kind,
    // so the runtime registry keyed to the same definition can resolve it.
    const built = [
      assemblyAIStt(),
      deepgramStt(),
      elevenLabsStt(),
      sonioxStt(),
      localStt(),
      assemblyAITts(),
      cartesiaTts(),
      rimeTts(),
    ];
    expect(built.map((d) => d.kind)).toEqual([
      ...STT_PROVIDERS.map((d) => d.kind),
      ...TTS_PROVIDERS.map((d) => d.kind),
    ]);
    expect([assemblyAIS2s().kind, openAIS2s().kind]).toEqual(S2S_PROVIDERS.map((d) => d.kind));
    for (const name of KNOWN_LLM_PROVIDERS) {
      expect(llm({ provider: name, model: "m" }).kind, String(name)).toBe(LLM_PROVIDERS[name].kind);
    }
  });
});
