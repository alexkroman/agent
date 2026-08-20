// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:utils` epoch 11.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are relative.
 *
 * What epoch 11 added is a step that SPEAKS: `stepSpeak`, plus the WAV framing
 * (`encodeWav`, `pcmDurationMs`, `WAV_HEADER_BYTES`) that turns raw PCM into
 * something a browser will play. It is the counterpart of `stepGenerate` — a
 * step is handed no `ToolContext`, so the provider stack that knows how to
 * reach a service and what credential to present is not in scope — and it is
 * deliberately the smaller thing: one call in, all the audio out, because a
 * step has no turn to be part of and has to return a value.
 *
 * The `"use step"` directives are inert here — nothing compiles this through the
 * Workflow DevKit's builder — which is the point: what is frozen is the way an author
 * WRITES against this surface, and the only thing this must keep doing is compile.
 */

import {
  encodeWav,
  type PcmFormat,
  pcmDurationMs,
  type SpeakOptions,
  type SpokenAudio,
  STEP_SPEAK_SAMPLE_RATE,
  STEP_SPEAK_TIMEOUT_MS,
  stepSpeak,
  WAV_HEADER_BYTES,
} from "../../../sdk/utils.ts";

/** What a narration step reports. */
export type Narration = {
  /** The whole `.wav`, header included. */
  wav: Uint8Array;
  /** How long it lasts. */
  ms: number;
};

/** The default rate, named rather than repeated — a caller may lower it. */
export const RATE: number = STEP_SPEAK_SAMPLE_RATE;

/** The deadline the SDK applies on its own, for a caller that wants to report it. */
export const DEADLINE_MS: number = STEP_SPEAK_TIMEOUT_MS;

/** Speak one script, and hand back the file plus its duration. */
export async function narrate(script: string, opts: SpeakOptions = {}): Promise<Narration> {
  "use step";

  const spoken: SpokenAudio = await stepSpeak(script, opts);
  return { wav: spoken.audio, ms: spoken.durationMs };
}

/**
 * Several utterances, framed ONCE.
 *
 * The reason `SpokenAudio` carries `pcm` beside `audio`: joining the WAVs would
 * splice a 44-byte header into the middle of the samples, so a caller
 * concatenating utterances joins the PCM and encodes the result.
 */
export async function narrateAll(scripts: string[]): Promise<Narration> {
  "use step";

  const parts: Uint8Array[] = [];
  for (const script of scripts) parts.push((await stepSpeak(script)).pcm);
  const format: PcmFormat = { sampleRate: RATE };
  const wav = encodeWav(parts, format);
  return { wav, ms: pcmDurationMs(wav.length - WAV_HEADER_BYTES, format) };
}
