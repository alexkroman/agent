// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepSpeak()` — turning text into audio from inside a step.
 *
 * The counterpart of {@link stepGenerate}, and it exists for the same reason:
 * a step is handed no `ToolContext`, so the session's whole provider stack —
 * the thing that knows how to reach a TTS service and what credential to
 * present — is not in scope. `stepGenerate` closed that for the model.
 * This closes it for the voice.
 *
 * ```ts
 * import { requireStepEnv, stepSpeak } from "@alexkroman1/aai/step";
 *
 * export async function narrate(summary: string) {
 *   const spoken = await stepSpeak(summary, { voice: "jane" });
 *   return { wav: spoken.audio, seconds: spoken.durationMs / 1000 };
 * }
 * ```
 *
 * ## Why a workflow wants this at all
 *
 * A voice AGENT speaks inside a turn: the words exist because somebody is on
 * the line waiting for them, and the audio is worthless a second later. A
 * WORKFLOW's audio is the opposite — a summary read aloud, a digest for a
 * commute, a callback recorded for someone who is not there — and it is a
 * FILE, produced once and played whenever. Nothing on the session surface can
 * produce one: `TtsSession` is an event stream wired into a live pipeline's
 * playback, with a turn tracker and barge-in behind it, and a step has no turn
 * to be part of.
 *
 * So this is deliberately the smaller thing. One call in, all the audio out,
 * no events and no lifecycle — which is what makes it usable from a step at
 * all, since a step that returns has to return a VALUE.
 *
 * ## It is a published slot, like `stepFetch`
 *
 * For exactly the reason that module gives: the synthesizer needs a WebSocket
 * client, this module is on the CLI's zero-dependency startup path and rides
 * the browser bundle, and the agent bundle carries its own copy of this file —
 * so the publisher and the reader are two module instances in one realm.
 * `createRuntimeServer` publishes; `host/step-speak.ts` is the published half.
 *
 * Unlike `stepFetch` there is NO global fallback, because there is no global
 * synthesizer to fall back to. An unpublished slot therefore fails with a
 * sentence naming both causes — a process serving no agent, and a spec calling
 * the step directly — the way `stepReadUpload` does. A spec supplies its own with
 * `stubSpeech` from `@alexkroman1/aai/testing`.
 *
 * ## The WAV framing is HERE, and the PCM is the provider's
 *
 * A synthesizer answers raw linear PCM, because that is what every streaming
 * TTS service actually sends and framing it per provider would be the same 44
 * bytes written N times. {@link encodeWav} puts the container on, so
 * `stepSpeak` hands back something a browser will play, a bucket will serve
 * and a transcription API will accept — and `pcm` rides along for a caller
 * that is going to concatenate several utterances before framing them once.
 *
 * @module step-speak
 */

import {
  ASSEMBLYAI_TTS_API_KEY_ENV,
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
} from "./providers/tts/assemblyai.ts";
import { requireStepEnv } from "./step-env.ts";
import { encodeWav, pcmDurationMs } from "./wav.ts";

/** Sample rate {@link stepSpeak} asks for when a caller names none. */
export const STEP_SPEAK_SAMPLE_RATE = 24_000;

/**
 * How long one {@link stepSpeak} call may take before it is abandoned.
 *
 * Generous, and sized for the JOB rather than for a round trip: synthesis runs
 * at a multiple of real time, so a long digest is legitimately tens of
 * seconds. What it is really there to bound is the failure this endpoint
 * actually has — a socket that opens, accepts the text and then says nothing,
 * which without a deadline is a step that hangs until the run's own budget
 * runs out with nothing anywhere naming the cause.
 */
export const STEP_SPEAK_TIMEOUT_MS = 120_000;

/** What {@link stepSpeak} accepts. */
export type SpeakOptions = {
  /**
   * Voice id, e.g. `"jane"`, `"michael"`, `"vera"`. Defaults to
   * `ASSEMBLYAI_TTS_DEFAULT_VOICE`; the catalog is `ASSEMBLYAI_TTS_VOICES` on
   * `@alexkroman1/aai/tts`, and every voice speaks exactly one language.
   */
  voice?: string | undefined;
  /**
   * Spoken language as an ISO 639-1 code (`"en"`, `"fr"`, `"de"`, `"es"`,
   * `"it"`, `"pt"`). Omitted by default so the service infers it from the
   * voice — set it only alongside a voice that speaks it.
   */
  language?: string | undefined;
  /**
   * Samples per second to synthesize at. Defaults to
   * {@link STEP_SPEAK_SAMPLE_RATE}.
   *
   * Worth lowering only when the audio is going somewhere that resamples it
   * anyway (a phone line is 8 kHz), since the file scales linearly with it.
   */
  sampleRate?: number | undefined;
  /**
   * Env var holding the credential, replacing `ASSEMBLYAI_API_KEY`.
   *
   * Names a VARIABLE, not a key — the same contract every provider descriptor
   * keeps, so nothing here can end up in a journaled step argument.
   */
  apiKeyEnv?: string | undefined;
  /**
   * Abort the synthesis. Combined with {@link STEP_SPEAK_TIMEOUT_MS} rather
   * than replacing it, so a caller passing one still cannot hang forever.
   */
  signal?: AbortSignal | undefined;
};

/** What {@link stepSpeak} resolves with. */
export type SpokenAudio = {
  /**
   * A complete `.wav` file — the container a browser, a bucket and a
   * transcription API all accept.
   */
  audio: Uint8Array<ArrayBuffer>;
  /**
   * The same samples WITHOUT the header, for a caller joining several
   * utterances and framing them once.
   */
  pcm: Uint8Array;
  /** Samples per second the audio was synthesized at. */
  sampleRate: number;
  /** How long it lasts. Derived from the byte count, not claimed by the service. */
  durationMs: number;
  /** The voice that actually spoke, with the default filled in. */
  voice: string;
};

/**
 * What a host publishes: text in, raw linear PCM16 out.
 *
 * Narrower than {@link SpeakOptions} on purpose — the credential is resolved
 * by the SDK half from the agent's own env and handed over, so a host
 * implementation holds no policy about where a key comes from.
 *
 * @internal
 */
export type SpeechSynthesizer = (request: {
  text: string;
  apiKey: string;
  voice: string;
  language?: string | undefined;
  sampleRate: number;
  signal: AbortSignal;
}) => Promise<Uint8Array>;

/** The registry-wide slot — see the module doc for why it is not a module-level `let`. */
const STEP_SPEAK_SLOT = Symbol.for("@alexkroman1/aai.speechSynthesizer");

/** The shape stored in the slot. `undefined` means nothing has published. */
type StepSpeakSlot = { [STEP_SPEAK_SLOT]?: SpeechSynthesizer };

/**
 * Publish the speech synthesizer for this process's steps.
 *
 * `createRuntimeServer` does this, which is what makes {@link stepSpeak} behave
 * identically under `aai dev`, on a self-hosted server and in a deployed
 * guest. Pass `undefined` to unpublish.
 *
 * @internal — a host concern, exported from `@alexkroman1/aai-runtime`. A step
 * author calls {@link stepSpeak}.
 */
export function publishSpeechSynthesizer(synthesizer: SpeechSynthesizer | undefined): void {
  if (synthesizer === undefined) delete (globalThis as StepSpeakSlot)[STEP_SPEAK_SLOT];
  else (globalThis as StepSpeakSlot)[STEP_SPEAK_SLOT] = synthesizer;
}

/**
 * The sentence a step gets when no synthesizer was published.
 *
 * Names both causes, because they are not distinguishable from here: a process
 * that serves no agent at all (a bare script), and a spec that called the step
 * directly. Same shape and same reasoning as `UPLOADS_UNAVAILABLE_MESSAGE`.
 *
 * @internal
 */
export const SPEECH_UNAVAILABLE_MESSAGE =
  "No speech synthesizer in this process. Speech is served by `createRuntimeServer`, which every " +
  "deployed agent, every self-hosted server and `aai dev` go through. In a test, publish a " +
  "synthesizer of your own with `stubSpeech` from `@alexkroman1/aai/testing`.";

/**
 * Speak `text`, and answer with the whole utterance as a WAV.
 *
 * @param text - What to say. Refused when it is blank: a synthesizer answers
 *   an empty request with an empty file, which is a zero-length audio element
 *   on somebody's page rather than an error, and no retry finds the missing
 *   words.
 *
 * @throws {Error} when no synthesizer is published — the message names both
 *   causes (a process serving no agent, and a spec calling the step directly).
 * @throws {Error} when the credential named by `apiKeyEnv` is not in the
 *   agent's env, which `requireStepEnv` reports by name.
 *
 * @example
 * Speak and STORE in one step, and return the id. A step is journaled by what
 * it returns, so an id is replayed on a resume and bytes are not — splitting
 * this in two would carry the audio across the queue on every resume.
 * ```ts
 * import { stepSpeak, stepWriteUpload } from "@alexkroman1/aai/step";
 *
 * export async function narrate(summary: string): Promise<string> {
 *   const spoken = await stepSpeak(summary, { voice: "jane" });
 *   const stored = await stepWriteUpload(spoken.audio, {
 *     name: "summary.wav",
 *     type: "audio/wav",
 *   });
 *   return stored.id;
 * }
 * ```
 *
 * @public
 */
export async function stepSpeak(text: string, options: SpeakOptions = {}): Promise<SpokenAudio> {
  const spoken = text.trim();
  if (spoken.length === 0) {
    throw new Error("stepSpeak: nothing to say — `text` is empty.");
  }
  const synthesizer = (globalThis as StepSpeakSlot)[STEP_SPEAK_SLOT];
  if (!synthesizer) throw new Error(SPEECH_UNAVAILABLE_MESSAGE);

  const sampleRate = options.sampleRate ?? STEP_SPEAK_SAMPLE_RATE;
  const voice = options.voice ?? ASSEMBLYAI_TTS_DEFAULT_VOICE;
  // Combined rather than either/or: a caller's signal cancels sooner, and the
  // deadline still bounds a caller that passed none — or one whose own signal
  // never fires. Sources are held weakly, so there is no unlink bookkeeping.
  const deadline = AbortSignal.timeout(STEP_SPEAK_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

  const pcm = await synthesizer({
    text: spoken,
    apiKey: requireStepEnv(options.apiKeyEnv ?? ASSEMBLYAI_TTS_API_KEY_ENV),
    voice,
    language: options.language,
    sampleRate,
    signal,
  });

  return {
    audio: encodeWav(pcm, { sampleRate }),
    pcm,
    sampleRate,
    durationMs: pcmDurationMs(pcm.length, { sampleRate }),
    voice,
  };
}
