// Copyright 2026 the AAI authors. MIT license.
/**
 * The dictation recorder: the microphone captured into one clip, handed back
 * as a WAV file for a transcription endpoint to read whole.
 *
 * A clip, not a stream — the dictation API takes the whole utterance in one
 * request — so this is the pre-connect capture (`audio/preconnect.ts`) used
 * for what it already does: buffer the mic at a known rate. Stopping is its
 * `detach` (the worklet's tail flush lands in the buffer, so the last word is
 * kept) and then `close`, which turns the browser's recording indicator off.
 *
 * @module
 */

import { encodeWav } from "@alexkroman1/aai/step";
import { openPreConnectCapture } from "./preconnect.ts";

/** One recording in progress. Every method is safe to call after another. */
export type DictationRecorder = {
  /** The rate the clip is recorded at. */
  readonly sampleRate: number;
  /**
   * Stop, release the microphone, and answer the clip as a mono 16-bit WAV.
   * An empty clip (stopped before the first batch) is a 44-byte header.
   */
  stop(): Promise<Uint8Array<ArrayBuffer>>;
  /** Stop and release the microphone, keeping nothing. Never rejects. */
  cancel(): Promise<void>;
};

/**
 * Ask for the microphone and start recording.
 *
 * Rejects like the session's own capture does — a denied prompt, a rate the
 * browser refused — with the microphone released.
 */
export async function openDictationRecorder(opts: {
  sampleRate: number;
  /** The capture buffer's bound; the caller stops the clip by then. */
  maxSeconds: number;
  captureWorkletSrc: string;
}): Promise<DictationRecorder> {
  const capture = await openPreConnectCapture(opts);
  let done = false;
  return {
    sampleRate: capture.sampleRate,
    async stop() {
      if (done) return encodeWav([], { sampleRate: capture.sampleRate });
      done = true;
      try {
        const { chunks, sampleRate } = await capture.detach();
        return encodeWav(
          chunks.map((c) => new Uint8Array(c)),
          { sampleRate },
        );
      } finally {
        await capture.close();
      }
    },
    async cancel() {
      if (done) return;
      done = true;
      await capture.close().catch(() => {
        /* best-effort: nothing is kept either way */
      });
    },
  };
}
