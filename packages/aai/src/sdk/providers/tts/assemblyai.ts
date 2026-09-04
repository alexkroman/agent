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
import type { ProviderCredentialOptions, TtsProvider } from "../../providers.ts";

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
 * What the catalog records about one voice: the language it speaks and the
 * accent it speaks with.
 *
 * A named interface rather than an inferred `as const` shape, because the
 * inferred one put every row into the rolled-up `.d.ts` — 16 voices as 64
 * lines of `readonly language: "en"; readonly accent: "US"` — and so into the
 * `aai:tts` contract hash. Re-accenting a voice is a catalog refresh, not an
 * API change, and it was forcing an epoch classification.
 *
 * The IDS stay literal ({@link AssemblyAITtsVoiceId}), because those are the
 * half an author types and the half autocomplete exists for; a voice arriving
 * or leaving really is a change to what may be written. That is the split:
 * which voices exist is contract, what each one sounds like is data.
 */
export interface AssemblyAITtsVoiceInfo {
  /** ISO 639-1 code of the language this voice speaks. */
  readonly language: AssemblyAITtsLanguage;
  /** Accent tag as the service publishes it, e.g. `"US"`, `"UK"`, `"FR"`. */
  readonly accent: string;
}

/**
 * The voice ids this release's catalog carries.
 *
 * Spelled out rather than derived with `keyof typeof`, so that annotating the
 * map below does not cost the literals — see {@link AssemblyAITtsVoiceInfo}.
 */
export type AssemblyAITtsVoiceId =
  | "alba"
  | "anna"
  | "charles"
  | "eve"
  | "george"
  | "jane"
  | "jean"
  | "mary"
  | "michael"
  | "paul"
  | "vera"
  | "giovanni"
  | "lola"
  | "juergen"
  | "rafael"
  | "estelle";

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
export const ASSEMBLYAI_TTS_VOICES: Readonly<Record<AssemblyAITtsVoiceId, AssemblyAITtsVoiceInfo>> =
  {
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
  };

/**
 * Voices the service still accepts but has scheduled for removal.
 *
 * Listed so that "is this name real?" and "should I use it?" stay separate
 * questions — an existing agent naming one of these is working today and
 * should not be told it is broken, while a new agent should not be pointed
 * at a voice that is going away.
 *
 * Not published to authors: the answer to "should I use it?" is
 * {@link ASSEMBLYAI_TTS_VOICES}, which lists only what to pick. This tuple's
 * one reader is the template gate that checks no shipped template names a
 * retired voice, so it lives on `@alexkroman1/aai/host-internal` — its 21
 * literals were otherwise inlined into the published `.d.ts` for nobody.
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
 *
 * **So this type is AUTOCOMPLETE, not a guard, and there is no runtime assert
 * to pair with it** the way `assertAssemblyAITtsLanguage` pairs with
 * {@link AssemblyAITtsLanguage}. The two are not the same job: the language
 * map is a TRANSLATION this SDK owns (an ISO code the service has never heard
 * of, rendered as a name it accepts), so a code outside it cannot be sent at
 * all and rejecting it is a fact about this package. The voice catalog is the
 * SERVICE's, and a snapshot of it goes stale between releases — an assert
 * would refuse a voice AssemblyAI shipped last week, which is the same
 * silent-mute failure from the other side. Read the catalog; do not expect the
 * compiler to check you did.
 */
export type AssemblyAITtsVoice =
  | AssemblyAITtsVoiceId
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
  const { language, voice } = options;
  if (language === undefined) return;
  if (typeof language !== "string" || resolveAssemblyAITtsLanguage(language) === undefined) {
    throw new Error(
      `AssemblyAI TTS: unsupported language ${JSON.stringify(language)} ` +
        `(supported: ${assemblyAITtsLanguageCodes().join(", ")})`,
    );
  }
  assertVoiceSpeaks(language, voice);
}

/**
 * Reject a `language` the chosen voice does not speak.
 *
 * The same failure as an unmapped code, from the other side: every voice in the
 * catalog speaks exactly ONE language, so `{ voice: "estelle", language: "en" }`
 * is refused in-band after the socket opens and the agent is connected, ready
 * and mute. Checked here for the reason the code is — this is the last layer
 * that sees it while somebody is still authoring.
 *
 * **Two things keep this from becoming the assert the voice catalog
 * deliberately does NOT have** (see {@link AssemblyAITtsVoice}): a voice the
 * catalog does not list is passed through untouched, so a voice AssemblyAI ships
 * after this release still compiles and still runs; and a descriptor with no
 * `language` is never consulted, which is the overwhelmingly common shape (the
 * server infers the language from the voice).
 *
 * It also catches the pair the SDK itself used to manufacture:
 * `assemblyAITts({ language: "fr" })` fills in the default voice, which speaks
 * English — so asking for French, and nothing else, produced a silent agent.
 */
function assertVoiceSpeaks(language: string, voice: unknown): void {
  if (typeof voice !== "string") return;
  const known = ASSEMBLYAI_TTS_VOICES[voice as keyof typeof ASSEMBLYAI_TTS_VOICES];
  if (known === undefined || known.language === language) return;
  const speakers = Object.entries(ASSEMBLYAI_TTS_VOICES)
    .filter(([, meta]) => meta.language === language)
    .map(([id]) => id);
  throw new Error(
    `AssemblyAI TTS: voice "${voice}" speaks ${known.language}, not the declared language "${language}" — ` +
      "a mismatch is refused after the socket opens, which leaves the agent ready and silent. " +
      `Voices that speak "${language}": ${speakers.join(", ")}.`,
  );
}

/**
 * A sentence about a voice this release's catalog does not list, or
 * `undefined` when there is nothing to say.
 *
 * The WARNING half of the argument {@link AssemblyAITtsVoice} makes against an
 * assert. Refusing an unlisted voice would refuse one AssemblyAI shipped after
 * this release, which is the same silent mute from the other side — but saying
 * nothing at all leaves the commonest version of that failure, a TYPO, with no
 * signal anywhere: the agent connects, reports ready, and never speaks. A line
 * printed by `aai build` and `aai dev` costs a new voice one sentence and costs
 * `voice: "michal"` an afternoon less.
 *
 * A deprecated voice gets its own line: it works today, so "unknown" would be
 * wrong, and it is going away, so silence would be too.
 *
 * Takes the DESCRIPTOR rather than the id, so a caller can hand it any stage
 * (the AssemblyAI S2S descriptor carries a `voice` from the same catalog) and
 * anything that is not one is simply not warned about.
 *
 * @internal
 */
export function assemblyAIVoiceWarning(descriptor: unknown): string | undefined {
  if (!isRecord(descriptor)) return undefined;
  const { kind, options } = descriptor;
  if (kind !== ASSEMBLYAI_TTS_KIND || !isRecord(options)) return undefined;
  const { voice } = options;
  if (typeof voice !== "string" || voice === "") return undefined;
  if (voice in ASSEMBLYAI_TTS_VOICES) return undefined;
  const deprecated: readonly string[] = ASSEMBLYAI_TTS_DEPRECATED_VOICES;
  if (deprecated.includes(voice)) {
    return `AssemblyAI voice "${voice}" still works but is scheduled for removal — pick a current one from ASSEMBLYAI_TTS_VOICES (@alexkroman1/aai/tts).`;
  }
  return `AssemblyAI voice "${voice}" is not in this release's catalog. If it is a typo the agent will connect, report ready and never speak — the service refuses an unknown voice after the socket opens. Check it against ASSEMBLYAI_TTS_VOICES (@alexkroman1/aai/tts); a voice added since this release is fine.`;
}

export interface AssemblyAITtsOptions extends ProviderCredentialOptions {
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
}

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
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { assemblyAITts } from "@alexkroman1/aai/tts";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   tts: assemblyAITts({ voice: "michael" }),
 * });
 * ```
 *
 * On the default pipeline `agent({ voice: "michael" })` is the shorthand
 * for exactly this. Voice ids come from {@link ASSEMBLYAI_TTS_VOICES} and
 * nowhere else — an unrecognised one leaves an agent that connects,
 * reports ready and never speaks.
 */
export function assemblyAITts(opts: AssemblyAITtsOptions = {}): TtsProvider {
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
