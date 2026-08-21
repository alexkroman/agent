// Copyright 2026 the AAI authors. MIT license.
/**
 * The failure a `"use step"` body should throw (the
 * `@alexkroman1/aai/step-errors` subpath).
 *
 * The Workflow DevKit retries a step that throws, gives up on a `FatalError`,
 * and honours the delay on a `RetryableError` — so every step body that calls
 * an HTTP API owns the same three-way decision, and `sdk/step-retry.ts` already
 * carries the two halves it can answer without the DevKit
 * (`isTransientStatus` and `retryAfter`, both on `/utils`). What it could
 * not do is
 * CONSTRUCT the error, because `FatalError` and `RetryableError` belong to
 * `workflow` and `sdk/utils.ts` is the subpath the CLI loads on every
 * invocation. So the mapping was left as a snippet in that module's own doc —
 * and both templates that needed it copied the snippet out of the doc, verbatim
 * and character-identical. That is what this module is: the last function of an
 * extraction that stopped one function short.
 *
 * ## Why this is its own subpath
 *
 * `workflow` is a real dependency of this package already, so nothing new is
 * installed. What a subpath buys is that the dependency is only in the import
 * graph of a caller that asked for it: `@alexkroman1/aai/utils` may not reach
 * `workflow` (the CLI's zero-dependency startup path), and a step artifact
 * externalizes it anyway — the Workflow DevKit's builder leaves `workflow` and
 * `@workflow/*` out of the bundle it produces — so importing it from a step
 * costs a step nothing.
 *
 * It is in `sdk/` rather than `host/` despite `workflow` being a Node package,
 * and that is the rule rather than an exception to it: the split is about
 * `node:` builtins, which this has none of (it compiles under
 * `sdk/tsconfig.json`, which sets `types: []`), and `host/` is the half that
 * never runs inside a guest sandbox — where every step in fact runs.
 *
 * ## Three outcomes, and the third is the one worth having
 *
 * A `FatalError` stops the DevKit retrying something that will answer the same
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
 * @module step-errors
 */

import { FatalError, RetryableError } from "workflow";
import { TranscribeError } from "./_transcribe-shared.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { type StepFetchInit, stepFetch } from "./step-fetch.ts";
import { StepGenerateError } from "./step-generate.ts";
import { isTransientStatus, retryAfter } from "./step-retry.ts";
import { errorMessage, responseErrorMessage } from "./utils.ts";

/**
 * The DevKit error one failure deserves.
 *
 * `cause` decides how the verdict is reached, and the three cases are the three
 * ways a step learns it failed:
 *
 * - A **`Response`** — a non-2xx from an API the step called. Transient by
 *   `isTransientStatus` (`/utils`), with the delay from its `Retry-After` when it
 *   named one.
 * - A **`StepGenerateError`** or a **`TranscribeError`** (both `/utils`) — the
 *   LLM gateway and the transcription endpoints, each of which has already made
 *   the same judgement and recorded it on `retryable`/`retryAfter`. A
 *   transcription refusal the PROVIDER decided — a failed job, a recording with
 *   no speech in it — arrives with `retryable: false`, which is the whole reason
 *   it is carried rather than re-derived from a status that is not there.
 * - **Anything else** — a verdict this function cannot reach, so it does not
 *   invent one: the value is returned unchanged if it is an `Error` and wrapped
 *   in a plain `Error` if it is not. Both are retryable by the DevKit's default,
 *   which is the safe direction — the alternative is silently disabling retries
 *   for a failure nobody classified. Reach for {@link throwFatalStepError} where
 *   the step really has decided a failure is terminal.
 *
 * @param cause - What failed.
 * @param message - The sentence to report. Defaults to the response's status
 *   line, or the cause's own message.
 *
 * @example
 * ```ts
 * import { toStepError } from "@alexkroman1/aai/step-errors";
 *
 * export async function fetchOrder(id: string): Promise<unknown> {
 *   "use step";
 *   const response = await fetch(`https://api.example.com/orders/${id}`);
 *   if (!response.ok) throw toStepError(response, `Order ${id}: HTTP ${response.status}`);
 *   return await response.json();
 * }
 * ```
 *
 * @public
 */
export function toStepError(cause: unknown, message?: string): Error {
  if (cause instanceof Response) {
    const sentence = message ?? `HTTP ${cause.status}`;
    if (!isTransientStatus(cause.status)) return new FatalError(sentence);
    return retryableError(sentence, retryAfter(cause));
  }
  if (cause instanceof StepGenerateError) {
    const sentence = message ?? cause.message;
    if (!cause.retryable) return new FatalError(sentence);
    return retryableError(sentence, cause.retryAfter);
  }
  if (cause instanceof TranscribeError) {
    const sentence = message ?? cause.message;
    if (!cause.retryable) return new FatalError(sentence);
    return retryableError(sentence, cause.retryAfter);
  }
  // No verdict is available, so none is invented — see this function's doc.
  if (cause instanceof Error && message === undefined) return cause;
  return new Error(message ?? errorMessage(cause), { cause });
}

/**
 * {@link toStepError}, thrown.
 *
 * The form a `.catch()` takes, which is the shape both LLM templates want:
 * `stepGenerate` rejects with a `StepGenerateError` and the step wants
 * that classified before it reaches the DevKit.
 *
 * It is a function taking the cause as an ARGUMENT rather than a `throw` inside
 * a `catch` block, and that is mechanical rather than stylistic: `FatalError`
 * takes only a message — no `cause` — so constructing one directly inside a
 * `catch` trips Biome's `useErrorCause` with no way to satisfy it. Here nothing
 * is being swallowed, because the original is what was passed in.
 *
 * @example
 * ```ts
 * import { stepGenerate } from "@alexkroman1/aai/utils";
 * import { throwStepError } from "@alexkroman1/aai/step-errors";
 *
 * export async function summarize(text: string): Promise<string> {
 *   "use step";
 *   return await stepGenerate(text, { system: "Summarize in two sentences." }).catch(
 *     throwStepError,
 *   );
 * }
 * ```
 *
 * @public
 */
export function throwStepError(cause: unknown, message?: string): never {
  throw toStepError(cause, message);
}

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
 *   waiting out a `Retry-After` the server named rather than the DevKit's
 *   one-second default. That distinction is the reason a step should never
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
 * import { stepFetchOk } from "@alexkroman1/aai/step-errors";
 *
 * export async function readFeed(url: string): Promise<string> {
 *   "use step";
 *   return await (await stepFetchOk(url, { signal: AbortSignal.timeout(30_000) })).text();
 * }
 * ```
 *
 * @throws {Error} a `FatalError` or `RetryableError` — see {@link toStepError}.
 * @public
 */
export async function stepFetchOk(url: string, init?: StepFetchInit): Promise<Response> {
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
 * Stop the DevKit retrying: throw a `FatalError` whatever the cause was.
 *
 * For the failure a step has DECIDED is terminal on grounds no status code
 * carries — a missing API key, a recording in a format the step cannot cut.
 * Three more attempts find the same gap, and spending them turns an immediate
 * failure into one that arrives a minute later saying the same thing.
 *
 * Separate from {@link toStepError} precisely because that one refuses to guess:
 * "I could not classify this" and "I classified this as terminal" are different
 * claims, and collapsing them would make every unclassified failure silently
 * unretryable.
 *
 * @example
 * ```ts
 * import { requireStepEnv } from "@alexkroman1/aai/utils";
 * import { throwFatalStepError } from "@alexkroman1/aai/step-errors";
 *
 * export function apiKey(): string {
 *   try {
 *     return requireStepEnv("ASSEMBLYAI_API_KEY");
 *   } catch (err) {
 *     return throwFatalStepError(err);
 *   }
 * }
 * ```
 *
 * @public
 */
export function throwFatalStepError(cause: unknown, message?: string): never {
  throw new FatalError(message ?? errorMessage(cause));
}

/**
 * A `RetryableError`, carrying the far side's own delay when it named one.
 *
 * `omitUndefined` rather than a spread-ternary, which is this repo's one
 * spelling of an optional field (`guard-invariants.mjs` rule 2) — and it is not
 * merely style here: `RetryableError` reads the option for PRESENCE
 * (`options.retryAfter !== undefined`), so a key that is present and undefined
 * behaves the same as an absent one but says something different.
 *
 * Note what "no delay" means downstream: the class does not leave `retryAfter`
 * unset, it defaults it to **one second from now**. So omitting a known
 * `Retry-After` is not "let the DevKit decide" so much as "retry in a second",
 * which is exactly the behaviour a rate limit punishes.
 */
function retryableError(message: string, at: Date | undefined): RetryableError {
  return new RetryableError(message, omitUndefined({ retryAfter: at }));
}
