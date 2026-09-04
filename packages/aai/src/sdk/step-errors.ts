// Copyright 2026 the AAI authors. MIT license.
/**
 * The failure a step should throw (the
 * `@alexkroman1/aai/step-errors` subpath).
 *
 * The engine retries a step that throws, gives up on a `FatalError`,
 * and honours the delay on a `RetryableError` — so every step body that calls
 * an HTTP API owns the same three-way decision, and `@alexkroman1/aai/step`
 * already carries the two halves it can answer with no verdict vocabulary at all
 * (`isTransientStatus` and `retryAfter`). What it could not do is
 * CONSTRUCT the error. So the mapping was left as a snippet in a module doc — and
 * both templates that needed it copied the snippet out, verbatim and
 * character-identical. That is what this module is: the last function of an
 * extraction that stopped one function short.
 *
 * ## Why this is not simply part of `@alexkroman1/aai/step`
 *
 * `@alexkroman1/aai/step` is the sibling, and the question a reader arriving
 * here actually has is why {@link throwStepError} is not next to
 * `stepFetch`.
 *
 * The answer is that IMPORTING FROM HERE IS THE OPT-IN, and `/step` is not
 * written only for a step. Its vocabulary is reached from a tool body and from a
 * spec as well — `mapConcurrent` bounds a rate-limited API call anywhere,
 * `stepFetch` is an ordinary HTTP client, and an exported step is driven
 * directly by every workflow template's tests. None of those callers has a
 * retry budget to burn, so none of them should meet a vocabulary whose whole
 * subject is one.
 *
 * The split used to be a DEPENDENCY boundary — this was the one authoring module
 * allowed to import the Workflow DevKit's `workflow` package, which owned
 * `FatalError` and `RetryableError`. That package is gone and the two classes are
 * ours (`step-error-classes.ts` says why), so nothing here costs a caller
 * anything at install time. What survives is the audience boundary above, which
 * is the half that was ever load-bearing for a reader.
 *
 * It is in `sdk/` rather than `host/`, and that is the rule rather than an
 * exception to it: the split is about
 * `node:` builtins, which this has none of (it compiles under
 * `sdk/tsconfig.json`, which sets `types: []`), and `host/` is the half that
 * never runs inside a guest sandbox — where every step in fact runs.
 *
 * ## Three outcomes, and the third is the one worth having
 *
 * A `FatalError` stops the engine retrying something that will answer the same
 * way. A bare `RetryableError` retries in ONE SECOND, which is that class's own
 * default and not a considered number. A `RetryableError` carrying `retryAfter`
 * waits exactly as long as the far side asked — which matters most where this
 * SDK encourages a fan-out, because N segments hit a rate limit together, and a
 * second later all N ask again.
 *
 * `StepGenerateError` already carries both the verdict (`retryable`) and
 * that delay, and until this module existed **no caller read the delay**: both
 * templates re-threw the error unchanged, so a rate-limited model call fell back
 * to the default backoff with the gateway's own number sitting unread on the
 * error. {@link toStepError} reads it.
 *
 * ## The callers that come pre-classified
 *
 * `.catch(throwStepError)` is not an interesting line, and it was on **17 call
 * sites across eight templates** — every LLM and transcription call any of them
 * makes. Two had already wrapped it in a local `ask()` whose only content was
 * that `.catch`, each paying a doc block to say why, and the second one records
 * that two OTHER templates wrote the same mapping before it was extracted. So it
 * is hoisted one level further: {@link stepGenerateOrFail} and its
 * siblings are the `/step` call and {@link throwStepError}, nothing else.
 *
 * They live here rather than in `/step` because IMPORTING THEM IS THE OPT-IN.
 * `/step` names no verdict vocabulary at all, and whether a terminal failure should
 * burn a step's remaining attempts is the caller's decision — a `404` meaning
 * "already deleted" wants the raw call. The `OrFail` suffix keeps the `/step`
 * name intact, so a wrapper reads as the call it wraps.
 *
 * @module step-errors
 */

import { throwFatalStepError, throwStepError, toStepError } from "./_step-verdict.ts";
import type { TranscribeRequestOptions } from "./_transcribe-shared.ts";
import type { Channel, ChannelMessage } from "./channels/channel-types.ts";
import { sendToChannel } from "./channels/send.ts";
import { isRecord } from "./is-record.ts";
import type { InferSchemaOutput, StandardSchemaV1 } from "./standard-schema.ts";
import { type StepFetchInit, stepFetch } from "./step-fetch.ts";
import { type StepGenerateOptions, stepGenerate } from "./step-generate.ts";
import { type StepGenerateJsonOptions, stepGenerateJson } from "./step-generate-json.ts";
import {
  stepTranscribePoll,
  stepTranscribeSubmit,
  stepTranscribeUpload,
  type TranscribeProgress,
  type TranscribeSubmitOptions,
} from "./step-transcribe.ts";
import { stepTranscribeSync, type TranscribeSyncOptions } from "./step-transcribe-sync.ts";
import { responseErrorMessage } from "./utils.ts";

// The verdict itself is one file over — see `_step-verdict.ts` for the seam and
// why the dependency runs in that direction. The three names are part of THIS
// subpath's surface, so they are re-exported rather than reached through a
// second import path; they are imported above as well, because `stepFetchOrFail`,
// the ffmpeg arm and the classified callers all CALL them and a
// re-export brings nothing into this module's scope.
export { throwFatalStepError, throwStepError, toStepError } from "./_step-verdict.ts";
// The two classes the verdict RESOLVES TO. They were the DevKit's and are now
// ours (`step-error-classes.ts` says why), and this subpath is where an author
// meets them — a step that has already decided its failure is terminal throws a
// `FatalError` directly rather than routing through a classifier that would have
// to guess. Re-exported rather than given a subpath of their own: every importer
// of one is an importer of this module's vocabulary.
export {
  DEFAULT_RETRY_DELAY_MS,
  FatalError,
  RetryableError,
  type RetryableErrorOptions,
} from "./step-error-classes.ts";

/**
 * `stepFetch`, with the non-2xx branch every caller was writing by hand.
 *
 * A step whose job is one HTTP call ends up writing the same three lines —
 * make the request, check `ok`, hand the `Response` to {@link toStepError} —
 * and three templates had each arrived at their own copy of it: `recap-workflow`
 * wrapped it in a local `request()`, `link-digest` inlined it, and
 * `podcast-digest` wrote a `fetchText` around it. This is that line, and the
 * argument for hoisting it is the one in this module's own doc: a snippet
 * copied verbatim into three places is a function that has not been written
 * yet.
 *
 * It answers a `Response` on 2xx, so nothing about the success path changes —
 * the caller still chooses `.text()`, `.json()` or the stream. It is only the
 * failure path that is taken over, and the takeover is worth having for two
 * reasons beyond the line count:
 *
 * - **The body reaches the error.** `responseErrorMessage` prefers a JSON
 *   `error` field when the far side sent one and falls back to the status with
 *   a bounded preview. Hand-written versions throw away the body — so a `400`
 *   that said exactly what was wrong with the request arrives as the number
 *   `400`, and whoever reads the run has to reproduce the call to find out.
 * - **The verdict stays with `toStepError`.** Transient by `isTransientStatus`,
 *   waiting out a `Retry-After` the server named rather than the default
 *   one-second delay. That distinction is the reason a step should never
 *   throw a bare `Error` on a bad response, and it is easy to forget in the
 *   fourth call site of a file.
 *
 * Reach for `stepFetch` directly where the failure is not simply a
 * failure: a `404` that means "already deleted", or a `4xx` whose body decides
 * which advice to print. `podcast-digest`'s Slack step is the worked example of
 * that second case.
 *
 * @example
 * ```ts
 * import { stepFetchOrFail } from "@alexkroman1/aai/step-errors";
 *
 * export async function readFeed(url: string): Promise<string> {
 *   return await (await stepFetchOrFail(url, { signal: AbortSignal.timeout(30_000) })).text();
 * }
 * ```
 *
 * @throws {Error} a `FatalError` or `RetryableError` — see {@link toStepError}.
 * @public
 */
export async function stepFetchOrFail(url: string, init?: StepFetchInit): Promise<Response> {
  const response = await stepFetch(url, init);
  if (response.ok) return response;
  // The label is the REQUEST, because a run's log holds many of these and the
  // status alone does not say which call answered. `responseErrorMessage`
  // appends the status and the body preview.
  throw toStepError(
    response,
    await responseErrorMessage(response, `${init?.method ?? "GET"} ${url}`),
  );
}

/**
 * The verdict a failed ffmpeg run deserves: retry a `timeout` or an `aborted`,
 * stop on everything else.
 *
 * `FfmpegError.kind` (`@alexkroman1/aai/ffmpeg`) is what makes this decidable. An
 * `exit` is ffmpeg having READ the file and refused it, so every retry re-reads
 * the same bytes and reaches the same conclusion while burning the budget a real
 * transient needs; a `missing-binary` is `aai dev` on a laptop with no ffmpeg,
 * already carrying its install instructions; an `output-too-large` is a cap only
 * the caller can raise. A `timeout` or an `aborted` is worth another attempt.
 *
 * **Everything it does not recognise is FATAL — the opposite of
 * {@link toStepError}'s default — and that inversion is why this is its own
 * export.** `toStepError` refuses to invent a verdict, so an unclassified cause
 * passes through retryable; here the caller has already decided, this step having
 * run one subprocess over one file. Folding the two together would silently
 * disable retries for every unclassified failure in the SDK, so the
 * fatal/retryable choice stays visible in the name the author types.
 *
 * **The retryable arm goes through {@link throwStepError} even though it
 * classifies nothing.** An `FfmpegError` is neither a `Response` nor an SDK error
 * carrying `retryable`, so it is rethrown UNCHANGED and the engine's unclassified default
 * retries it — where constructing a `RetryableError` would replace ffmpeg's own
 * message and its `argv` with a sentence, and the argv is what you paste into a
 * shell.
 *
 * **The failure is recognised STRUCTURALLY rather than with `instanceof`, and
 * that is forced.** `FfmpegError` types its `signal` as `NodeJS.Signals`, and
 * this module compiles under `sdk/tsconfig.json`, which sets `types: []` — so no
 * module reachable from here may name a Node type, let alone import
 * `node:child_process`. That budget is the whole reason this subpath can be named
 * from a `workflows/` module: that bundle keeps everything a module holds at
 * MODULE scope, so one surviving reference to `@alexkroman1/aai/ffmpeg` puts a
 * child-process spawn inside a `node:vm` with no `require`, and every run dies at
 * replay with `ReferenceError: require is not defined`. Two templates each carried
 * a whole one-function FILE to keep that reference on the far side of a boundary
 * only a step body crosses; owning the decision here retires both.
 *
 * @param cause - What the ffmpeg call threw. Anything at all — see above.
 * @param message - The sentence to report. Defaults to the cause's own, which
 *   for an `FfmpegError` is ffmpeg's log tail.
 *
 * @example
 * ```ts
 * import { transcodeToWav } from "@alexkroman1/aai/ffmpeg";
 * import { throwFfmpegStepError } from "@alexkroman1/aai/step-errors";
 *
 * export async function toPcm(bytes: Uint8Array): Promise<Uint8Array> {
 *   return await transcodeToWav(bytes, { sampleRate: 16_000 }).catch(throwFfmpegStepError);
 * }
 * ```
 *
 * @public
 */
export function throwFfmpegStepError(cause: unknown, message?: string): never {
  const kind = ffmpegFailureKind(cause);
  if (kind === "timeout" || kind === "aborted") return throwStepError(cause, message);
  return throwFatalStepError(cause, message);
}

/**
 * `FfmpegError.kind`, read off a value this module may not name a type for.
 *
 * Both properties are checked because either alone is a false positive waiting to
 * happen: `kind` is a common discriminant and a `name` is only a string. An
 * `FfmpegError` sets `this.name` in its constructor, so it is an own property that
 * survives the structural round trips a durable run makes.
 */
function ffmpegFailureKind(cause: unknown): string | undefined {
  if (!isRecord(cause) || cause.name !== "FfmpegError") return undefined;
  return typeof cause.kind === "string" ? cause.kind : undefined;
}

/**
 * `stepGenerate`, with its failure classified — the whole of what the wrapper
 * adds is {@link throwStepError}, and see this module's doc for why that is
 * worth an export rather than a line at each of the eight templates that wrote
 * it. `StepGenerateError` carries the gateway's own verdict AND its
 * `Retry-After`, so a rate-limited call waits the delay the gateway named
 * instead of the default one-second delay.
 *
 * None of them takes a `message`: a caller with a label worth attaching wants
 * the explicit `.catch((err) => throwStepError(err, …))`.
 *
 * @throws {Error} A `FatalError` or `RetryableError` — see {@link toStepError}.
 *
 * @example
 * ```ts
 * import { stepGenerateOrFail } from "@alexkroman1/aai/step-errors";
 *
 * export async function summarize(text: string): Promise<string> {
 *   return await stepGenerateOrFail(text, { system: "Summarize in two sentences." });
 * }
 * ```
 *
 * @public
 */
export function stepGenerateOrFail(prompt: string, options?: StepGenerateOptions): Promise<string> {
  return stepGenerate(prompt, options).catch(throwStepError);
}

/**
 * `stepGenerateJson`, with its failure classified — see
 * {@link stepGenerateOrFail}. The most-copied member of the family (**7 of the
 * 17 sites**): a workflow that asks a model for a SHAPE is the usual shape.
 *
 * Worth knowing what it does NOT flatten: a gateway refusal arrives as a
 * `StepGenerateError` carrying its own verdict, while a reply that was not JSON
 * or missed the schema throws a plain `Error`, which {@link toStepError} passes
 * through retryable — correctly, since a model that answered with prose may obey
 * next attempt.
 *
 * @throws {Error} A `FatalError` or `RetryableError` — see {@link toStepError}.
 * @public
 */
export function stepGenerateJsonOrFail<S extends StandardSchemaV1>(
  prompt: string,
  options: StepGenerateJsonOptions<S>,
): Promise<InferSchemaOutput<S>> {
  return stepGenerateJson(prompt, options).catch(throwStepError);
}

/**
 * `stepTranscribeSync`, with its failure classified — see
 * {@link stepGenerateOrFail}.
 *
 * This is the arm where classifying earns the most. `TranscribeError` carries
 * `retryable`, and a refusal the PROVIDER decided — a recording with no speech in
 * it, a container it will not read — arrives with `retryable: false`. Unclassified,
 * a step re-uploads the same bytes until its attempts run out on a file that was
 * never going to transcribe.
 *
 * @throws {Error} A `FatalError` or `RetryableError` — see {@link toStepError}.
 * @public
 */
export function stepTranscribeSyncOrFail(
  bytes: Uint8Array | readonly Uint8Array[],
  options?: TranscribeSyncOptions,
): Promise<{ text: string }> {
  return stepTranscribeSync(bytes, options).catch(throwStepError);
}

/**
 * `stepTranscribeUpload`, with its failure classified — see
 * {@link stepTranscribeSyncOrFail} for what a transcription verdict carries.
 *
 * @throws {Error} A `FatalError` or `RetryableError` — see {@link toStepError}.
 * @public
 */
export function stepTranscribeUploadOrFail(
  uploadId: string,
  options?: TranscribeRequestOptions,
): Promise<{ audioUrl: string }> {
  return stepTranscribeUpload(uploadId, options).catch(throwStepError);
}

/**
 * `stepTranscribeSubmit`, with its failure classified — see
 * {@link stepTranscribeSyncOrFail}. Half of the async job API, whose other
 * half is {@link stepTranscribePollOrFail}; both are wrapped because a submit
 * and its poll are separate steps with separate attempt budgets — classify one
 * and not the other and the run gives up in one place and never in the other.
 *
 * @throws {Error} A `FatalError` or `RetryableError` — see {@link toStepError}.
 * @public
 */
export function stepTranscribeSubmitOrFail(
  audioUrl: string,
  options?: TranscribeSubmitOptions,
): Promise<{ id: string }> {
  return stepTranscribeSubmit(audioUrl, options).catch(throwStepError);
}

/**
 * `stepTranscribePoll`, with its failure classified — see
 * {@link stepTranscribeSubmitOrFail}. A poll that answers is not a poll that
 * SUCCEEDED: an unfinished job comes back as a `TranscribeProgress` and only a
 * transport or API failure rejects, so this classifies the rejection and says
 * nothing about the job's own status.
 *
 * @throws {Error} A `FatalError` or `RetryableError` — see {@link toStepError}.
 * @public
 */
export function stepTranscribePollOrFail(
  transcriptId: string,
  options?: TranscribeRequestOptions,
): Promise<TranscribeProgress> {
  return stepTranscribePoll(transcriptId, options).catch(throwStepError);
}

/**
 * `sendToChannel` (`@alexkroman1/aai/channels`), with its failure classified —
 * see {@link stepGenerateOrFail} for the family, and this module's doc for
 * why the wrapper lives here rather than beside the call it wraps.
 *
 * `ChannelDeliveryError` carries the platform's verdict AND its `Retry-After`,
 * so a rate-limited post waits the delay the platform named rather than the
 * default one-second delay, and a 4xx — a revoked webhook, an unpublished
 * Slack workflow, a variable name that matches nothing — stops immediately
 * with the sentence a person can act on instead of burning three more attempts
 * on an answer that will not change.
 *
 * Reach for `sendToChannel` directly where the refusal is not simply a
 * failure: a body deciding to fall back to a second destination, or a run that
 * treats an unreachable channel as a warning rather than an outcome.
 *
 * @throws {Error} A `FatalError` or `RetryableError` — see {@link toStepError}.
 *
 * @example
 * ```ts
 * import { slackChannel } from "@alexkroman1/aai/channels";
 * import { sendToChannelOrFail } from "@alexkroman1/aai/step-errors";
 *
 * export async function announce(webhookUrl: string, headline: string): Promise<string> {
 *   return await sendToChannelOrFail(slackChannel({ webhookUrl }), { text: headline });
 * }
 * ```
 *
 * @public
 */
export function sendToChannelOrFail(channel: Channel, message: ChannelMessage): Promise<string> {
  return sendToChannel(channel, message).catch(throwStepError);
}
