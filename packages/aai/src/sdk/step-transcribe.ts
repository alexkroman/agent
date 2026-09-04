// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepTranscribe*()` — turning a recording into text from inside a
 * step.
 *
 * The counterpart of {@link stepSpeak}, and the other half of a workflow's
 * round trip: that one makes audio out of words, this one makes words out of
 * audio. It exists for the same reason — a step is handed no `ToolContext`, so
 * the session's provider stack is not in scope — but the shape is different in
 * one way that decides this whole module, and it is worth stating before the
 * API rather than after it.
 *
 * ## Why this is FOUR calls and `stepSpeak` is one
 *
 * Synthesis is a request: text in, audio out, seconds later. Transcription of a
 * two-hour recording is a JOB — submitted, worked on elsewhere, collected — and
 * a step that waited for one would be a step holding its process open for an
 * hour, journaling nothing, and starting over from the upload after a crash.
 *
 * The durable shape is a body that calls a step per phase and `ctx.sleep`s
 * between polls, and **the SDK cannot own that body**: durability comes from the
 * `ctx.step` a body wraps a call in, and this package is handed no `ctx`. A
 * function exported from here is an ordinary async call — no journal, no retry —
 * until a body puts it inside a step, and nothing says so at the call site.
 * Every step in this repository is a user's.
 *
 * So the division is: **the caller owns the four steps and the loop, this owns
 * everything inside them.** That is the same division `stepGenerate` and
 * `stepFetch` already keep.
 *
 * ```ts
 * import type { WorkflowContext } from "@alexkroman1/aai/workflow-api";
 * import { throwStepError } from "@alexkroman1/aai/step-errors";
 * import { stepTranscribePoll, stepTranscribeSubmit, stepTranscribeUpload } from "@alexkroman1/aai/step";
 *
 * export async function transcribe(input: { recording: string }, ctx: WorkflowContext) {
 *   const { audioUrl } = await ctx.step("upload", () =>
 *     stepTranscribeUpload(input.recording).catch(throwStepError),
 *   );
 *   const { id } = await ctx.step("submit", () =>
 *     stepTranscribeSubmit(audioUrl).catch(throwStepError),
 *   );
 *   for (let n = 0; n < 360; n += 1) {
 *     // One call site in a loop is exactly what `(name, occurrence)` keying is
 *     // for — `poll#0`, `poll#1`, … — so it needs no name of its own per round.
 *     const progress = await ctx.step("poll", () =>
 *       stepTranscribePoll(id).catch(throwStepError),
 *     );
 *     if (progress.done) return progress.transcript;
 *     await ctx.sleep("poll", 10_000);
 *   }
 *   throw new Error(`Transcript ${id} is still unfinished.`);
 * }
 * ```
 *
 * ## The phase boundaries are a MEASUREMENT, not a taste
 *
 * Upload and submit look like one operation — an `upload_url` is useless alone
 * and expires — and both templates that own this flow began that way. The first
 * live run is what split them: the create call failed on a deprecated field,
 * the engine retried the whole step five times, and 24 MB went up the wire on
 * every attempt to fix a fault in a JSON body. A retry that repeats the
 * expensive half to fix the cheap half is not a retry. The risk that makes the
 * split look wrong is real and far smaller — if the URL expires before the next
 * step runs, one fresh upload happens, once, instead of five.
 *
 * ## Polling READS, so there is no separate read
 *
 * Both templates polled `GET /v2/transcript/:id` for a status and then fetched
 * the identical URL again for the text — the completed poll had the transcript
 * in its hand and threw it away. {@link stepTranscribePoll} answers with it, so
 * a finished job costs one round trip rather than two and the value journaled
 * by the last poll IS the transcript.
 *
 * The provider's vocabulary stays in here: the caller branches on `done`, never
 * on a status string, so a new status the service invents cannot read as "not
 * finished yet" forever.
 *
 * ## For a recording that fits in one request, use the sync endpoint
 *
 * `step-transcribe-sync.ts` is one call with no job and no polling, and it is
 * the better answer whenever the audio fits inside its 120-second, 40 MB
 * ceiling. This module is for everything that does not.
 *
 * @module step-transcribe
 */

import {
  type TranscribeRequestOptions,
  transcribeFailure,
  transcribeKey,
  transcribeRefusal,
  transcribeSignal,
} from "./_transcribe-shared.ts";
import { stepFetch } from "./step-fetch.ts";
import { stepReadUpload } from "./step-uploads.ts";
import { stepRequireCompleteUpload } from "./step-uploads-complete.ts";

/** The async API's base. */
export const TRANSCRIBE_API = "https://api.assemblyai.com";

/**
 * The models a job asks for when a caller names none.
 *
 * `speech_models`, PLURAL and an array. The singular `speech_model` is
 * deprecated on the async API and answers **400** for any current model name —
 * which is exactly the fault that produced the retry measurement in the module
 * doc. Omitting the field entirely is legal and routes to the service's
 * default; naming it is what stops a default change silently moving a
 * workflow's output.
 */
export const TRANSCRIBE_MODELS = ["universal-3-5-pro"] as const;

/**
 * How much of a stored upload one outbound window carries.
 *
 * The recording is never held whole — see {@link stepTranscribeUpload}.
 */
// 4 MiB, spelled as the literal rather than as `4 * 1024 * 1024`: an
// arithmetic initializer widens to `number`, which drops the VALUE out of the
// rolled-up .d.ts and so out of this capability's contract hash — the budget
// could then move under a green gate. See "Value-carrying constants carry a
// LITERAL type" in AGENTS.md.
export const TRANSCRIBE_WINDOW_BYTES = 4_194_304;

/**
 * Deadline for the upload leg.
 *
 * Its own budget because it is the one request whose duration is a function of
 * the FILE rather than of the service, and a deadline sized for a JSON round
 * trip would cancel exactly the uploads this exists to handle.
 */
// 30 minutes, spelled as the literal — see TRANSCRIBE_WINDOW_BYTES above.
export const TRANSCRIBE_UPLOAD_TIMEOUT_MS = 1_800_000;

/** A finished transcript, as {@link stepTranscribePoll} answers with one. */
export type Transcript = {
  /** The job id, so a caller can quote it in a log or fetch it again later. */
  id: string;
  /** What was said, trimmed. Never empty — see {@link stepTranscribePoll}. */
  text: string;
  /**
   * How long the recording runs, from the PROVIDER's own measurement rather
   * than from a byte count — it decoded the file and this did not.
   */
  durationMs: number;
};

/**
 * Where a submitted job has got to.
 *
 * A discriminated union rather than `{ done, transcript? }`, so a caller that
 * checks `done` has the transcript without a second narrowing and one that
 * forgets cannot read `undefined` text.
 */
export type TranscribeProgress =
  | { done: false; status: string }
  | { done: true; status: string; transcript: Transcript };

/** What {@link stepTranscribeSubmit} accepts. */
export type TranscribeSubmitOptions = TranscribeRequestOptions & {
  /** Models to ask for. Defaults to {@link TRANSCRIBE_MODELS}. */
  models?: readonly string[] | undefined;
  /**
   * Extra fields merged into the create-job body, VERBATIM.
   *
   * The async API has a large surface this deliberately does not mirror —
   * `speaker_labels`, `language_code`, `redact_pii`, `auto_chapters` — and
   * mirroring it would mean a wrapper that goes stale against the service every
   * time it grows a feature. Nothing here interprets these; they are the
   * caller's request, sent as given.
   *
   * `audio_url` and `speech_models` are set from this function's own arguments
   * and cannot be overridden here, so the two ways to say the same thing cannot
   * disagree.
   */
  params?: Record<string, unknown> | undefined;
};

/**
 * Send a stored upload to the provider, and answer with the URL it gave.
 *
 * The recording STREAMS out of the app's own store: `stepReadUpload` hands back
 * bytes and a two-hour recording is not a value this process can hold, so the
 * body is an async iterable of windows — which `stepFetch` accepts precisely
 * for this. Nothing is buffered beyond one window, and one window of READ-AHEAD
 * keeps the store and the socket busy at the same time.
 *
 * **The upload has to be FINISHED, and that is checked rather than assumed.**
 * `UploadInfo.size` is the contiguous readable prefix, so reading it off a
 * still-arriving recording used to upload only what had landed and transcribe a
 * truncated file — a plausible wrong answer with no error anywhere.
 * `stepRequireCompleteUpload` refuses instead, BEFORE the expensive leg; its module
 * doc carries why that is a refusal rather than a wait.
 *
 * @param uploadId - An upload in the agent's own store, as `stepWriteUpload` or a
 *   page's `api.upload(file)` produced. Must be complete.
 *
 * @throws {UploadIncompleteError} when the upload is still arriving.
 * @throws {TranscribeError} on a refusal, carrying the verdict `toStepError`
 *   reads. Give this step extra retries: it is the one call here worth another
 *   attempt, and the only one whose cost is the file.
 *
 * @public
 *
 * **From a step, prefer `stepTranscribeUploadOrFail`
 * (`@alexkroman1/aai/step-errors`).** The engine's retry policy is decided by WHICH
 * error a step throws, and raw every failure looks alike to it — a bad API key is
 * retried until the attempts run out.
 */
export async function stepTranscribeUpload(
  uploadId: string,
  opts: TranscribeRequestOptions = {},
): Promise<{ audioUrl: string }> {
  // Not `stepUploadInfo`: `size` is the readable PREFIX, and a run started while the
  // recording was still arriving would upload the prefix and transcribe it.
  const stored = await stepRequireCompleteUpload(uploadId);
  const response = await stepFetch(`${TRANSCRIBE_API}/v2/upload`, {
    method: "POST",
    // The raw key — this API takes it unprefixed, and a `Bearer ` in front of
    // it is a 401 that reads like a wrong key.
    headers: {
      Authorization: transcribeKey(opts),
      "Content-Type": "application/octet-stream",
    },
    body: uploadWindows(uploadId, stored.size),
    signal: transcribeSignal({
      ...opts,
      timeoutMs: opts.timeoutMs ?? TRANSCRIBE_UPLOAD_TIMEOUT_MS,
    }),
  });
  if (!response.ok) throw await transcribeFailure(response, "Upload");

  const { upload_url: audioUrl } = (await response.json()) as { upload_url?: string };
  if (!audioUrl) {
    throw transcribeRefusal("The async API accepted the upload but named no URL.");
  }
  return { audioUrl };
}

/**
 * Create the transcription job, and answer with the id that outlives this run.
 *
 * @param audioUrl - What to transcribe. {@link stepTranscribeUpload}'s answer,
 *   or any URL the service can reach — a recording already sitting in a bucket
 *   never needs to pass through this process at all.
 *
 * @throws {TranscribeError} on a refusal, or when the API creates no id.
 *
 * @remarks
 * **This trio is for a recording of arbitrary length; {@link stepTranscribeSync}
 * is for one that fits in a single request.** That endpoint answers with the
 * words in the response and pays for it with a hard 120-second, 40 MB ceiling.
 * Under the ceiling it is one round trip against these three steps plus a
 * polling loop; over it, the job API is the only thing that works. Choosing
 * between them is the one decision this subpath forces, and it is decided by
 * what the audio IS rather than by anything either function can see.
 *
 * @example
 * The whole job, as three steps and a durable wait. The submit is journaled, so
 * a resumed run polls the same job rather than paying for a second one.
 * ```ts
 * import {
 *   stepTranscribePoll,
 *   stepTranscribeSubmit,
 *   stepTranscribeUpload,
 * } from "@alexkroman1/aai/step";
 *
 * export async function startJob(uploadId: string): Promise<string> {
 *   const { audioUrl } = await stepTranscribeUpload(uploadId);
 *   const { id } = await stepTranscribeSubmit(audioUrl);
 *   return id;
 * }
 *
 * export async function checkJob(id: string): Promise<string | undefined> {
 *   const progress = await stepTranscribePoll(id);
 *   // Branch on `done`, never on a provider status string.
 *   return progress.done ? progress.transcript.text : undefined;
 * }
 * ```
 *
 * @public
 *
 * **From a step, prefer `stepTranscribeSubmitOrFail`
 * (`@alexkroman1/aai/step-errors`).** The engine's retry policy is decided by WHICH
 * error a step throws, and raw every failure looks alike to it — a bad API key is
 * retried until the attempts run out.
 */
export async function stepTranscribeSubmit(
  audioUrl: string,
  opts: TranscribeSubmitOptions = {},
): Promise<{ id: string }> {
  const response = await stepFetch(`${TRANSCRIBE_API}/v2/transcript`, {
    method: "POST",
    headers: { Authorization: transcribeKey(opts), "Content-Type": "application/json" },
    body: JSON.stringify({
      // The caller's extras FIRST, so the two arguments this function takes
      // cannot be shadowed by a `params` key saying something else.
      ...opts.params,
      audio_url: audioUrl,
      speech_models: opts.models ?? TRANSCRIBE_MODELS,
    }),
    signal: transcribeSignal(opts),
  });
  if (!response.ok) throw await transcribeFailure(response, "Submit");

  const { id } = (await response.json()) as { id?: string };
  if (!id) throw transcribeRefusal("The async API created no transcript id.");
  return { id };
}

/**
 * Ask once whether a job has finished, and read it when it has.
 *
 * @remarks
 * **Polling READS, so there is no separate read.** Both templates this replaced
 * polled `GET /v2/transcript/:id` for a status and then fetched the identical
 * URL again for the text — the completed poll had the transcript in its hand and
 * threw it away. This answers with it, so a finished job costs one round trip
 * rather than two and the value journaled by the last poll IS the transcript.
 *
 * The provider's vocabulary stays inside: branch on `done`, never on a status
 * string, so a new status the service invents cannot read as "not finished yet"
 * forever.
 *
 * @throws {TranscribeError}, NOT retryable, when the provider failed the job or
 *   transcribed no words at all. A recording of silence succeeds and answers
 *   with an empty string, which is the failure this flow is most likely to meet
 *   and the one that reads least like a failure: everything downstream would
 *   otherwise be handed no words and asked to work anyway.
 *
 * @public
 *
 * **From a step, prefer `stepTranscribePollOrFail`
 * (`@alexkroman1/aai/step-errors`).** The engine's retry policy is decided by WHICH
 * error a step throws, and raw every failure looks alike to it — a bad API key is
 * retried until the attempts run out.
 */
export async function stepTranscribePoll(
  id: string,
  opts: TranscribeRequestOptions = {},
): Promise<TranscribeProgress> {
  const response = await stepFetch(`${TRANSCRIBE_API}/v2/transcript/${id}`, {
    headers: { Authorization: transcribeKey(opts) },
    signal: transcribeSignal(opts),
  });
  if (!response.ok) throw await transcribeFailure(response, `Transcript ${id}`);

  const body = (await response.json()) as {
    status?: string;
    error?: string;
    text?: string;
    audio_duration?: number;
  };
  const status = body.status ?? "unknown";
  if (status === "error") {
    // The provider has decided; no number of polls changes it.
    throw transcribeRefusal(
      `That recording could not be transcribed: ${body.error ?? "no reason given"}`,
    );
  }
  if (status !== "completed") return { done: false, status };

  const text = (body.text ?? "").trim();
  if (text.length === 0) {
    throw transcribeRefusal("There is no speech in that recording — nothing was transcribed.");
  }
  return {
    done: true,
    status,
    // `audio_duration` is the provider's measurement, in seconds.
    transcript: { id, text, durationMs: Math.round((body.audio_duration ?? 0) * 1000) },
  };
}

/**
 * A stored upload as a sequence of windows, with the next one already in flight.
 *
 * A generator rather than one `stepReadUpload`, because the whole point is that the
 * file is never held: each window is read, sent, and dropped. `stepReadUpload`
 * clamps to what is stored, so the loop ends on the real end of the file even
 * if `size` moved under it.
 *
 * **One window of READ-AHEAD**, which is the whole concurrency available here:
 * the consumer is a socket and the producer is the app's own store, so
 * read-then-send makes them strictly alternate. Issuing the next read before
 * yielding the current window overlaps them, and a large upload then pays the
 * larger of the two rather than their sum.
 */
async function* uploadWindows(uploadId: string, size: number): AsyncGenerator<Uint8Array> {
  const read = (at: number): Promise<Uint8Array> =>
    stepReadUpload(uploadId, { start: at, end: at + TRANSCRIBE_WINDOW_BYTES }).then(
      (slice) => slice.bytes,
    );
  let at = 0;
  let next = at < size ? read(at) : undefined;
  while (next !== undefined) {
    const bytes = await next;
    if (bytes.length === 0) return;
    at += TRANSCRIBE_WINDOW_BYTES;
    // Issued BEFORE the yield, so the store is fetching while the socket sends.
    next = at < size ? read(at) : undefined;
    yield bytes;
  }
}
