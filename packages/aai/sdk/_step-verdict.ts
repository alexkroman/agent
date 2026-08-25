// Copyright 2026 the AAI authors. MIT license.
/**
 * The VERDICT: what failed, and whether another attempt could go differently.
 *
 * Its own module because `sdk/step-errors.ts` outgrew the 500-line cap, and the
 * seam is the one that file's doc already draws. Everything here answers one
 * question — fatal, retryable, or unclassifiable — and depends on nothing else
 * in the subpath. Everything that stayed CONSUMES an answer: `stepFetchOk` and
 * `throwFfmpegStepError` reach one from a shape they recognise, and the seven
 * `*Classified` callers attach {@link throwStepError} to a call.
 *
 * Cutting it the other way round — the classified callers out, the verdict in —
 * is the obvious split and does not work: those callers need
 * {@link throwStepError}, so the two files would import each other. The
 * dependency runs one way now.
 *
 * `_`-prefixed because it is not an import path. `@alexkroman1/aai/step-errors`
 * is, and it publishes every name here — read that module's doc for why this
 * subpath exists at all and why it is the one authoring module allowed to name
 * the DevKit's `workflow` package.
 */

import { FatalError, RetryableError } from "workflow";
import { isRecord } from "./is-record.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { isTransientStatus, retryAfter } from "./step-retry.ts";
import { errorMessage } from "./utils.ts";

/**
 * The DevKit error one failure deserves.
 *
 * `cause` decides how the verdict is reached, and the three cases are the three
 * ways a step learns it failed:
 *
 * - A **`Response`** — a non-2xx from an API the step called. Transient by
 *   `isTransientStatus` (`/step`), with the delay from its `Retry-After`
 *   when it named one.
 * - A **`ChannelDeliveryError`** (`@alexkroman1/aai/channels`) — a platform
 *   that refused a post, having already reached the same verdict. A 4xx from a
 *   webhook is terminal by construction: a revoked webhook and a wrong
 *   variable name answer identically on every attempt.
 * - A **`StepGenerateError`** or a **`TranscribeError`** (both `/step`) — the
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
  if (hasCarriedVerdict(cause)) return fromCarriedVerdict(cause, message);
  // No verdict is available, so none is invented — see this function's doc.
  if (cause instanceof Error && message === undefined) return cause;
  return new Error(message ?? errorMessage(cause), { cause });
}

/** An error that has already classified its own failure. */
type CarriedVerdict = {
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfter: Date | undefined;
};

/**
 * Whether `cause` carries its own verdict — recognised STRUCTURALLY, never with
 * `instanceof`.
 *
 * The shape IS the contract, which is what lets a fourth SDK error join by
 * having these fields rather than by earning another branch. Structural is also
 * the only thing that WORKS here: `toStepError` runs inside `"use step"` bodies,
 * where an error can arrive rehydrated from the durable journal with no
 * prototype — an `instanceof` chain silently misses those and a
 * `retryable: false` refusal comes back out as retryable. `step-errors.ts` made
 * the same call for `FfmpegError`, for the same reason.
 */
function hasCarriedVerdict(cause: unknown): cause is CarriedVerdict {
  return (
    isRecord(cause) &&
    typeof cause.message === "string" &&
    typeof cause.retryable === "boolean" &&
    (cause.retryAfter === undefined || cause.retryAfter instanceof Date)
  );
}

function fromCarriedVerdict(cause: CarriedVerdict, message: string | undefined): Error {
  const sentence = message ?? cause.message;
  if (!cause.retryable) return new FatalError(sentence);
  return retryableError(sentence, cause.retryAfter);
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
 * import { stepGenerate } from "@alexkroman1/aai/step";
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
 * import { requireStepEnv } from "@alexkroman1/aai/step";
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
