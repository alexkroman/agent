// Copyright 2026 the AAI authors. MIT license.
/**
 * The two pieces of the AssemblyAI streaming-TTS wire both of its clients
 * build identically: the connect URL, and the `Generate` frames for a text.
 *
 * Shared by the session opener (`assemblyai.ts`) and `stepSpeak`
 * (`step-speak.ts`), which otherwise share nothing — see the latter's module
 * doc for why. Both follow https://www.assemblyai.com/docs/tts:
 *
 * - **URL**: `wss://<host>/v1/ws`, the host being `tts.us.assemblyai.com` or
 *   `tts.eu.assemblyai.com` (there is no global endpoint). Voice is
 *   `voice_id=<slug>` — the old `voice` param is RETIRED (3006 before `Begin`)
 *   and a bare name such as `jane` is not a slug (3012).
 * - **`Generate`** carries at most `ASSEMBLYAI_TTS_MAX_GENERATE_CHARS`, and the
 *   service joins consecutive frames with no separator, so a longer text is cut
 *   anywhere (never inside a surrogate pair) and sent as several.
 */

import {
  ASSEMBLYAI_TTS_HOST,
  ASSEMBLYAI_TTS_MAX_GENERATE_CHARS,
  assemblyAITtsLanguageCodes,
  resolveAssemblyAITtsLanguage,
} from "@alexkroman1/aai/host-internal";

/** What a connect URL is built from. Every field is fixed for the socket's life. */
export interface AssemblyAITtsUrlRequest {
  /** The `voice_id`: a slug (`"aai-jane"`) or a voice UUID. */
  voice: string;
  /** ISO 639-1 code; omitted means the service's default, English. */
  language?: string | undefined;
  sampleRate: number;
  /** Bare host overriding {@link ASSEMBLYAI_TTS_HOST}; empty counts as unset. */
  host?: string | undefined;
}

/**
 * The streaming-TTS connect URL.
 *
 * Throws (through `fail`) on an unsupported language: the service's own
 * refusal arrives in band after the socket opens, which would leave a caller
 * connected and mute rather than failed.
 */
export function assemblyAITtsUrl(
  request: AssemblyAITtsUrlRequest,
  fail: (message: string) => Error,
): string {
  const params = new URLSearchParams({
    voice_id: request.voice,
    sample_rate: String(request.sampleRate),
  });
  if (request.language !== undefined) {
    // The wire wants `spanish`, not `es` — see ASSEMBLYAI_TTS_LANGUAGES.
    const language = resolveAssemblyAITtsLanguage(request.language);
    if (language === undefined) {
      throw fail(
        `unsupported language ${JSON.stringify(request.language)} ` +
          `(supported: ${assemblyAITtsLanguageCodes().join(", ")})`,
      );
    }
    params.set("language", language);
  }
  // Length-checked rather than `??`: an empty `host` is a misconfiguration, and
  // treating it as "unset" beats building `wss:///v1/ws` and failing at connect.
  const host = (request.host?.length ?? 0) > 0 ? request.host : ASSEMBLYAI_TTS_HOST;
  return `wss://${host}/v1/ws?${params.toString()}`;
}

/** `text` as the `Generate` frames that carry it, each within the per-frame cap. */
export function generateFrames(text: string): { type: "Generate"; text: string }[] {
  const frames: { type: "Generate"; text: string }[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + ASSEMBLYAI_TTS_MAX_GENERATE_CHARS, text.length);
    // Never split a surrogate pair: half an emoji in each frame is two
    // invalid strings, and the service would see neither half as text.
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd8_00 && code <= 0xdb_ff) end -= 1;
    frames.push({ type: "Generate", text: text.slice(at, end) });
    at = end;
  }
  return frames;
}
