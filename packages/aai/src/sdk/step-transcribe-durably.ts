// Copyright 2026 the AAI authors. MIT license.
/**
 * `transcribeUploadDurably()` — the whole async transcription job as a BODY-side
 * composition: three journaled steps and a durable poll, under one name.
 *
 * `step-transcribe.ts` gives a body the three calls — upload, submit, poll —
 * and leaves the steps and the loop to the body, because the SDK is handed no
 * `ctx` and so cannot own a step. What it CAN own is a composition over a `ctx`
 * the body hands it, which is exactly what `ctx.poll` and `ctx.sayOnClient` are:
 * `ctx.step` and `ctx.sleep` under one name, journaled as the hand-written loop
 * would have been. This module is that for transcription, and it exists because
 * the hand-written loop was written four times across the shipped templates and
 * no two agreed on the budget, the step names, or what happens when the budget
 * runs out.
 *
 * ```ts no-check
 * import { transcribeUploadDurably } from "@alexkroman1/aai/step";
 * import type { WorkflowContext } from "@alexkroman1/aai/workflow-api";
 *
 * export async function transcribe(input: { recording: string }, ctx: WorkflowContext) {
 *   const transcript = await transcribeUploadDurably(ctx, input.recording);
 *   return { source: transcript.source, text: transcript.text };
 * }
 * ```
 *
 * ## Three fixed step names, and why they are fixed
 *
 * The steps are journaled as {@link TRANSCRIBE_DURABLY_STEPS} — `transcribeUpload`,
 * `transcribeSubmit`, `transcribePoll` — rather than under a name the caller
 * passes, because a composition that takes a name has to derive three from it
 * and the derivation is one more thing a resumed run can disagree with its
 * journal about. A body that transcribes two recordings calls this twice, and the
 * `(name, occurrence)` keying every step already has (`transcribeUpload#0`,
 * `transcribeUpload#1`) keeps them apart with no name of their own.
 *
 * ## Each step is CLASSIFIED, so the budget is spent where it helps
 *
 * Every call inside a step goes through `throwStepError`
 * (`@alexkroman1/aai/step-errors`): a 401 or a 400 is a `FatalError` that stops
 * the run on the first attempt, a 429 waits the `Retry-After` the service named,
 * and a job the PROVIDER failed — `status: "error"`, or a recording with no
 * speech in it — is terminal rather than polled until the budget runs out. The
 * upload step is the one worth extra attempts (it is the only call whose cost is
 * the file), and `maxAttempts` is passed to it alone.
 *
 * ## Running out of budget is a REFUSAL that names the job
 *
 * A poll that gives up throws a `TranscribeError` carrying the transcript id,
 * because the job is still running on the provider's side and will finish —
 * the run failed, the WORK did not. The sentence says where to read it, so a
 * two-hour recording that outran a one-hour default is not transcribed twice.
 *
 * @module step-transcribe-durably
 */

import { throwStepError } from "./_step-verdict.ts";
import { transcribeRefusal } from "./_transcribe-shared.ts";
import { formatDuration } from "./format.ts";
import { omitUndefined } from "./omit-undefined.ts";
import {
  stepTranscribePoll,
  stepTranscribeSubmit,
  stepTranscribeUpload,
  type TranscribeProgress,
  type TranscribeSubmitOptions,
  type Transcript,
} from "./step-transcribe.ts";
import type { PollOptions, PollResult, StepOptions } from "./workflow-ctx-options.ts";

/**
 * How often {@link transcribeUploadDurably} polls when the caller names no
 * interval: every 10 seconds.
 *
 * The async API finishes a recording in a fraction of its length, so a tighter
 * interval buys seconds on a job that takes minutes and costs a journal entry
 * per round; a looser one leaves a short recording waiting on the sleep rather
 * than the provider.
 */
export const TRANSCRIBE_POLL_EVERY_MS: number = 10_000;

/**
 * The polling budget when the caller names none: one hour.
 *
 * Generous on purpose — a two-hour call transcribes in well under it — and
 * sized so the failure it bounds is a job the provider never finishes rather
 * than a long one. A COUNT of sleeps rather than a clock (`PollOptions.maxMs`
 * says why), so `floor(maxMs / everyMs)` rounds of the default is 360.
 */
export const TRANSCRIBE_POLL_MAX_MS: number = 3_600_000;

/**
 * The three journal names {@link transcribeUploadDurably} writes under.
 *
 * Exported so a spec driving a body over the `/testing` recorder can assert the
 * journal shape by these rather than by copying the strings — and so a
 * `aai workflow` listing reads the same way as the code that produced it.
 *
 * @public
 */
export const TRANSCRIBE_DURABLY_STEPS: {
  readonly upload: "transcribeUpload";
  readonly submit: "transcribeSubmit";
  readonly poll: "transcribePoll";
} = {
  upload: "transcribeUpload",
  submit: "transcribeSubmit",
  poll: "transcribePoll",
};

/**
 * What {@link transcribeUploadDurably} accepts.
 *
 * @input
 * @public
 */
export type TranscribeDurablyOptions = {
  /** Durable wait between polls, in milliseconds. Defaults to {@link TRANSCRIBE_POLL_EVERY_MS}. */
  everyMs?: number | undefined;
  /**
   * The polling budget, in milliseconds. Defaults to {@link TRANSCRIBE_POLL_MAX_MS}.
   *
   * Spending it is a refusal naming the job, not a silent `undefined` — see the
   * module doc.
   */
  maxMs?: number | undefined;
  /**
   * Extra fields for the create-job body, VERBATIM — `speaker_labels`,
   * `language_code`, and so on. `stepTranscribeSubmit`'s own option, passed
   * through.
   */
  params?: Record<string, unknown> | undefined;
  /** Models to ask for. `stepTranscribeSubmit`'s own option, passed through. */
  models?: readonly string[] | undefined;
  /** Env var holding the credential, replacing `ASSEMBLYAI_API_KEY`. Passed to every call. */
  apiKeyEnv?: string | undefined;
  /**
   * The UPLOAD step's attempt budget. The submit and poll steps keep the
   * engine's default: they are JSON round trips, and the upload is the one
   * call here whose cost is the file.
   */
  maxAttempts?: number | undefined;
};

/**
 * The two context methods the composition is made of, with the step NAMES
 * unconstrained — the `PollHost` shape, for the same reason: `WorkflowContext`
 * refuses a non-literal name at compile time, and the names here are this
 * module's own literals. Method syntax, so a `WorkflowContext` is assignable.
 *
 * @input
 * @public
 */
export type TranscribeDurablyHost = {
  step<T>(name: string, fn: () => Promise<T> | T, options?: StepOptions): Promise<T>;
  poll<T>(
    name: string,
    check: () => Promise<T> | T,
    options: PollOptions<T>,
  ): Promise<PollResult<T>>;
};

/**
 * What {@link transcribeUploadDurably} resolves with: the transcript, plus what
 * the recording was CALLED.
 *
 * @sealed
 * @public
 */
export type DurableTranscript = Transcript & {
  /**
   * The upload's `label` — its filename, or its id when the uploader gave none.
   * Read off the journaled upload step, so a resumed run names the same file
   * without a second look at the store.
   */
  source: string;
};

/**
 * Transcribe a stored upload through the async API, durably: upload it, create
 * the job, and poll until the transcript is in, each phase a journaled step of
 * `ctx`.
 *
 * Call it from the BODY, handing it the body's own `ctx` — it journals through
 * that context exactly as the hand-written three-step loop did (`step-transcribe.ts`'s
 * module doc shows that loop), so there is nothing to wrap it in. A resumed run
 * replays the upload and the submit from the journal and polls the same job.
 *
 * @param ctx - The workflow body's context, or anything with its `step` and
 *   `poll` (the `/testing` recorder qualifies).
 * @param uploadId - An upload in the agent's own store. Must be complete; one
 *   still arriving is refused BEFORE the upload leg, as `stepTranscribeUpload`
 *   refuses it, and that refusal is fatal.
 * @param options - See {@link TranscribeDurablyOptions}.
 *
 * @throws {FatalError} / {RetryableError} out of each step, by `throwStepError`'s
 *   verdict — the engine reads them; a caller sees the run fail or retry.
 * @throws {TranscribeError} from the body, `retryable: false`, when the budget
 *   is spent with the job still running. The message carries the transcript id
 *   and where to read it.
 *
 * @example
 * ```ts no-check
 * import { stepReport, transcribeUploadDurably } from "@alexkroman1/aai/step";
 * import type { WorkflowContext } from "@alexkroman1/aai/workflow-api";
 *
 * export async function transcribe(input: { recording: string }, ctx: WorkflowContext) {
 *   const transcript = await transcribeUploadDurably(ctx, input.recording, {
 *     params: { speaker_labels: true },
 *     maxMs: 2 * 3_600_000,
 *   });
 *   await ctx.step("report", () =>
 *     stepReport(`Transcribed ${transcript.source}: ${transcript.text.length} characters.`),
 *   );
 *   return transcript;
 * }
 * ```
 *
 * @public
 */
export async function transcribeUploadDurably(
  ctx: TranscribeDurablyHost,
  uploadId: string,
  options: TranscribeDurablyOptions = {},
): Promise<DurableTranscript> {
  const request = omitUndefined({ apiKeyEnv: options.apiKeyEnv });
  const everyMs = options.everyMs ?? TRANSCRIBE_POLL_EVERY_MS;
  const maxMs = options.maxMs ?? TRANSCRIBE_POLL_MAX_MS;

  // Upload and submit are two steps, not one, for the measurement
  // `step-transcribe.ts` records: a retry of the cheap half must not repeat the
  // expensive one. `source` and `size` ride the journaled result.
  const uploaded = await ctx.step(
    TRANSCRIBE_DURABLY_STEPS.upload,
    () => stepTranscribeUpload(uploadId, request).catch(throwStepError),
    omitUndefined({ maxAttempts: options.maxAttempts }),
  );
  const submit: TranscribeSubmitOptions = {
    ...request,
    ...omitUndefined({ params: options.params, models: options.models }),
  };
  const { id } = await ctx.step(TRANSCRIBE_DURABLY_STEPS.submit, () =>
    stepTranscribeSubmit(uploaded.audioUrl, submit).catch(throwStepError),
  );

  const polled = await ctx.poll<TranscribeProgress>(
    TRANSCRIBE_DURABLY_STEPS.poll,
    () => stepTranscribePoll(id, request).catch(throwStepError),
    { everyMs, maxMs, done: (progress) => progress.done },
  );
  const progress = polled.value;
  if (!progress.done) {
    // The JOB is fine; the run's patience ran out. Said with the id, because
    // the transcript will finish on the provider's side and a reader who knows
    // where it is does not pay for the recording twice.
    throw transcribeRefusal(
      `Transcript ${id} for ${uploaded.source} was still "${progress.status}" after ` +
        `${polled.checks} checks over ${formatDuration(maxMs)}. It is not lost — read it with ` +
        `GET /v2/transcript/${id}, or run again with a larger maxMs.`,
    );
  }
  return { ...progress.transcript, source: uploaded.source };
}
