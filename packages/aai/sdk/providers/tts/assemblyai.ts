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
 * The three AssemblyAI stage factories have distinct names
 * (`assemblyAIStt`, `assemblyAILlm`, `assemblyAITts`), so they can be
 * imported side by side:
 *
 * ```ts
 * import { assemblyAIStt } from "@alexkroman1/aai/stt";
 * import { assemblyAILlm } from "@alexkroman1/aai/llm";
 * import { assemblyAITts } from "@alexkroman1/aai/tts";
 * ```
 */

import { isRecord } from "../../is-record.ts";
import { omitUndefined } from "../../omit-undefined.ts";
import type { TtsProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const ASSEMBLYAI_TTS_KIND = "assemblyai" as const;

/** Agent-env variable holding the AssemblyAI API key (same key as STT/LLM). */
export const ASSEMBLYAI_TTS_API_KEY_ENV = "ASSEMBLYAI_API_KEY";

/** Production streaming-TTS host. */
export const ASSEMBLYAI_TTS_HOST = "streaming-tts.assemblyai.com";

/**
 * Default voice when `assemblyAITts()` is called with no `voice` — a
 * US-accented English voice, since most agents face US callers (it was
 * `"vera"` for a while, which put a UK accent on every agent that never
 * chose). Pick from {@link ASSEMBLYAI_TTS_VOICES} to change it; every voice
 * in the catalog speaks exactly one language, so changing `language`
 * generally means changing `voice` too.
 */
export const ASSEMBLYAI_TTS_DEFAULT_VOICE = "jane";

/**
 * The voice catalog — voice id → the language it speaks and its accent.
 * The accent is descriptive metadata for choosing a voice, not a settable
 * option: {@link AssemblyAITtsOptions} has no `accent` field.
 *
 * A constant rather than a sentence in a doc comment, because a wrong voice
 * id is a *silent* failure: it is a free-form string the service rejects
 * in-band after the socket opens, so the agent connects, reports ready, and
 * never speaks — the same shape as the unmapped-`language` bug below, and
 * nothing upstream of a live session catches it.
 *
 * It is a constant for a second reason, learned the hard way. The list this
 * replaced lived in a doc comment and was simply wrong — it carried ten names
 * (`azelma`, `cosette`, `fantine`, `javert`, `marius`, `peter_yearsley` …)
 * that are in no published catalog, while omitting most of the real ones. A
 * list nobody can check drifts into fiction, and here the fiction is
 * indistinguishable, at authoring time, from a working agent.
 *
 * Source: https://assemblyai.com/docs/voice-agents/voice-agent-api/voices
 *
 * Anything that shows an author their choices — the scaffold guide, a picker
 * — should read this rather than restate it. A partial list is what sends
 * someone guessing, which is the failure being prevented.
 */
export const ASSEMBLYAI_TTS_VOICES = {
  alba: { language: "en", accent: "US" },
  anna: { language: "en", accent: "US" },
  charles: { language: "en", accent: "US" },
  eve: { language: "en", accent: "US" },
  george: { language: "en", accent: "US" },
  jane: { language: "en", accent: "US" },
  jean: { language: "en", accent: "US" },
  mary: { language: "en", accent: "US" },
  michael: { language: "en", accent: "US" },
  paul: { language: "en", accent: "UK" },
  vera: { language: "en", accent: "UK" },
  giovanni: { language: "it", accent: "IT" },
  lola: { language: "es", accent: "ES" },
  juergen: { language: "de", accent: "DE" },
  rafael: { language: "pt", accent: "PT" },
  estelle: { language: "fr", accent: "FR" },
} as const satisfies Record<string, { language: string; accent: string }>;

/**
 * Voices the service still accepts but has scheduled for removal.
 *
 * Listed so that "is this name real?" and "should I use it?" stay separate
 * questions — an existing agent naming one of these is working today and
 * should not be told it is broken, while a new agent should not be pointed
 * at a voice that is going away.
 */
export const ASSEMBLYAI_TTS_DEPRECATED_VOICES = [
  "arjun",
  "bella",
  "david",
  "diego",
  "dmitri",
  "eleanor",
  "emma",
  "giulia",
  "helen",
  "ivy",
  "james",
  "kyle",
  "luca",
  "lucia",
  "martha",
  "mateo",
  "pierre",
  "river",
  "tyler",
  "victor",
  "winter",
] as const;

/**
 * A voice id from {@link ASSEMBLYAI_TTS_VOICES}.
 *
 * The `(string & {})` arm is deliberate: the catalog is the service's, not
 * ours, so a voice added after this release must still compile, and so must
 * a deprecated one an existing agent already names. It keeps the current
 * names visible at the call site without turning a stale SDK into a build
 * failure.
 */
export type AssemblyAITtsVoice =
  | keyof typeof ASSEMBLYAI_TTS_VOICES
  // `string & Record<never, never>` is the `string & {}` trick without the
  // banned empty-object type: it is still `string`, but being an
  // intersection stops the union collapsing to `string`, which is what keeps
  // the literals above visible at the call site.
  | (string & Record<never, never>);

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
 */
export function assertAssemblyAITtsLanguage(tts: unknown): void {
  if (!isRecord(tts)) return;
  const { kind, options } = tts;
  if (kind !== ASSEMBLYAI_TTS_KIND) return;
  if (!isRecord(options)) return;
  const { language } = options;
  if (language === undefined) return;
  if (typeof language === "string" && resolveAssemblyAITtsLanguage(language) !== undefined) return;
  throw new Error(
    `AssemblyAI TTS: unsupported language ${JSON.stringify(language)} ` +
      `(supported: ${assemblyAITtsLanguageCodes().join(", ")})`,
  );
}

export interface AssemblyAITtsOptions {
  /**
   * Voice id, e.g. `"jane"`, `"michael"`, `"vera"`. Defaults to
   * {@link ASSEMBLYAI_TTS_DEFAULT_VOICE}. Each voice speaks exactly one
   * language — see {@link ASSEMBLYAI_TTS_VOICES} for the catalog.
   */
  voice?: AssemblyAITtsVoice;
  /**
   * Spoken language as an ISO 639-1 code (`"en"`, `"fr"`, `"de"`, `"es"`,
   * `"it"`, `"pt"`). Omitted by default so the server infers it from the
   * voice — set it only alongside a voice that speaks it. Translated
   * internally to the service's language name; see
   * {@link ASSEMBLYAI_TTS_LANGUAGES} for the supported set. An unsupported
   * code fails at connect time rather than muting the session.
   */
  language?: AssemblyAITtsLanguage;
  /**
   * Streaming-TTS host to dial, replacing the production `ASSEMBLYAI_TTS_HOST`. A bare
   * host (`streaming-tts.sandbox000.assemblyai-labs.com`), not a URL — the
   * adapter owns the `wss://` scheme and the `/v1/ws/` path, so a full URL here
   * would be wrong in a way that only shows up at connect.
   *
   * Intended for pre-release/staging clusters, and it is the TTS half of the
   * same A/B `assemblyAIStt({ streamingUrl })` gives STT. A staging cluster
   * generally issues its own keys, so point every AssemblyAI stage at the same
   * environment or the ones left on production reject the key. Leave unset in
   * production.
   */
  host?: string;
  /**
   * Env var holding this stage's credential, replacing the provider default
   * (`ASSEMBLYAI_API_KEY`). Names a VARIABLE, not a key, so the descriptor
   * stays secret-free and safe to serialize.
   *
   * For running one stage against a different account or cluster than the
   * others — AssemblyAI keys are environment-scoped, so a staging STT cluster
   * rejects a production key and vice versa, and a mixed setup needs both keys
   * live at once. The variable must be present in the agent's env (`.env` or
   * `aai secret put`), like any other credential.
   */
  apiKeyEnv?: string;
}

/** Descriptor returned by {@link assemblyAITts}. */
export type AssemblyAITtsProvider = TtsProvider & {
  readonly kind: typeof ASSEMBLYAI_TTS_KIND;
  readonly options: AssemblyAITtsOptions & { voice: string };
};

/**
 * Build an AssemblyAI streaming-TTS descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`ASSEMBLYAI_API_KEY`); there is no factory-time key parameter, so the
 * descriptor stays free of secrets and safe to serialize.
 *
 * Named `assemblyAITts` (not `assemblyAI`) so the STT
 * (`assemblyAIStt`), LLM (`assemblyAILlm`), and TTS factories can be
 * imported side by side without aliasing.
 */
export function assemblyAITts(opts: AssemblyAITtsOptions = {}): AssemblyAITtsProvider {
  return {
    kind: ASSEMBLYAI_TTS_KIND,
    options: { ...opts, voice: opts.voice ?? ASSEMBLYAI_TTS_DEFAULT_VOICE },
  };
}

/**
 * The settings this stage will actually run with — the descriptor's own
 * options with every host-side default filled in. Shared by the opener and
 * the runtime's "Session mode resolved" log.
 *
 * A wrong voice id is rejected IN BAND after the socket opens, so the agent
 * reports ready and is permanently silent — which is exactly the failure that
 * wants the resolved voice printed once at startup.
 */
export function resolveAssemblyAITtsSettings(opts: AssemblyAITtsOptions): {
  voice: string;
  language?: string;
} {
  return {
    voice: opts.voice ?? ASSEMBLYAI_TTS_DEFAULT_VOICE,
    // Omitted unless set: every voice speaks one language, so the server
    // infers it, and a mismatched pair is worse than no hint.
    ...omitUndefined({ language: opts.language }),
  };
}
