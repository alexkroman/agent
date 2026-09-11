// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:stt` epoch 1.
 *
 * Epoch 2 gave `AssemblyAISttOptions` three optional fields — `keyterms`
 * (recognition biasing toward a domain's own vocabulary), `agentContext` (what
 * the application already knows about the call) and `formatTurns` (whether a
 * committed turn is punctuated, cased and inverse-text-normalized). All three
 * are optional and none changes what an unset descriptor dials, which is what
 * this file pins: every stage below is written the way an epoch-1 author wrote
 * it, and the AssemblyAI one names none of the three.
 *
 * That is the whole promise. If a later epoch obliges a keyterm list, or
 * changes the shape of any option an epoch-1 author was already passing, this
 * file reddens — the signal to DROP the epoch rather than to edit the example.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 1's 11 exports.** The gate requires it
 * (`api-contracts-gate.test.ts`): a fixture that names one signature freezes
 * one signature, while every other name in the epoch compiles because nothing
 * mentions it.
 *
 * **Its specifiers are RELATIVE.** Importing the package by name would
 * resolve through its own `exports` map to whatever the current build
 * publishes, so the fixture would prove the CURRENT surface compiles rather
 * than that epoch 1's does.
 *
 * @module
 */

import type {
  AssemblyAISttOptions,
  DeepgramSttOptions,
  ElevenLabsSttOptions,
  SonioxSttOptions,
  SttProvider,
} from "../../../sdk/providers/stt-barrel.ts";
import {
  ASSEMBLYAI_STT_EU_URL,
  assemblyAIStt,
  DEEPGRAM_DEFAULT_ENDPOINTING_MS,
  deepgramStt,
  elevenLabsStt,
  sonioxStt,
} from "../../../sdk/providers/stt-barrel.ts";

/**
 * The AssemblyAI stage as an epoch-1 author wrote it: a model, a pinned
 * language, the endpointing pair and the Voice Focus knobs — and nothing
 * about keyterms, agent context or turn formatting, none of which existed.
 */
export const stt: SttProvider = assemblyAIStt({
  model: "universal-3-5-pro",
  languages: ["en"],
  minTurnSilenceMs: 1600,
  maxTurnSilenceMs: 3000,
  voiceFocus: "near-field",
  voiceFocusThreshold: 0.9,
  connectTimeoutMs: 2500,
  maxConnectRetries: 2,
});

/** EU residency, the two ways an epoch-1 author could ask for it. */
export const euByRegion: SttProvider = assemblyAIStt({ region: "eu" });
export const euByUrl: SttProvider = assemblyAIStt({ streamingUrl: ASSEMBLYAI_STT_EU_URL });

/** The other three vendors, each with the options it takes. */
export const deepgram: SttProvider = deepgramStt({
  model: "nova-3",
  language: "en",
  endpointing: DEEPGRAM_DEFAULT_ENDPOINTING_MS,
});
export const eleven: SttProvider = elevenLabsStt({ model: "scribe_v2_realtime" });
export const soniox: SttProvider = sonioxStt({ model: "stt-rt-v3" });

// ── The rest of epoch 1's promised surface.

export type Epoch1Types = {
  assemblyAI: AssemblyAISttOptions;
  deepgram: DeepgramSttOptions;
  elevenLabs: ElevenLabsSttOptions;
  soniox: SonioxSttOptions;
  provider: SttProvider;
};
