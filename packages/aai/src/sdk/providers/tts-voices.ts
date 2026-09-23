// Copyright 2026 the AAI authors. MIT license.
/**
 * The AssemblyAI streaming-TTS voice CATALOG: which voices exist, what each
 * speaks, and the lookup by an open voice id.
 *
 * Split out of `tts/assemblyai.ts` under the 500-line cap, along the seam a reader
 * already uses — this is DATA about the service's voices, and that module is
 * the descriptor factory and the connect-time checks that read it.
 * `tts/assemblyai.ts` re-exports every name here, so no import path moved.
 */

import type { AssemblyAITtsLanguage } from "./tts/assemblyai.ts";

/**
 * Default voice when `assemblyAITts()` is called with no `voice` — a
 * US-accented English voice, since most agents face US callers (it was
 * `"vera"` for a while, which put a UK accent on every agent that never
 * chose). Pick from {@link ASSEMBLYAI_TTS_VOICES} to change it; every voice
 * in the catalog speaks exactly one language, so changing `language`
 * generally means changing `voice` too.
 */
export const ASSEMBLYAI_TTS_DEFAULT_VOICE: AssemblyAITtsVoice = "jane";

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
 * The IDS stay literal (the catalog's keys, and the literal half of the open
 * {@link AssemblyAITtsVoice}), because those are the half an author types and
 * the half autocomplete exists for. That is the split: which voices exist is
 * autocomplete, what each one sounds like is data.
 */
export interface AssemblyAITtsVoiceInfo {
  /** ISO 639-1 code of the language this voice speaks. */
  readonly language: AssemblyAITtsLanguage;
  /** Accent tag as the service publishes it, e.g. `"US"`, `"UK"`, `"FR"`. */
  readonly accent: string;
}

/**
 * The voice catalog — voice id → the language it speaks and its accent.
 * The accent is descriptive metadata for choosing a voice, not a settable
 * option: `AssemblyAITtsOptions` has no `accent` field.
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
 * someone guessing, which is the failure being prevented. To look a voice up by
 * a value typed {@link AssemblyAITtsVoice}, use {@link ttsVoiceInfo}.
 *
 * The keys are spelled out in the annotation rather than named as a closed
 * `AssemblyAITtsVoiceId` union: a closed union an author can import is one a
 * catalog refresh breaks, and the open {@link AssemblyAITtsVoice} carries the
 * same literals for autocomplete. `tts-voice-ids.test.ts` holds the two lists
 * equal.
 */
export const ASSEMBLYAI_TTS_VOICES: Readonly<
  Record<
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
    | "estelle",
    AssemblyAITtsVoiceInfo
  >
> = {
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
 * What the catalog records about `voice` — its language and accent — or
 * `undefined` for a voice this release's catalog does not list.
 *
 * The lookup {@link ASSEMBLYAI_TTS_VOICES} cannot do by index: its keys are the
 * catalog's literals while {@link AssemblyAITtsVoice} is open, so indexing it
 * with an author's voice needed a cast — and a cast that also let
 * `"toString"` read `Object.prototype`. An own-key check answers both.
 *
 * @example
 * ```ts
 * import { ttsVoiceInfo } from "@alexkroman1/aai/tts";
 *
 * ttsVoiceInfo("estelle")?.language; // "fr"
 * ttsVoiceInfo("a-voice-shipped-next-week"); // undefined
 * ```
 */
export function ttsVoiceInfo(voice: AssemblyAITtsVoice): AssemblyAITtsVoiceInfo | undefined {
  return Object.hasOwn(ASSEMBLYAI_TTS_VOICES, voice)
    ? ASSEMBLYAI_TTS_VOICES[voice as keyof typeof ASSEMBLYAI_TTS_VOICES]
    : undefined;
}

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
  | "estelle"
  // Still `string`, but being an intersection stops the union collapsing to
  // `string`, which is what keeps the literals above visible at the call site.
  | (string & {});
