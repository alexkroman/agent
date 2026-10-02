// Copyright 2026 the AAI authors. MIT license.
/**
 * The join between the SDK's provider catalog and this package's openers — the
 * run-time half of the completeness check (`registry.ts`'s module doc has the
 * compile-time half) — and how a `fallback([...])` descriptor resolves.
 */

import {
  LLM_PROVIDERS,
  S2S_PROVIDERS,
  STT_PROVIDERS,
  TTS_PROVIDERS,
} from "@alexkroman1/aai/host-internal";
import { fallback, llm } from "@alexkroman1/aai/llm";
import { assemblyAIStt, deepgramStt, sonioxStt } from "@alexkroman1/aai/stt";
import { cartesiaTts, rimeTts } from "@alexkroman1/aai/tts";
import { describe, expect, it } from "vitest";
import { LLM_REGISTRY } from "./_llm-registry.ts";
import { S2S_REGISTRY, STT_REGISTRY, TTS_REGISTRY } from "./registry.ts";
import {
  ALL_PROVIDER_ENV_VARS,
  requiredProviderEnvVars,
  resolveLlm,
  resolveStt,
  resolveTts,
} from "./resolve.ts";

/** A registry as `kind → envVar`, the part the catalog owns. */
const credentials = (registry: Record<string, { envVar: string }>) =>
  Object.fromEntries(Object.entries(registry).map(([kind, e]) => [kind, e.envVar]));
const catalogCredentials = (defs: readonly { kind: string; envVar: string }[]) =>
  Object.fromEntries(defs.map((d) => [d.kind, d.envVar]));

describe("the catalog ↔ registry join", () => {
  it("gives every catalog kind exactly one runtime entry, with the catalog's credential", () => {
    expect(credentials(STT_REGISTRY)).toEqual(catalogCredentials(STT_PROVIDERS));
    expect(credentials(TTS_REGISTRY)).toEqual(catalogCredentials(TTS_PROVIDERS));
    expect(credentials(S2S_REGISTRY)).toEqual(catalogCredentials(S2S_PROVIDERS));
    expect(credentials(LLM_REGISTRY)).toEqual(catalogCredentials(Object.values(LLM_PROVIDERS)));
  });

  it("puts every catalog credential on the host-fallback allowlist", () => {
    const named = [STT_PROVIDERS, TTS_PROVIDERS, S2S_PROVIDERS, Object.values(LLM_PROVIDERS)]
      .flat()
      .map((d) => d.envVar)
      .filter((v) => v !== "");
    for (const envVar of named) expect(ALL_PROVIDER_ENV_VARS).toContain(envVar);
  });
});

describe("fallback([...]) resolution", () => {
  it("resolves an STT fallback to one opener carrying the PRIMARY's credential variable", () => {
    const resolved = resolveStt(fallback([deepgramStt(), assemblyAIStt()]), {});
    expect(resolved.envVar).toBe("DEEPGRAM_API_KEY");
    expect(resolved.opener.name).toBe("fallback(deepgram,assemblyai)");
  });

  it("resolves a TTS fallback the same way", () => {
    const resolved = resolveTts(fallback([cartesiaTts(), rimeTts()]), {});
    expect(resolved.envVar).toBe("CARTESIA_API_KEY");
  });

  it("throws on an unknown MEMBER kind at resolution, as a lone one would", () => {
    const d = fallback([deepgramStt(), { kind: "nope", options: {} }]);
    expect(() => resolveStt(d)).toThrow(/Unknown STT provider kind: "nope"/);
  });

  it("refuses a hand-built fallback with fewer than two members by name", () => {
    expect(() =>
      resolveStt({ kind: "fallback", options: { providers: [{ kind: "deepgram", options: {} }] } }),
    ).toThrow(/at least two/);
  });

  it("resolves EVERY LLM member, so a secondary's missing key fails at startup", () => {
    const d = fallback([
      llm({ provider: "assemblyai", model: "gpt-5.6-luna" }),
      llm({ provider: "anthropic", model: "claude-sonnet-5" }),
    ]);
    expect(() => resolveLlm(d, { ASSEMBLYAI_API_KEY: "k" })).toThrow(/ANTHROPIC_API_KEY/);
    const model = resolveLlm(d, { ASSEMBLYAI_API_KEY: "k", ANTHROPIC_API_KEY: "a" });
    expect(typeof model === "string" ? model : model.modelId).toBe("gpt-5.6-luna");
  });

  it("makes the preflight demand every member's key", () => {
    const vars = requiredProviderEnvVars({
      stt: fallback([assemblyAIStt(), sonioxStt({ apiKeyEnv: "MY_SONIOX" })]),
      llm: fallback([
        llm({ provider: "assemblyai", model: "m" }),
        llm({ provider: "groq", model: "m" }),
      ]),
      tts: fallback([cartesiaTts(), rimeTts()]),
    });
    expect(new Set(vars)).toEqual(
      new Set([
        "ASSEMBLYAI_API_KEY",
        "CARTESIA_API_KEY",
        "GROQ_API_KEY",
        "MY_SONIOX",
        "RIME_API_KEY",
      ]),
    );
  });
});
