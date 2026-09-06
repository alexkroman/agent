// Copyright 2026 the AAI authors. MIT license.
/**
 * The voice catalog as a LIST an author can put in a schema.
 *
 * `ASSEMBLYAI_TTS_VOICES` is a map, because "which language does `estelle`
 * speak?" is what the runtime asks of it. A form that offers the caller a voice
 * asks the other question — "which voices speak English?" — and wants the
 * answer as the non-empty tuple `z.enum` takes. Two templates derived it
 * byte-for-byte (`Object.entries(...).filter(...).map(...)`, then a
 * destructure with a default to satisfy the tuple), which is the third copy
 * rule's trigger one copy early: the destructure-with-default is the part that
 * looks like a cast and is not, and it should be written once.
 *
 * Its own module rather than a line in `assemblyai.ts`, which is 400 lines of
 * catalog and connect-time checks; this is the one AUTHORING read over it.
 *
 * @module tts-voice-ids
 */

import {
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  ASSEMBLYAI_TTS_VOICES,
  type AssemblyAITtsLanguage,
  type AssemblyAITtsVoice,
} from "./tts/assemblyai.ts";

/**
 * The catalog's voice ids, optionally only those speaking `language`, as the
 * non-empty tuple a `z.enum` takes.
 *
 * Read from {@link ASSEMBLYAI_TTS_VOICES} rather than listed, because a wrong
 * voice id is a SILENT failure — a free-form string the service rejects in band
 * after the socket is open, so the synthesis simply produces nothing. Every
 * voice speaks exactly one language, so a run whose text is in one language
 * offers only the voices that speak it.
 *
 * **An empty filter falls back to the default voice** rather than throwing or
 * returning `[]`: the tuple has to have a head for `z.enum`, and a form that
 * cannot render a picker is worse than one offering the SDK's own default. The
 * fallback is reachable only when the catalog carries no voice for a language
 * the SDK translates, which is a catalog refresh away from impossible; it is
 * documented because the type promises a head.
 *
 * Catalog order — the order an author reads on the docs page.
 *
 * @example
 * ```ts
 * import { ttsVoiceIds } from "@alexkroman1/aai/tts";
 * import { z } from "zod";
 *
 * const input = z.object({
 *   voice: z.enum(ttsVoiceIds("en")).optional().describe("Voice to read it in"),
 * });
 * ```
 *
 * @public
 */
export function ttsVoiceIds(
  language?: AssemblyAITtsLanguage,
): [AssemblyAITtsVoice, ...AssemblyAITtsVoice[]] {
  const ids = Object.entries(ASSEMBLYAI_TTS_VOICES)
    .filter(([, info]) => language === undefined || info.language === language)
    .map(([id]) => id);
  // Destructured rather than cast: a `.map` produces an array, and the default
  // on the head is what makes the tuple honest when the filter matched nothing.
  const [first = ASSEMBLYAI_TTS_DEFAULT_VOICE, ...rest] = ids;
  return [first, ...rest];
}
