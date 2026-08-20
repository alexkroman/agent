// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 19.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are relative.
 *
 * What epoch 19 added is the pair a step that SPEAKS and STORES needs: a
 * synthesizer to fill the speech slot (`stubSpeech`), and a WRITABLE upload
 * store (`stubUploads(files, { writable: true })`). The write half is opt-in
 * deliberately — a store that silently accepted writes could not fail a spec
 * whose step stored a file nobody meant it to.
 */

import {
  STUB_SPEECH_PCM_BYTES,
  type StubSpeech,
  type StubSpeechCall,
  type StubSpeechOptions,
  stubSpeech,
  type StubUploadsOptions,
  stubUploads,
} from "../../../sdk/testing.ts";

/** One second of silence at the default rate, for a spec that asserts a duration. */
const ONE_SECOND: StubSpeechOptions = { pcmBytes: 48_000 };

/** The default, named so a spec can say what it expected without repeating it. */
export const DEFAULT_PCM: number = STUB_SPEECH_PCM_BYTES;

/** Fill both slots a speak-and-store step reaches through, and hand back the log. */
export function installAudioSlots(): { speech: StubSpeech; restore: () => void } {
  const writable: StubUploadsOptions = { writable: true, idPrefix: "upl_test_" };
  const releaseUploads = stubUploads({ upl_in: new Uint8Array([1, 2, 3]) }, writable);
  const speech = stubSpeech(ONE_SECOND);
  return {
    speech,
    restore: () => {
      speech.restore();
      releaseUploads();
    },
  };
}

/** What the step asked to say, which is what a spec asserts on. */
export function spokenText(speech: StubSpeech): string[] {
  return speech.calls.map((call: StubSpeechCall) => call.text);
}

/** A provider that ANSWERED and refused — a different branch from an absent one. */
export function installRefusingSpeech(): StubSpeech {
  return stubSpeech({ error: new Error("voice not found") });
}
