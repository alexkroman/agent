// Copyright 2026 the AAI authors. MIT license.
/**
 * `stubSpeech` — a synthesizer a spec supplies, so a step that SPEAKS is
 * testable without a socket.
 *
 * The counterpart of `stubGateway` for `stepGenerate`, and it exists for the
 * same reason: `stepSpeak` reaches a provider through a published slot, so a
 * spec fills the slot rather than intercepting anything. Nothing about the
 * step under test changes.
 *
 * Its own module rather than another function inside `testing.ts` for the
 * reason the gateway and generate stubs have theirs: each of these is a fake
 * plus the shape of its own call log, and the parent module is the assembly
 * point.
 *
 * @example
 * ```ts no-check
 * // `no-check`: the step under test is in another file, and the assertion is
 * // the runner's — which is the point of the fake being framework-agnostic.
 * import { stubSpeech } from "@alexkroman1/aai/testing";
 *
 * const speech = stubSpeech();
 * await narrate("Three findings.");
 * expect(speech.calls[0]?.text).toContain("Three findings");
 * speech.restore();
 * ```
 *
 * @module testing-speech
 */

import { publishSpeechSynthesizer } from "./step-speak.ts";

/** One `stepSpeak` call, as {@link stubSpeech} records it. */
export type StubSpeechCall = {
  /** The text handed to the synthesizer, trimmed the way `stepSpeak` trims it. */
  text: string;
  /** The credential `stepSpeak` resolved out of the step env. */
  apiKey: string;
  /** The voice, with `stepSpeak`'s default already filled in. */
  voice: string;
  /** The language code, or `undefined` when the caller named none. */
  language: string | undefined;
  /** The rate the audio was asked for at. */
  sampleRate: number;
};

/** What {@link stubSpeech} may be told. */
export type StubSpeechOptions = {
  /**
   * Bytes of PCM to answer with, per call.
   *
   * Defaults to {@link STUB_SPEECH_PCM_BYTES}, which is enough that the WAV
   * `stepSpeak` frames has a plausible duration and a spec asserting on one
   * gets a number rather than zero. A caller that cares about the exact
   * duration sets this: at the default 24 kHz mono 16-bit, one second is
   * 48,000 bytes.
   */
  pcmBytes?: number | undefined;
  /**
   * Fail instead of speaking, with this error.
   *
   * The half a spec cannot write by leaving the slot empty: an unpublished
   * slot is "no synthesizer here", which is a different sentence and a
   * different branch from a provider that answered and refused.
   */
  error?: Error | undefined;
};

/** PCM bytes {@link stubSpeech} answers with when no size is named — ~0.25s at 24 kHz. */
export const STUB_SPEECH_PCM_BYTES = 12_000;

/** What {@link stubSpeech} returns: the call log, and how to put the slot back. */
export type StubSpeech = {
  /** Every call, in order. */
  calls: StubSpeechCall[];
  /**
   * Unpublish the synthesizer.
   *
   * Calling it in an `afterEach` is not optional — a stub left published makes
   * the next file's steps speak into this one's log, which is the kind of
   * cross-file leak that presents as a passing test somewhere else.
   */
  restore(): void;
};

/**
 * Publish a synthesizer that records what it was asked to say and answers with
 * silence.
 *
 * Silence rather than a tone, because nothing downstream of a step listens: a
 * spec asserts on the TEXT that was spoken, the duration, and where the bytes
 * went. Generating audible audio would only make the fixtures bigger.
 *
 * @public
 */
export function stubSpeech(options: StubSpeechOptions = {}): StubSpeech {
  const calls: StubSpeechCall[] = [];
  publishSpeechSynthesizer((request) => {
    calls.push({
      text: request.text,
      apiKey: request.apiKey,
      voice: request.voice,
      language: request.language,
      sampleRate: request.sampleRate,
    });
    if (options.error) return Promise.reject(options.error);
    // Even, always: PCM16 is two bytes a sample, and an odd length is a
    // half-sample the encoder would frame into a file whose last sample is
    // garbage.
    const bytes = Math.max(0, Math.floor((options.pcmBytes ?? STUB_SPEECH_PCM_BYTES) / 2) * 2);
    return Promise.resolve(new Uint8Array(bytes));
  });
  return { calls, restore: () => publishSpeechSynthesizer(undefined) };
}
