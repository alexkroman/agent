// Copyright 2026 the AAI authors. MIT license.
/**
 * The AssemblyAI streaming-TTS voice CATALOG: the library voices an author
 * picks from, as the `voice_id` slugs the service takes.
 *
 * Its own module under the 500-line cap, along the seam a reader already uses —
 * this is DATA about the service's voices, and `tts/assemblyai.ts` is the
 * descriptor factory and the connect-time checks. `tts/assemblyai.ts`
 * re-exports every name here.
 */

/**
 * The AssemblyAI library voices, as the `voice_id` slugs the service takes.
 *
 * Source: https://www.assemblyai.com/docs/tts/voices. **Every one of them speaks
 * all six languages** — `language` picks what a voice speaks, the voice only how
 * it sounds — so there is no voice/language pairing to get wrong.
 *
 * A list rather than a map because a slug is all there is to know about one,
 * and a list is what `z.enum` takes: a form offering the caller a voice is
 * `z.enum(ASSEMBLYAI_TTS_VOICES)`. Typed as a plain array, not a literal
 * tuple, so a voice added to the catalog is not a type change a reader's
 * exhaustive check breaks on.
 *
 * A constant rather than a sentence in a doc comment because a wrong voice id
 * is a refusal the service sends after the upgrade (`3012 voice_not_found`), so
 * nothing at authoring time can tell a typo from a working agent except a list
 * to check it against. The service's own list (`GET /v1/voices`) has thousands
 * of open-dataset voices beside these; any of their slugs, a cloned voice's
 * slug, or a voice UUID is a valid `voice` too.
 */
export const ASSEMBLYAI_TTS_VOICES: readonly AssemblyAITtsVoice[] = [
  "aai-alba",
  "aai-anna",
  "aai-charles",
  "aai-eve",
  "aai-george",
  "aai-jane",
  "aai-jean",
  "aai-mary",
  "aai-michael",
  "aai-paul",
  "aai-vera",
];

/**
 * Default voice when `assemblyAITts()` is called with no `voice` — the
 * service's own default, so leaving it unset and naming it are the same session.
 */
export const ASSEMBLYAI_TTS_DEFAULT_VOICE: AssemblyAITtsVoice = "aai-jane";

/**
 * A `voice_id`: a slug from {@link ASSEMBLYAI_TTS_VOICES}, or any other slug or
 * voice UUID the service knows.
 *
 * The `(string & {})` arm is deliberate: the catalog is the service's, not
 * ours, so a voice added after this release, an open-dataset voice, or the
 * author's own cloned voice must still compile. **So this type is
 * AUTOCOMPLETE, not a guard** — an unlisted voice is warned about at build
 * time (`assemblyAIVoiceWarning`), never refused.
 */
export type AssemblyAITtsVoice =
  | "aai-alba"
  | "aai-anna"
  | "aai-charles"
  | "aai-eve"
  | "aai-george"
  | "aai-jane"
  | "aai-jean"
  | "aai-mary"
  | "aai-michael"
  | "aai-paul"
  | "aai-vera"
  // Still `string`, but being an intersection stops the union collapsing to
  // `string`, which is what keeps the literals above visible at the call site.
  | (string & {});

/** Is `voice` one of the catalog's library voices? */
export function isCatalogVoice(voice: string): boolean {
  return (ASSEMBLYAI_TTS_VOICES as readonly string[]).includes(voice);
}
