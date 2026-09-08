// Copyright 2026 the AAI authors. MIT license.
/**
 * The one transcription request, and its classification.
 *
 * No directive, so it sits under `workflows/` untransformed and is called FROM a
 * step, inheriting its environment. It is its own module for the same reason
 * `transcription-workflow` has one: `stepTranscribeSync` is the SDK's — the URL,
 * the raw-key auth (no `Bearer`, which is a 401 that reads like a wrong key), the
 * multipart shape, the deadline and the three-way failure verdict all live there —
 * so what is left at the call site is the classification that hands the verdict to
 * the DevKit, and that belongs somewhere a spec can reach it.
 */

import type { TranscribeSyncOptions } from "@alexkroman1/aai/step";
import { stepTranscribeSyncOrFail } from "@alexkroman1/aai/step-errors";

/**
 * Transcribe one complete WAV.
 *
 * `bytes` must be a whole file, header included — the endpoint decodes each
 * request independently, so a headerless span is bytes it will refuse. This desk
 * stores headerless PCM on purpose (see `media.ts`) and puts a header back with
 * `encodeWav` for exactly this call.
 *
 * `stepTranscribeSyncOrFail` — the SDK's own `stepTranscribeSync` plus
 * `throwStepError`, and nothing else — is the whole of what this adds, and it is
 * where the three-way call is made: a `FatalError` stops the DevKit retrying something that
 * will answer the same way, a bare `RetryableError` retries in ONE SECOND (that
 * class's own default), and a `RetryableError` carrying `retryAfter` waits exactly
 * as long as the far side asked. The last matters here because a whole fan-out
 * hits a rate limit together — a second later all of them ask again, where on the
 * server's number they drain.
 *
 * **The two strings are an OPTIONS bag rather than two parameters, and they are
 * the SDK's own.** `filename` and `label` are both strings, both describe the
 * same piece of audio, and swapping them is silent — the request still succeeds,
 * and the only symptom is a failure message naming `segment-3.wav` and a
 * multipart part named `Segment 3 (1:50)`. Naming them at the call site removes
 * the hazard, and taking the SDK's own {@link TranscribeSyncOptions} rather than
 * a shape of this template's own means the day this desk wants a `timeoutMs` or
 * a `model` it widens the `Pick` instead of re-declaring the bag.
 *
 * @param options.label - How this piece is named in a failure. The CALLER's
 *   vocabulary (a segment's timestamp), because it is what a reader of the log
 *   has in front of them.
 */
export async function transcribeSpan(
  bytes: Uint8Array,
  options: Required<Pick<TranscribeSyncOptions, "filename" | "label">>,
): Promise<string> {
  const { text } = await stepTranscribeSyncOrFail(bytes, options);
  return text;
}
