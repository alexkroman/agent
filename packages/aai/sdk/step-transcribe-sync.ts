// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepTranscribeSync()` — one complete audio file in, its text out.
 *
 * The other endpoint. `step-transcribe.ts` submits a JOB and polls it, which is
 * the only thing that works for a recording of arbitrary length; this is a
 * single request that answers with the words, and it is the better call
 * whenever the audio fits inside the endpoint's ceiling.
 *
 * ## The ceiling is the whole decision
 *
 * **120 seconds and 40 MB per request**, both enforced by the service. Under
 * it, this is one round trip against the async API's four steps and a polling
 * loop — no job id, nothing to journal between phases, no wait to make durable.
 * Over it, the audio has to be CUT into segments and fanned out, which is a
 * whole subject of its own: where to cut so a word is not split, how to
 * re-attach a header to each piece, how wide to run the fan-out, and how to
 * stitch the results back together. `transcription-workflow` is the template
 * that shows that three ways and measures them.
 *
 * So the rule is: reach for this when one request is enough, and for the async
 * API when it is not. The cut is not something this module can make for a
 * caller, because it depends on what the audio IS.
 *
 * ## Whole files only, header included
 *
 * The endpoint decodes each request independently, so a headerless tail is
 * bytes it will refuse. A caller cutting a WAV therefore re-attaches a header
 * to every window — {@link encodeWav} is the 44 bytes — and a caller handed
 * complete files (parts of a multi-file upload, {@link stepSpeak}'s output)
 * passes them through untouched.
 *
 * A LIST is a whole file too, and that is the shape a fan-out wants: a window
 * plus the {@link wavHeader} written for it is two chunks, and joining them
 * first only means holding the segment twice while the multipart body is built
 * around it. The bytes on the wire are identical either way.
 *
 * ```ts
 * import { throwStepError } from "@alexkroman1/aai/step-errors";
 * import { readUpload, stepTranscribeSync } from "@alexkroman1/aai/step";
 *
 * export async function transcribeClip(uploadId: string) {
 *   const clip = await readUpload(uploadId);
 *   const { text } = await stepTranscribeSync(clip.bytes).catch(throwStepError);
 *   return text;
 * }
 * ```
 *
 * @module step-transcribe-sync
 */

import {
  type TranscribeRequestOptions,
  transcribeFailure,
  transcribeKey,
  transcribeSignal,
} from "./_transcribe-shared.ts";
import { multipartBody, stepFetch } from "./step-fetch.ts";

/** The synchronous endpoint. Global — it routes to the nearest region. */
export const TRANSCRIBE_SYNC_ENDPOINT = "https://sync.assemblyai.com/transcribe";

/** Required on every sync request; the endpoint routes on it. */
export const TRANSCRIBE_SYNC_MODEL = "universal-3-5-pro";

/**
 * The endpoint's own per-request deadline, plus room to upload.
 *
 * Longer than the async API's default because the audio and the transcription
 * share one request here: the far side is doing the work while this waits,
 * where a submit merely queues it.
 */
export const TRANSCRIBE_SYNC_TIMEOUT_MS = 60_000;

/** What {@link stepTranscribeSync} accepts. */
export type TranscribeSyncOptions = TranscribeRequestOptions & {
  /**
   * Model to route to. Defaults to {@link TRANSCRIBE_SYNC_MODEL}.
   *
   * Singular and a header rather than a body field — this endpoint's shape, not
   * the async API's, and the two are deliberately not unified here because
   * unifying them would mean inventing a name for something the service has two
   * different names for.
   */
  model?: string | undefined;
  /**
   * Filename to declare in the multipart part. Defaults to `"audio.wav"`.
   *
   * The endpoint reads the CONTENT, so this is for the service's logs and for a
   * failure that names something a reader recognises — a segment's timestamp, a
   * part's index — rather than for routing.
   */
  filename?: string | undefined;
  /**
   * Content type of the part. Defaults to `"audio/wav"`.
   *
   * Worth setting for anything that is not linear PCM in a WAV container; the
   * endpoint accepts the common encodings and decodes on what it is told.
   */
  type?: string | undefined;
  /**
   * How this piece is named in a failure message. Defaults to `filename`.
   *
   * The CALLER's vocabulary, because a fan-out's log is read by someone holding
   * segment numbers rather than filenames.
   */
  label?: string | undefined;
};

/**
 * Transcribe one complete audio file.
 *
 * **From a step, prefer `stepTranscribeSyncClassified` (`@alexkroman1/aai/step-errors`).**
 * It is this call plus `throwStepError`, and the engine decides its retry policy
 * from WHICH error a step throws: raw, a terminal failure burns every remaining
 * attempt and a rate limit backs off for one second while the delay the far side
 * named sits unread. Reach for the raw call where the failure is not simply a
 * failure — a `404` that means "already deleted".
 *
 * @param bytes - A whole file, header included. The endpoint decodes each
 *   request independently, so a headerless tail is bytes it will refuse. A LIST
 *   is still a whole file — the same bytes in the same order, just not
 *   contiguous in memory — which is what lets a caller cutting a WAV hand over
 *   `[wavHeader(format, window.byteLength), window]` rather than joining the two
 *   into a buffer this function would then copy into the body a second time.
 *
 * @returns The text, trimmed. An EMPTY string is a legitimate answer here and
 *   is not refused, unlike the async API's: a caller fanning out over segments
 *   routinely gets silent ones, and a throw would fail the whole recording over
 *   a pause in it. A caller transcribing exactly one clip should check for it.
 *
 * @throws {TranscribeError} on a refusal, carrying the verdict `toStepError`
 *   reads — which matters most here, because a fan-out hits a rate limit all at
 *   once and `retryAfter` is what makes the batch drain instead of colliding a
 *   second later.
 *
 * @remarks
 * **The ceiling is the whole decision: 120 seconds and 40 MB per request**, both
 * enforced by the service. Under it, this is one round trip against
 * {@link stepTranscribeUpload}/{@link stepTranscribeSubmit}/{@link
 * stepTranscribePoll}'s three steps and a polling loop — no job id, nothing to
 * journal between phases, no wait to make durable. Over it, the audio has to be
 * CUT into segments and fanned out, which is a subject of its own: where to cut
 * so a word is not split, how to re-attach a header to each piece, how wide to
 * run the fan-out, and how to stitch the results back together. So reach for
 * this when one request is enough and for the async trio when it is not; the cut
 * is not a decision this function can make, because it depends on what the audio
 * IS.
 *
 * **Whole files only.** A caller cutting a WAV re-attaches a header to every
 * window — {@link encodeWav} is the 44 bytes, or {@link wavHeader} and the
 * window as two chunks — and a caller handed complete files (parts of a
 * multi-file upload, {@link stepSpeak}'s output) passes them through untouched.
 *
 * @example
 * One clip, one request. Compare {@link stepTranscribeSubmit} for a recording
 * that cannot fit in one.
 * ```ts
 * import { readUpload, stepTranscribeSync } from "@alexkroman1/aai/step";
 *
 * export async function transcribeClip(uploadId: string): Promise<string> {
 *   const clip = await readUpload(uploadId);
 *   const { text } = await stepTranscribeSync(clip.bytes);
 *   return text;
 * }
 * ```
 *
 * @public
 */
export async function stepTranscribeSync(
  bytes: Uint8Array | readonly Uint8Array[],
  opts: TranscribeSyncOptions = {},
): Promise<{ text: string }> {
  const filename = opts.filename ?? "audio.wav";
  const part = multipartBody({
    name: "audio",
    filename,
    type: opts.type ?? "audio/wav",
    bytes,
  });

  // `stepFetch`, not `fetch`, and here it is load-bearing rather than tidy:
  // `fetch` speaks HTTP/2 wherever the far side offers it, which puts a whole
  // batch of segments on ONE connection — and a capacity limit then arrives as
  // a stream reset carrying no HTTP status to classify. A fan-out is exactly
  // the shape that breaks on; `sdk/step-fetch.ts` holds the measurements.
  const response = await stepFetch(TRANSCRIBE_SYNC_ENDPOINT, {
    method: "POST",
    headers: {
      // The raw key — this endpoint takes it unprefixed, and a `Bearer ` in
      // front of it is a 401 that reads like a wrong key.
      Authorization: transcribeKey(opts),
      "X-AAI-Model": opts.model ?? TRANSCRIBE_SYNC_MODEL,
      ...part.headers,
    },
    body: part.body,
    signal: transcribeSignal({ ...opts, timeoutMs: opts.timeoutMs ?? TRANSCRIBE_SYNC_TIMEOUT_MS }),
  });
  if (!response.ok) throw await transcribeFailure(response, opts.label ?? filename);

  const body = (await response.json()) as { text?: string };
  return { text: (body.text ?? "").trim() };
}
