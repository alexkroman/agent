// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:transcribe` epoch 1.
 *
 * The leg every workflow that handles audio starts with, written both ways this
 * capability offers: the one-request SYNC endpoint for a clip a step already
 * holds in memory, and the async job API — upload, submit, poll — for the
 * recording that has to be streamed out of the store first. Written the way it
 * was authored at epoch 1, and it must keep compiling for as long as that epoch
 * is advertised as supported.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * Epoch 2 WIDENED `stepTranscribeSync`'s first parameter, from `Uint8Array` to
 * `Uint8Array | readonly Uint8Array[]`, so a caller holding a WAV header and the
 * samples it describes — or a clip it read window by window — can hand them over
 * as they are instead of joining them into a second full copy of the audio
 * first.
 *
 * **A widened PARAMETER cannot break a CALLER, and a caller is all this file
 * is.** It accepts everything it used to accept, so {@link transcribeClip}
 * below passes one `Uint8Array` and produces the same request on the wire at
 * epoch 2 as it did at epoch 1: the parts are concatenated into the body in
 * order, which is indistinguishable from the same content passed whole. Nothing
 * here has to change and nothing here may. That is what makes this a retain
 * rather than a drop.
 *
 * The mirror image is worth naming because it is the case that is NOT safe: the
 * same widening applied to a RETURN would hand every existing caller a union
 * where it had a buffer. This capability returns text, ids and a
 * {@link Transcript}, so the change could not reach one.
 *
 * **The direction that WOULD break this file is a narrowing, or a SHAPE.** Every
 * function below is invoked and none is implemented, so a narrowed parameter or
 * a second required argument reddens here. So does the quieter half:
 * {@link TranscribeProgress} losing its discriminant, {@link Transcript} losing
 * `durationMs`, or `TranscribeError` ceasing to carry `retryable` — the last of
 * which compiles for a while and costs a run its whole attempt budget on a file
 * that will not transcribe on any attempt.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 1 has to be dropped with a reason.
 */

import {
  stepTranscribePoll,
  stepTranscribeSubmit,
  stepTranscribeSync,
  stepTranscribeUpload,
  TRANSCRIBE_API,
  TRANSCRIBE_MODELS,
  TRANSCRIBE_SYNC_ENDPOINT,
  TRANSCRIBE_SYNC_MODEL,
  TRANSCRIBE_SYNC_TIMEOUT_MS,
  TRANSCRIBE_TIMEOUT_MS,
  TRANSCRIBE_UPLOAD_TIMEOUT_MS,
  TRANSCRIBE_WINDOW_BYTES,
  TranscribeError,
  type TranscribeProgress,
  type TranscribeRequestOptions,
  type TranscribeSubmitOptions,
  type TranscribeSyncOptions,
  type Transcript,
} from "../../../sdk/step-barrel.ts";

/**
 * ── EDIT: which route a recording takes. ─────────────────────────────────
 *
 * One upload window, which is the only unit this capability already names for
 * the question "is this one request or many". Under it the async route costs a
 * submit and at least one poll to learn something the sync endpoint would have
 * answered in the request that carried the bytes; over it the recording is not
 * a value a step should be holding at all.
 */
export function isClip(sizeBytes: number): boolean {
  return sizeBytes <= TRANSCRIBE_WINDOW_BYTES;
}

/**
 * What this recording will cost before anything is spent on it.
 *
 * A step's own deadline has to be at least the sum of the deadlines of the calls
 * it makes, and every one of those is on this contract — which is the reason the
 * budgets are exported rather than being private defaults. Getting it wrong is
 * quiet in the worst way: a step whose budget is under the upload's cancels a
 * transfer that was going fine, at whatever fraction of the file it had reached.
 *
 * `windows` is the same arithmetic for the upload leg — how many store round
 * trips the recording streams out in — which is what makes a progress line
 * mean something before the first byte moves.
 *
 * @param polls - How many polls to budget for. The job's own queue time, which
 *   this cannot know; the point is that the number is the CALLER's estimate and
 *   the per-call deadline is not.
 */
export function plan(
  sizeBytes: number,
  polls: number,
): {
  route: string;
  windows: number;
  budgetMs: number;
} {
  if (isClip(sizeBytes)) {
    return { route: TRANSCRIBE_SYNC_ENDPOINT, windows: 1, budgetMs: TRANSCRIBE_SYNC_TIMEOUT_MS };
  }
  return {
    // The host the recording is sent to, recorded because "where did this audio
    // go" is a question a compliance review asks about a run months later and
    // the answer is not otherwise anywhere in the journal.
    route: TRANSCRIBE_API,
    windows: Math.ceil(sizeBytes / TRANSCRIBE_WINDOW_BYTES),
    budgetMs: TRANSCRIBE_UPLOAD_TIMEOUT_MS + TRANSCRIBE_TIMEOUT_MS * (1 + polls),
  };
}

/**
 * The sync route: bytes in, text out, one request.
 *
 * `model` is a header on this endpoint rather than a body field, and singular
 * rather than the async API's list — the two shapes are deliberately not
 * unified, because unifying them would mean inventing a name for something the
 * service has two different names for.
 *
 * `label` is the CALLER's vocabulary and is what a failure is reported under.
 * That matters exactly when a fan-out is running: the person reading the run
 * holds segment numbers, not filenames, and a message naming `audio.wav` twelve
 * times says nothing about which twelve seconds of the call went wrong.
 *
 * One buffer, because a clip a step already holds IS one buffer.
 */
export async function transcribeClip(bytes: Uint8Array, label: string): Promise<string> {
  const opts: TranscribeSyncOptions = {
    model: TRANSCRIBE_SYNC_MODEL,
    filename: `${label}.wav`,
    type: "audio/wav",
    label,
    timeoutMs: TRANSCRIBE_SYNC_TIMEOUT_MS,
  };
  const { text } = await stepTranscribeSync(bytes, opts);
  return text;
}

/**
 * The async route's first leg, and the one worth its own step.
 *
 * Upload and submit are separate calls because a retry must not repeat the file:
 * the upload is the expensive half — its budget is a function of the recording
 * rather than of the service, which is why it has one of its own — and the
 * submit that follows is a JSON round trip that either queued a job or did not.
 * A step that did both would re-send a two-hour recording to recover from a
 * refused create.
 */
export async function uploadRecording(uploadId: string): Promise<string> {
  const opts: TranscribeRequestOptions = { timeoutMs: TRANSCRIBE_UPLOAD_TIMEOUT_MS };
  const { audioUrl } = await stepTranscribeUpload(uploadId, opts);
  return audioUrl;
}

/**
 * Queue the job.
 *
 * `models` is passed explicitly even though it is the default, because this is
 * the field a run's result is only reproducible against: a transcript is the
 * model's, and a step that let the default move under it would compare two runs
 * that were never asking the same question.
 *
 * `params` is merged into the create body VERBATIM and nothing here interprets
 * it. That is the seam this capability deliberately leaves open — the async API
 * grows fields faster than a wrapper mirroring them could keep up, and the two
 * this call sets from its own arguments cannot be overridden there, so the two
 * ways to say the same thing cannot disagree.
 */
export async function submitRecording(audioUrl: string): Promise<string> {
  const opts: TranscribeSubmitOptions = {
    models: TRANSCRIBE_MODELS,
    params: { speaker_labels: true },
    timeoutMs: TRANSCRIBE_TIMEOUT_MS,
  };
  const { id } = await stepTranscribeSubmit(audioUrl, opts);
  return id;
}

/**
 * Ask the job where it has got to.
 *
 * A poll that ANSWERS is not a poll that succeeded — an unfinished job comes
 * back as progress and only a transport or API failure rejects — so this returns
 * the union rather than a transcript, and {@link finished} is where the two
 * cases are told apart.
 */
export async function pollJob(id: string): Promise<TranscribeProgress> {
  return await stepTranscribePoll(id, { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
}

/**
 * The transcript, or nothing yet.
 *
 * The discriminant is what makes this one line: a caller that checks `done` has
 * the transcript without a second narrowing, and one that forgets cannot read
 * `undefined` text. `durationMs` comes from the PROVIDER's own measurement of
 * the recording rather than from a byte count — it decoded the file and this
 * step did not — which is what makes it the number to report.
 */
export function finished(progress: TranscribeProgress): Transcript | undefined {
  return progress.done ? progress.transcript : undefined;
}

/**
 * Is this failure one the provider has already decided is final?
 *
 * The SDK does not choose fatal-versus-retryable for a caller, and this is what
 * it hands over instead: a recording with no speech in it and a container the
 * service will not read both arrive with `retryable: false`, and asking again
 * cannot change either answer. A fan-out reads this to drop the one segment and
 * keep the rest, which is the difference between an audit with a gap in it and
 * no audit at all.
 *
 * `status` is carried separately because it is absent when the failure never got
 * one — a transport error rather than a refusal — and a body that inferred the
 * verdict from a status would be inferring it from a number that is not there.
 */
export function isProviderRefusal(failure: unknown): failure is TranscribeError {
  return failure instanceof TranscribeError && !failure.retryable;
}
