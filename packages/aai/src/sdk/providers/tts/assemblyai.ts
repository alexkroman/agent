// Copyright 2026 the AAI authors. MIT license.
/**
 * AssemblyAI streaming TTS factory — returns a pure descriptor.
 *
 * See {@link assemblyAIStt} for the descriptor/opener split; the host-side
 * resolver turns this into an openable `TtsOpener` during `createRuntime` using
 * the `ASSEMBLYAI_API_KEY` from the agent's env — the same key AssemblyAI STT
 * and the LLM Gateway use,
 * so a full AssemblyAI pipeline needs exactly one secret.
 *
 * The three AssemblyAI stage factories have distinct names
 * (`assemblyAIStt`, `llm({ provider: "assemblyai" })`, `assemblyAITts`), so they can be
 * imported side by side:
 *
 * ```ts
 * import { assemblyAIStt } from "@alexkroman1/aai/stt";
 * import { llm } from "@alexkroman1/aai/llm";
 * import { assemblyAITts } from "@alexkroman1/aai/tts";
 * ```
 */

import { nearestNames } from "../../_nearest-names.ts";
import { isRecord } from "../../is-record.ts";
import { omitUndefined } from "../../omit-undefined.ts";
import type { ProviderCredentialOptions, TtsProvider } from "../../providers.ts";
import { defineProvider, describeProvider } from "../define-provider.ts";
import {
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  ASSEMBLYAI_TTS_VOICES,
  type AssemblyAITtsVoice,
  isCatalogVoice,
} from "../tts-voices.ts";

// The voice CATALOG lives in its own module (the file-length cap); re-exported
// here so every import path that named it before still resolves.
export {
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  ASSEMBLYAI_TTS_VOICES,
  type AssemblyAITtsVoice,
} from "../tts-voices.ts";

/** This vendor's registration (see `define-provider.ts`); the constants below derive from it. */
export const ASSEMBLYAI_TTS_PROVIDER = defineProvider({
  kind: "assemblyai",
  stage: "tts",
  envVar: "ASSEMBLYAI_API_KEY",
  label: "AssemblyAI",
  factory: "assemblyAITts",
  subpath: "tts",
});

/** Kind tag recognised by the host-side resolver. */
export const ASSEMBLYAI_TTS_KIND = ASSEMBLYAI_TTS_PROVIDER.kind;

/** Agent-env variable holding the AssemblyAI API key (same key as STT/LLM). */
export const ASSEMBLYAI_TTS_API_KEY_ENV: string = ASSEMBLYAI_TTS_PROVIDER.envVar;

/**
 * Production streaming-TTS host (US). The service has no global endpoint:
 * https://www.assemblyai.com/docs/tts/endpoints-and-data-zones lists this and
 * {@link ASSEMBLYAI_TTS_EU_HOST}, and nothing else.
 */
export const ASSEMBLYAI_TTS_HOST = "tts.us.assemblyai.com";

/** The EU streaming-TTS host — pass it as `assemblyAITts({ host })` for EU residency. */
export const ASSEMBLYAI_TTS_EU_HOST = "tts.eu.assemblyai.com";

/**
 * The most text one `Generate` frame may carry
 * (https://www.assemblyai.com/docs/tts/message-frames). Consecutive frames are
 * joined with no separator, so a longer text is split across several.
 */
export const ASSEMBLYAI_TTS_MAX_GENERATE_CHARS = 2000;

/**
 * ISO 639-1 code → the `language` query-param value the service accepts.
 *
 * The streaming-TTS endpoint takes the **full lowercase English name**, not a
 * code: `?language=es` is refused with `Bad connection parameters: language:
 * language 'es' not in supported set ['english', 'french', 'german',
 * 'italian', 'portuguese', 'spanish']`. That refusal arrives *in-band* after
 * the socket opens, so an unmapped code doesn't fail the session — it leaves
 * the agent connected, "ready", and permanently mute. Every other language
 * knob in the ecosystem (AssemblyAI STT's `language_codes`, Cartesia) is a
 * code, so the codes are the SDK's contract and this map is the translation.
 *
 * Keys are the six languages every library voice speaks.
 */
export const ASSEMBLYAI_TTS_LANGUAGES = {
  en: "english",
  fr: "french",
  de: "german",
  it: "italian",
  pt: "portuguese",
  es: "spanish",
} as const;

/** ISO 639-1 code for a language AssemblyAI streaming TTS speaks. */
export type AssemblyAITtsLanguage = keyof typeof ASSEMBLYAI_TTS_LANGUAGES;

/**
 * Translate an ISO 639-1 code to the service's `language` value.
 *
 * Returns `undefined` for anything unsupported so callers can fail at connect
 * time. A descriptor reaches the host as unvalidated
 * `Record<string, unknown>` options (`ProviderDescriptorSchema` does not know
 * provider-specific fields), so the type union alone does not keep a bad value
 * off the wire.
 */
export function resolveAssemblyAITtsLanguage(code: string): string | undefined {
  return ASSEMBLYAI_TTS_LANGUAGES[code as AssemblyAITtsLanguage];
}

/** The codes {@link resolveAssemblyAITtsLanguage} accepts, for error messages. */
export function assemblyAITtsLanguageCodes(): string[] {
  return Object.keys(ASSEMBLYAI_TTS_LANGUAGES);
}

/**
 * Reject an AssemblyAI TTS descriptor carrying an unsupported `language`.
 *
 * Run from `toAgentConfig`, which covers every authoring surface: the CLI
 * (`aai dev`, `aai build`, `aai deploy`) and the generated bundle entry, so
 * the studio's `test_agent` reports it as a load error instead of the coding
 * agent shipping an agent that goes mute in production.
 *
 * The type union on `AssemblyAITtsOptions.language` cannot carry this: a
 * descriptor arrives here as `Record<string, unknown>` options from a bundle,
 * and the opener's connect-time throw fires too late to help anyone authoring.
 *
 * Takes `unknown` so callers can pass a possibly-absent descriptor.
 *
 * An unknown VOICE is not this function's: a voice is never refused (see
 * {@link assemblyAIVoiceWarning}), and that warning is computed ONCE, off the
 * descriptor, by `agentConfigWarnings`. A voice has a single spelling —
 * the descriptor's option — so the descriptor the warning reads is the one
 * the author wrote.
 */
export function assertAssemblyAITtsLanguage(tts: unknown): void {
  if (!isRecord(tts)) return;
  const { kind, options } = tts;
  if (kind !== ASSEMBLYAI_TTS_KIND) return;
  if (!isRecord(options)) return;
  const { language } = options;
  if (language === undefined) return;
  if (typeof language !== "string" || resolveAssemblyAITtsLanguage(language) === undefined) {
    throw new Error(
      `AssemblyAI TTS: unsupported language ${JSON.stringify(language)} ` +
        `(supported: ${assemblyAITtsLanguageCodes().join(", ")})`,
    );
  }
}

/**
 * A sentence about a voice this release's catalog does not list, or
 * `undefined` when there is nothing to say.
 *
 * The WARNING half of the argument {@link AssemblyAITtsVoice} makes against an
 * assert. Refusing an unlisted voice would refuse an open-dataset voice, a
 * cloned one, or one AssemblyAI shipped after this release — but saying
 * nothing leaves a TYPO with no signal before the service's `3012` at connect.
 * A line printed by `aai build` and `aai dev` costs a real custom voice one
 * sentence and costs `voice: "aai-michal"` an afternoon less.
 *
 * Reads the TTS descriptor only: the S2S descriptor shares the `"assemblyai"`
 * kind but its voices are the Voice Agent API's, which this catalog does not
 * describe — so a caller hands it `config.tts`, never `config.s2s`.
 *
 * @internal
 */
export function assemblyAIVoiceWarning(descriptor: unknown): string | undefined {
  if (!isRecord(descriptor)) return undefined;
  const { kind, options } = descriptor;
  if (kind !== ASSEMBLYAI_TTS_KIND || !isRecord(options)) return undefined;
  const { voice } = options;
  if (typeof voice !== "string" || voice === "") return undefined;
  if (isCatalogVoice(voice)) return undefined;
  // The catalog is the candidate list; `_nearest-names.ts` knows nothing about
  // voices, which is what keeps that seam one-way. A bare library name
  // (`jane`) is the commonest miss, so it is matched against the slugs too.
  const near = nearestNames(voice, [...ASSEMBLYAI_TTS_VOICES]);
  const bare = `aai-${voice}`;
  const candidates = isCatalogVoice(bare) ? [bare] : near;
  const suggestion =
    candidates.length > 0 ? ` Did you mean ${candidates.map((id) => `"${id}"`).join(", ")}?` : "";
  return `AssemblyAI voice "${voice}" is not one of the library voices.${suggestion} The service refuses an unknown voice_id (3012) when the session opens. Fine if it is your own voice's slug or UUID; otherwise pick one from ASSEMBLYAI_TTS_VOICES (@alexkroman1/aai/tts).`;
}

/** @input */
export interface AssemblyAITtsOptions extends ProviderCredentialOptions {
  /**
   * The `voice_id`: a library slug such as `"aai-jane"`, `"aai-michael"` or
   * `"aai-vera"` (see {@link ASSEMBLYAI_TTS_VOICES}), or any other voice slug or
   * UUID the service knows. Defaults to {@link ASSEMBLYAI_TTS_DEFAULT_VOICE}.
   * Every library voice speaks every supported language.
   */
  voice?: AssemblyAITtsVoice;
  /**
   * Spoken language as an ISO 639-1 code (`"en"`, `"fr"`, `"de"`, `"es"`,
   * `"it"`, `"pt"`). Omitted by default, which the service reads as English.
   * Translated internally to the service's language name; see
   * {@link ASSEMBLYAI_TTS_LANGUAGES} for the supported set. An unsupported
   * code fails at build and connect time rather than muting the session.
   */
  language?: AssemblyAITtsLanguage;
  /**
   * Streaming-TTS host to dial, replacing `ASSEMBLYAI_TTS_HOST` (US). A bare
   * host, not a URL — the adapter owns the `wss://` scheme and the `/v1/ws`
   * path, so a full URL here would be wrong in a way that only shows up at
   * connect.
   *
   * `"tts.eu.assemblyai.com"` is EU residency (`assemblyAIPipeline({ region:
   * "eu" })` sets it). Any other value is a pre-release/staging cluster; one
   * generally issues its own keys, so point every AssemblyAI stage at the same
   * environment or the ones left on production reject the key.
   */
  host?: string;
}

/**
 * Build an AssemblyAI streaming-TTS descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`ASSEMBLYAI_API_KEY`); there is no factory-time key parameter, so the
 * descriptor stays free of secrets and safe to serialize.
 *
 * Named `assemblyAITts` (not `assemblyAI`) so the STT
 * (`assemblyAIStt`), LLM (`llm({ provider: "assemblyai" })`), and TTS factories can be
 * imported side by side without aliasing.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { assemblyAITts } from "@alexkroman1/aai/tts";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   tts: assemblyAITts({ voice: "aai-michael" }),
 * });
 * ```
 *
 * The default pipeline's stage is `assemblyAITts()` — the default voice —
 * so this is how its voice is changed. Pick from {@link ASSEMBLYAI_TTS_VOICES}
 * unless you mean a voice of your own — the service refuses an unknown one when
 * the session opens.
 */
export function assemblyAITts(options: AssemblyAITtsOptions = {}): TtsProvider {
  return describeProvider(ASSEMBLYAI_TTS_PROVIDER, {
    ...options,
    voice: options.voice ?? ASSEMBLYAI_TTS_DEFAULT_VOICE,
  });
}

/**
 * The settings this stage will actually run with — the descriptor's own
 * options with every host-side default filled in. Shared by the opener and
 * the runtime's "Session mode resolved" log.
 *
 * A wrong voice id is refused in band after the upgrade (`3012`), so the
 * resolved voice is worth printing once at startup.
 */
export function resolveAssemblyAITtsSettings(options: AssemblyAITtsOptions): {
  voice: string;
  language?: string;
} {
  return {
    voice: options.voice ?? ASSEMBLYAI_TTS_DEFAULT_VOICE,
    // Omitted unless set: the service's own default (English) applies.
    ...omitUndefined({ language: options.language }),
  };
}
