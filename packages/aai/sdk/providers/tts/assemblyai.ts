// Copyright 2026 the AAI authors. MIT license.
/**
 * AssemblyAI streaming TTS factory — returns a pure descriptor.
 *
 * See `sdk/providers/stt/assemblyai.ts` for the descriptor/opener split; the
 * host-side resolver in `host/providers/resolve.ts` turns this into an
 * openable `TtsOpener` during `createRuntime` using the `ASSEMBLYAI_API_KEY`
 * from the agent's env — the same key AssemblyAI STT and the LLM Gateway use,
 * so a full AssemblyAI pipeline needs exactly one secret.
 *
 * Note: this factory shares its name with the STT factory in
 * `@alexkroman1/aai/stt` and the LLM factory in `@alexkroman1/aai/llm`. When
 * using more than one, alias on import:
 *
 * ```ts
 * import { assemblyAI } from "@alexkroman1/aai/stt";
 * import { assemblyAI as assemblyAILlm } from "@alexkroman1/aai/llm";
 * import { assemblyAI as assemblyAITts } from "@alexkroman1/aai/tts";
 * ```
 */

import type { TtsProvider } from "../../providers.ts";

export const ASSEMBLYAI_TTS_KIND = "assemblyai" as const;

/** Agent-env variable holding the AssemblyAI API key (same key as STT/LLM). */
export const ASSEMBLYAI_TTS_API_KEY_ENV = "ASSEMBLYAI_API_KEY";

/** Production streaming-TTS host. */
export const ASSEMBLYAI_TTS_HOST = "streaming-tts.assemblyai.com";

/**
 * Default voice when `assemblyAI()` is called with no `voice`. Every voice in
 * the catalog speaks exactly one language, so changing `language` generally
 * means changing `voice` too.
 */
export const ASSEMBLYAI_TTS_DEFAULT_VOICE = "vera";

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
 * Keys are the six languages the voice catalog covers.
 */
export const ASSEMBLYAI_TTS_LANGUAGES = {
  en: "english",
  fr: "french",
  de: "german",
  it: "italian",
  pt: "portuguese",
  es: "spanish",
} as const;

/** ISO 639-1 code for a language the AssemblyAI voice catalog speaks. */
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
 * Shared by `parseManifest` and `toAgentConfig` — the same two-call-site shape
 * as {@link assertTextOnlyTuning}. Both matter for *where the author sees the
 * error*: `parseManifest` covers the CLI (`aai dev`, `aai build`, `aai deploy`)
 * and `toAgentConfig` runs inside the generated bundle entry, so the studio's
 * `test_agent` reports it as a load error instead of the coding agent shipping
 * an agent that goes mute in production.
 *
 * The type union on `AssemblyAITtsOptions.language` cannot carry this: a
 * descriptor arrives here as `Record<string, unknown>` options from a bundle,
 * and the opener's connect-time throw fires too late to help anyone authoring.
 *
 * Takes `unknown` so callers can pass a possibly-absent descriptor.
 */
export function assertAssemblyAITtsLanguage(tts: unknown): void {
  if (typeof tts !== "object" || tts === null) return;
  const { kind, options } = tts as { kind?: unknown; options?: unknown };
  if (kind !== ASSEMBLYAI_TTS_KIND) return;
  if (typeof options !== "object" || options === null) return;
  const { language } = options as { language?: unknown };
  if (language === undefined) return;
  if (typeof language === "string" && resolveAssemblyAITtsLanguage(language) !== undefined) return;
  throw new Error(
    `AssemblyAI TTS: unsupported language ${JSON.stringify(language)} ` +
      `(supported: ${assemblyAITtsLanguageCodes().join(", ")})`,
  );
}

export interface AssemblyAITtsOptions {
  /**
   * Voice id, e.g. `"vera"`, `"michael"`, `"alba"`. Defaults to
   * {@link ASSEMBLYAI_TTS_DEFAULT_VOICE}. Each voice speaks one language:
   * English voices include `alba`, `anna`, `azelma`, `bill_boerst`,
   * `caro_davy`, `charles`, `cosette`, `eponine`, `eve`, `fantine`, `george`,
   * `jane`, `javert`, `jean`, `marius`, `mary`, `michael`, `paul`,
   * `peter_yearsley`, `stuart_bell`, `vera`; non-English are `estelle` (fr),
   * `giovanni` (it), `juergen` (de), `lola` (es), `rafael` (pt).
   */
  voice?: string;
  /**
   * Spoken language as an ISO 639-1 code (`"en"`, `"fr"`, `"de"`, `"es"`,
   * `"it"`, `"pt"`). Omitted by default so the server infers it from the
   * voice — set it only alongside a voice that speaks it. Translated to the
   * name the service wants by {@link resolveAssemblyAITtsLanguage}; an
   * unsupported code fails at connect time rather than muting the session.
   */
  language?: AssemblyAITtsLanguage;
}

export type AssemblyAITtsProvider = TtsProvider & {
  readonly kind: typeof ASSEMBLYAI_TTS_KIND;
  readonly options: AssemblyAITtsOptions & { voice: string };
};

export function assemblyAI(opts: AssemblyAITtsOptions = {}): AssemblyAITtsProvider {
  return {
    kind: ASSEMBLYAI_TTS_KIND,
    options: { ...opts, voice: opts.voice ?? ASSEMBLYAI_TTS_DEFAULT_VOICE },
  };
}
