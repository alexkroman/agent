// Copyright 2026 the AAI authors. MIT license.
/**
 * Text-only "TTS" — a sentinel descriptor that turns synthesis off.
 *
 * `tts: none()` keeps the all-or-nothing pipeline rule intact (`stt`, `llm`,
 * and `tts` must still be set together, so an accidentally omitted provider
 * stays a loud config error) while declaring, explicitly, that this agent
 * replies in text: the STT → LLM half of the pipeline runs unchanged, no TTS
 * provider is opened, no TTS credential is required, and no audio is sent to
 * the client. The browser client renders streamed text replies instead.
 *
 * Unlike every other TTS kind there is no host-side opener — the pipeline
 * transport runs with a null TTS session, which it already tolerates.
 */

import type { TtsProvider } from "../../providers.ts";

export const NONE_TTS_KIND = "none" as const;

export type NoneTtsProvider = TtsProvider & {
  readonly kind: typeof NONE_TTS_KIND;
  readonly options: Record<string, never>;
};

/** Declare a text-only agent: speech in (STT → LLM), text out, no synthesis. */
export function none(): NoneTtsProvider {
  return { kind: NONE_TTS_KIND, options: {} };
}

/** Whether a TTS descriptor is the text-only sentinel. Null-safe. */
export function isTextOnlyTts(tts: unknown): boolean {
  return (
    typeof tts === "object" && tts !== null && (tts as { kind?: unknown }).kind === NONE_TTS_KIND
  );
}
