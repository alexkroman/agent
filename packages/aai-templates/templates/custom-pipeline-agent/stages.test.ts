/**
 * The provider catalog: every stage, every vendor, as compiling code.
 *
 * `agent.ts` declares ONE stage, because an agent should. This file is the menu
 * it picked that line off — the shape of each of the other twenty-odd provider
 * factories, the option type each takes, and the published constants an author
 * needs to spell a default out loud.
 *
 * It lives in the spec rather than in `agent.ts` for a reason worth copying: a
 * deployed agent needs a key per vendor it names, and the all-AssemblyAI
 * default is what makes the starter run the moment it is deployed. Declaring a
 * stage here shows the shape and costs the template nothing. (Before this file
 * the whole surface had NO example anywhere: zero of the templates set `stt:`,
 * `tts:` or `s2s:`, so `@alexkroman1/aai/stt` and `/s2s` were 100% unexercised
 * while carrying a semver promise. That is either an API nobody needs or an API
 * nobody has run, and neither is a good place to leave a published surface.)
 *
 * `modes.test.ts` beside it is the other half — which stages a mode even HAS.
 */

import type { ProviderCredentialOptions, ProviderDescriptor } from "@alexkroman1/aai";
import { agent } from "@alexkroman1/aai";
import {
  type AnthropicLlmOptions,
  ASSEMBLYAI_LLM_DEFAULT_MODEL,
  ASSEMBLYAI_LLM_GATEWAY_EU_URL,
  ASSEMBLYAI_LLM_GATEWAY_URL,
  type AssemblyAIGatewayModel,
  type AssemblyAILlmOptions,
  type AssemblyAIReasoningEffort,
  anthropicLlm,
  assemblyAILlm,
  type GatewayLlmOptions,
  type GoogleLlmOptions,
  type GroqLlmOptions,
  gatewayLlm,
  googleLlm,
  groqLlm,
  type LlmProvider,
  type MistralLlmOptions,
  type ModelOptions,
  mistralLlm,
  OPENROUTER_BASE_URL,
  type OpenAILlmOptions,
  type OpenRouterLlmOptions,
  openAILlm,
  openRouterLlm,
  type XAILlmOptions,
  xAILlm,
} from "@alexkroman1/aai/llm";
import { toAgentConfig } from "@alexkroman1/aai/manifest";
import {
  type AssemblyAIS2sOptions,
  assemblyAIS2s,
  type OpenAIS2sOptions,
  type OpenAIS2sVoice,
  openAIS2s,
  type S2sProvider,
} from "@alexkroman1/aai/s2s";
import {
  ASSEMBLYAI_STT_EU_URL,
  type AssemblyAISttOptions,
  assemblyAIStt,
  DEEPGRAM_DEFAULT_ENDPOINTING_MS,
  type DeepgramSttOptions,
  deepgramStt,
  type ElevenLabsSttOptions,
  elevenLabsStt,
  type SonioxSttOptions,
  type SttProvider,
  sonioxStt,
} from "@alexkroman1/aai/stt";
import {
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  ASSEMBLYAI_TTS_LANGUAGES,
  ASSEMBLYAI_TTS_VOICES,
  type AssemblyAITtsLanguage,
  type AssemblyAITtsOptions,
  type AssemblyAITtsVoice,
  type AssemblyAITtsVoiceId,
  type AssemblyAITtsVoiceInfo,
  assemblyAITts,
  CARTESIA_DEFAULT_VOICE,
  type CartesiaTtsOptions,
  cartesiaTts,
  RIME_DEFAULT_VOICE,
  type RimeTtsOptions,
  rimeTts,
  type TtsProvider,
} from "@alexkroman1/aai/tts";
import { describe, expect, test } from "vitest";

/** The name is not the subject here — every case declares a throwaway agent. */
const NAME = "Line";

/**
 * Read any stage the same way, because every stage descriptor is one shape.
 *
 * `ProviderDescriptor<Kind, Options>` is the base all four of `SttProvider`,
 * `LlmProvider`, `TtsProvider` and `S2sProvider` narrow, which is why it is the
 * one provider type published on the ROOT barrel rather than on a stage
 * subpath: one interface with four reference pages is a worse deal than one.
 * A descriptor is also pure DATA — no key, no client, nothing to close — which
 * is what lets `aai build` serialize it into the bundle.
 */
function shape(stage: ProviderDescriptor<string, Record<string, unknown>>): string {
  return `${stage.kind}(${Object.keys(stage.options).sort().join(", ")})`;
}

describe("the LLM stage: nine vendors, one field", () => {
  test("each factory returns a descriptor whose `kind` names the vendor", () => {
    // Keyed BY the kind, so the table is its own assertion: a factory returning
    // the wrong kind fails on its own row rather than in an aggregate.
    const byKind: Record<string, LlmProvider> = {
      anthropic: anthropicLlm({ model: "claude-haiku-4-5" } satisfies AnthropicLlmOptions),
      assemblyai: assemblyAILlm({} satisfies AssemblyAILlmOptions),
      gateway: gatewayLlm({ model: "zai/glm-4.6" } satisfies GatewayLlmOptions),
      google: googleLlm({ model: "gemini-2.5-flash" } satisfies GoogleLlmOptions),
      groq: groqLlm({ model: "llama-3.3-70b-versatile" } satisfies GroqLlmOptions),
      mistral: mistralLlm({ model: "mistral-large-latest" } satisfies MistralLlmOptions),
      openai: openAILlm({ model: "gpt-5-mini" } satisfies OpenAILlmOptions),
      openrouter: openRouterLlm({
        model: "meta-llama/llama-3.3-70b-instruct",
      } satisfies OpenRouterLlmOptions),
      xai: xAILlm({ model: "grok-4" } satisfies XAILlmOptions),
    };

    for (const [kind, llm] of Object.entries(byKind)) {
      expect(llm.kind, kind).toBe(kind);
      // And it survives the conversion a deploy runs, which is the claim that
      // matters: a descriptor the config drops is a stage that silently isn't.
      expect(toAgentConfig(agent({ name: NAME, llm })).llm?.kind, kind).toBe(kind);
    }
  });

  test("eight of the nine take exactly `ModelOptions` — one id, one key name", () => {
    // The shared base is why swapping vendors is a one-word edit: everything
    // except the AssemblyAI gateway is reached by naming a model and nothing
    // else. Each vendor still gets its own NAME for that options type so its
    // first vendor-specific setting is an additive field rather than a re-split
    // of the shared interface across eight call sites.
    const options: ModelOptions = { model: "gpt-5-mini" };
    expect(shape(openAILlm(options))).toBe("openai(model)");
    expect(shape(googleLlm({ ...options, model: "gemini-2.5-flash" }))).toBe("google(model)");
  });

  test("`apiKeyEnv` renames the variable the platform reads for this stage", () => {
    // `ProviderCredentialOptions` is the other base — every provider options
    // interface on all four stages extends it, which is why it too sits on the
    // root rather than in one stage's subpath. There is no factory-time key
    // parameter anywhere in this file: a descriptor stays free of secrets, and
    // the host resolves the value from the agent's env at session start. This
    // field only changes WHICH variable it reads, for an agent that keeps two
    // OpenAI keys, or names the vendor's key something of its own.
    const credential: ProviderCredentialOptions = { apiKeyEnv: "TEAM_OPENAI_KEY" };
    const llm = openAILlm({ model: "gpt-5-mini", ...credential });
    expect(llm.options.apiKeyEnv).toBe("TEAM_OPENAI_KEY");
    // Not a secret and not a value — the NAME of an env var, so it is safe in
    // the bundle. Nothing here reads `process.env`.
    expect(llm.options.model).toBe("gpt-5-mini");
  });

  test("the AssemblyAI gateway is the one that needs no model id", () => {
    // The stage `agent.ts` leaves unset. It bills to `ASSEMBLYAI_API_KEY` — the
    // one key a published agent is guaranteed to have — so its default model is
    // published rather than implied: a bare call is a REAL model id in the
    // descriptor, not an empty options bag the service has to guess at.
    expect(assemblyAILlm().options.model).toBe(ASSEMBLYAI_LLM_DEFAULT_MODEL);
    // A gateway id is a free-form string the service rejects with a 400 at the
    // first session — no compile-time check, no deploy-time check — so an
    // invented one ships. `AssemblyAIGatewayModel` is the id set this release
    // knows, and the union stays open so a model shipped after it still
    // compiles.
    const model: AssemblyAIGatewayModel = "claude-sonnet-4-6";
    // On a voice line, time-to-first-token IS the quality: the measured cost of
    // leaving a reasoning model on its server-side default was 1786ms p50
    // against 999ms with reasoning off.
    const reasoningEffort: AssemblyAIReasoningEffort = "none";
    expect(assemblyAILlm({ model, reasoningEffort }).options).toMatchObject({
      model,
      reasoningEffort,
    });
  });
});

describe("EU residency: a shorthand, and the URL it is short for", () => {
  test("`region` sets STT and the LLM gateway; TTS has a single endpoint", () => {
    expect(assemblyAIStt({ region: "eu" }).options.region).toBe("eu");
    expect(assemblyAILlm({ region: "eu" }).options.region).toBe("eu");
  });

  test("an explicit endpoint is the long form, and it WINS over `region`", () => {
    // Naming a URL is deliberate, so the residency shorthand must not silently
    // overwrite it. Both endpoints are published so the long form is a constant
    // rather than a string an author retypes — and an EU agent must also pick a
    // model the EU gateway carries (Claude and most Gemini ids), which is the
    // half a bare `region: "eu"` cannot do for you.
    const stt = assemblyAIStt({
      streamingUrl: ASSEMBLYAI_STT_EU_URL,
    } satisfies AssemblyAISttOptions);
    const llm = assemblyAILlm({
      gatewayUrl: ASSEMBLYAI_LLM_GATEWAY_EU_URL,
      model: "claude-sonnet-4-6",
    });
    expect(stt.options.streamingUrl).toBe(ASSEMBLYAI_STT_EU_URL);
    expect(llm.options.gatewayUrl).toBe(ASSEMBLYAI_LLM_GATEWAY_EU_URL);
    // The US gateway is published for the same reason: a tool body calling the
    // same endpoint directly should not retype it. Both are OpenAI-compatible
    // bases and carry the version path, so they drop into an OpenAI client as
    // they are; `OPENROUTER_BASE_URL` is the third of that shape. The streaming
    // one is a WebSocket URL and carries its own versioned path.
    for (const url of [ASSEMBLYAI_LLM_GATEWAY_URL, OPENROUTER_BASE_URL]) {
      expect(new URL(url).protocol).toBe("https:");
      expect(url.endsWith("/v1"), url).toBe(true);
    }
    expect(new URL(ASSEMBLYAI_STT_EU_URL).protocol).toBe("wss:");
  });
});

describe("the STT stage", () => {
  test("four providers, each one field on `agent()`", () => {
    for (const [stt, kind] of [
      [assemblyAIStt({ region: "eu" } satisfies AssemblyAISttOptions), "assemblyai"],
      [deepgramStt({ language: "en" } satisfies DeepgramSttOptions), "deepgram"],
      [elevenLabsStt({} satisfies ElevenLabsSttOptions), "elevenlabs"],
      [sonioxStt({ languages: ["en", "es"] } satisfies SonioxSttOptions), "soniox"],
    ] as const satisfies readonly (readonly [SttProvider, string])[]) {
      const config = toAgentConfig(agent({ name: NAME, stt }));
      expect(config.stt?.kind).toBe(kind);
      // Whatever the STT stage is, the two it does not touch still default.
      expect(config.llm?.kind).toBe("assemblyai");
      expect(config.tts?.kind).toBe("assemblyai");
    }
  });

  test("Deepgram's endpointing window is a published default, not a hidden one", () => {
    // The descriptor carries only what you set — the host fills the rest — so
    // the number is published rather than buried in the opener. It is worth
    // knowing before you move it: 1500ms is matched to the AssemblyAI opener's
    // 1600ms `min_turn_silence`, and Deepgram exposes no pause-tolerance
    // counterpart, so this one window is the whole end-of-turn policy there.
    expect(deepgramStt().options.endpointing).toBeUndefined();
    expect(deepgramStt({ endpointing: DEEPGRAM_DEFAULT_ENDPOINTING_MS }).options.endpointing).toBe(
      DEEPGRAM_DEFAULT_ENDPOINTING_MS,
    );
    // Deepgram is also the one STT here that does NOT auto-detect: it defaults
    // to English, so an agent moved to it silently loses non-English
    // transcription unless it names a code.
    expect(shape(deepgramStt({ language: "es" }))).toBe("deepgram(language)");
  });
});

describe("the TTS stage", () => {
  test("three providers, and a bare call is not an empty descriptor", () => {
    for (const [tts, kind, voice] of [
      [
        assemblyAITts({} satisfies AssemblyAITtsOptions),
        "assemblyai",
        ASSEMBLYAI_TTS_DEFAULT_VOICE,
      ],
      [cartesiaTts({} satisfies CartesiaTtsOptions), "cartesia", CARTESIA_DEFAULT_VOICE],
      [rimeTts({} satisfies RimeTtsOptions), "rime", RIME_DEFAULT_VOICE],
    ] as const satisfies readonly (readonly [TtsProvider, string, string])[]) {
      expect(toAgentConfig(agent({ name: NAME, tts })).tts?.kind).toBe(kind);
      // Each factory names its vendor's default voice rather than leaving the
      // field out, which is what makes `cartesiaTts()` work out of the box.
      expect(tts.options.voice, kind).toBe(voice);
    }
  });

  test("a voice speaks exactly ONE language, and a pair that disagrees is refused", () => {
    // The catalog is `voice id -> { language, accent }`, and every language the
    // stage supports has at least one speaker. Pick from it rather than pairing
    // by hand: `{ language: "fr" }` alone fills in the default voice, which
    // speaks English, so asking for French and nothing else used to produce an
    // agent that connected, reported ready, and never spoke.
    const info: AssemblyAITtsVoiceInfo = ASSEMBLYAI_TTS_VOICES[ASSEMBLYAI_TTS_DEFAULT_VOICE];
    expect(info.language).toBe("en");

    const ids = Object.keys(ASSEMBLYAI_TTS_VOICES) as AssemblyAITtsVoiceId[];
    for (const language of Object.keys(ASSEMBLYAI_TTS_LANGUAGES) as AssemblyAITtsLanguage[]) {
      const [voice] = ids.filter((id) => ASSEMBLYAI_TTS_VOICES[id].language === language);
      expect(voice, language).toBeDefined();
      if (!voice) continue;
      const speaking = agent({ name: NAME, tts: assemblyAITts({ language, voice }) });
      expect(() => toAgentConfig(speaking), language).not.toThrow();
    }

    // `toAgentConfig` is the last layer that sees the mismatch while somebody
    // is still authoring — after it, the refusal is in-band, after the socket
    // opens, with the agent ready and mute.
    const mismatched = agent({ name: NAME, tts: assemblyAITts({ language: "fr" }) });
    expect(() => toAgentConfig(mismatched)).toThrow(/speaks en/);
  });

  test("the catalog is not an allow-list: a voice shipped later still compiles", () => {
    // `AssemblyAITtsVoice` is the open union — the listed ids plus any string —
    // deliberately, because refusing an unlisted voice would refuse one
    // AssemblyAI ships after this release. `aai build` prints a warning for a
    // name it does not recognise, which is what catches the typo half.
    const unreleased: AssemblyAITtsVoice = "voice-shipped-after-this-release";
    const later = agent({ name: NAME, tts: assemblyAITts({ voice: unreleased }) });
    expect(toAgentConfig(later).tts?.options.voice).toBe(unreleased);
  });
});

describe("the S2S stage: an opt-in that REPLACES the pipeline", () => {
  test("two providers, and neither leaves an STT or TTS stage behind", () => {
    const voice: OpenAIS2sVoice = "alloy";
    for (const [s2s, kind] of [
      [assemblyAIS2s({ keyterms: ["AssemblyAI"] } satisfies AssemblyAIS2sOptions), "assemblyai"],
      [openAIS2s({ voice } satisfies OpenAIS2sOptions), "openai-realtime"],
    ] as const satisfies readonly (readonly [S2sProvider, string])[]) {
      const config = toAgentConfig(agent({ name: NAME, s2s }));
      expect(config.s2s?.kind).toBe(kind);
      expect(config.mode).toBe("s2s");
      // No cascade is filled in: speech-to-speech has no separate STT or TTS,
      // which is the whole difference and the reason `s2s` is never a default.
      expect(config.stt).toBeUndefined();
      expect(config.tts).toBeUndefined();
    }
  });

  test("mixing S2S with a pipeline stage is refused, by the type AND by the config", () => {
    // The type refuses it outright: `agent({ s2s, tts })` does not compile, which
    // is why this reaches the runtime rule by spreading instead. Both halves
    // matter — the second is what catches a raw `export default {...}` that
    // never went through `agent()`.
    const s2sAgent = agent({ name: NAME, s2s: assemblyAIS2s() });
    expect(() => toAgentConfig({ ...s2sAgent, tts: cartesiaTts() })).toThrow();
  });
});
