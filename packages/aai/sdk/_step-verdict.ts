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
 * subpath exists at all. The `FatalError`/`RetryableError` it reaches for are
 * this repo's own (`step-error-classes.ts`); they were the Workflow DevKit's
 * until the replay engine that reads a verdict moved in-tree.
 */

import { isRecord } from "./is-record.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { FatalError, RetryableError } from "./step-error-classes.ts";
import { isTransientStatus, retryAfter } from "./step-retry.ts";
import { errorMessage } from "./utils.ts";

/**
 * The step error one failure deserves.
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
 *   in a plain `Error` if it is not. Both are retryable by the engine's default,
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
 *   const response = await fetch(`https://api.example.com/orders/${id}`);
 *   if (!response.ok) throw toStepError(response, `Order ${id}: HTTP ${response.status}`);
 *   return await response.json();
 * }
 * ```
 *
 * @public
 */
export function toStepError(cause: unknown, message?: string): Error {
  if (isResponseLike(cause)) {
    const sentence = message ?? `HTTP ${cause.status}`;
    // The response rides along as the `cause` for the same reason the arms
    // below carry theirs: what a caller has left otherwise is a sentence, and
    // the headers and the status it was derived FROM are what a reader debugs
    // with. It is not journaled — the log's codec keeps a message and nothing
    // else (`workflow-replay-step.ts` says so) — so this is for the process
    // that threw it, and `stepFetchOk` has already read the body by the time it
    // gets here.
    if (!isTransientStatus(cause.status)) return new FatalError(sentence, { cause });
    return retryableError(sentence, retryAfter(cause), cause);
  }
  if (hasCarriedVerdict(cause)) return fromCarriedVerdict(cause, message);
  // No verdict is available, so none is invented — see this function's doc.
  if (cause instanceof Error && message === undefined) return cause;
  return new Error(message ?? errorMessage(cause), { cause });
}

/**
 * Whether `cause` is a `Response` — recognised STRUCTURALLY, never with
 * `instanceof`, for the reason {@link hasCarriedVerdict} gives one paragraph
 * down and one this function was PAYING when it read `cause instanceof
 * Response`.
 *
 * A step's HTTP goes through the `stepFetch` SLOT, and the host publishes an
 * implementation built on the `undici` PACKAGE — whose `Response` is a
 * different class from `globalThis.Response`, even in one realm. So the
 * response a step is handed does not satisfy `instanceof Response` against the
 * binding this module can see. Measured under `aai dev`:
 * `{ instanceofResponse: false, ctor: "Response", realmTag: "[object Response]",
 * globalResponseIsSame: true }` — the object IS a response, the global binding
 * IS the same one, and the two constructors still never meet.
 *
 * What that cost is the whole of this module's job, silently: every `Response`
 * fell through to the unclassifiable arm and came back a plain `Error`, which
 * the engine retries with its own one-second default. Both of the two things
 * this function exists to decide were therefore inert in production, measured
 * against a stub far side through a real step bundle:
 *
 * | | `instanceof` | structural |
 * | --- | --- | --- |
 * | 401, fatal by contract | 3455ms, 3 retries | 349ms, ONE attempt |
 * | 503 asking `Retry-After: 5` | 3334ms (a 1s cadence) | 15,345ms (3 x 5s) |
 *
 * A bad credential spent the whole retry budget re-asking with a key that could
 * never work, and a rate limit's own delay was discarded — so N fan-out
 * siblings all asked again one second later, which is the exact pile-up
 * `stepFetchOk` and the `*Classified` wrappers were written to prevent. An
 * explicit `throw new FatalError(...)` from the same step stopped in 378ms
 * throughout, which is what located the fault here rather than in the DevKit.
 *
 * The shape is narrow enough not to catch anything else this function takes: a
 * carried verdict has `message`/`retryable` and no `ok`, and an `Error` has
 * neither `status` nor `ok`.
 */
function isResponseLike(cause: unknown): cause is Response {
  return (
    isRecord(cause) &&
    typeof cause.status === "number" &&
    typeof cause.ok === "boolean" &&
    isRecord(cause.headers) &&
    typeof cause.headers.get === "function"
  );
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
 * the only thing that WORKS here: `toStepError` runs inside step bodies,
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
  // Carrying the original is the whole difference between "the gateway refused
  // this" and a stack pointing at this line: the causes reaching here are the
  // SDK's own errors, each with the far side's detail on it, and `message`
  // routinely replaces their sentence — which is exactly when dropping them
  // loses everything.
  if (!cause.retryable) return new FatalError(sentence, { cause });
  return retryableError(sentence, cause.retryAfter, cause);
}

/**
 * {@link toStepError}, thrown.
 *
 * The form a `.catch()` takes, which is the shape both LLM templates want:
 * `stepGenerate` rejects with a `StepGenerateError` and the step wants
 * that classified before it reaches the engine.
 *
 * It is a function taking the cause as an ARGUMENT rather than a `throw` inside
 * a `catch` block, and that is mechanical rather than stylistic: what Biome's
 * `useErrorCause` asks of an error constructed inside a `catch` is that it carry
 * the one being handled, and a call site cannot forget to do that here — the
 * cause is the first parameter, and both of these attach it. Nothing is being
 * swallowed either way: the original is what was passed in.
 *
 * @example
 * ```ts
 * import { stepGenerate } from "@alexkroman1/aai/step";
 * import { throwStepError } from "@alexkroman1/aai/step-errors";
 *
 * export async function summarize(text: string): Promise<string> {
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
 * Stop the engine retrying: throw a `FatalError` whatever the cause was.
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
  // `cause` and not only its sentence, which is what a journaled failure and a
  // log line are read from: a step written the documented way —
  // `catch (err) { return throwFatalStepError(err); }` — otherwise reported one
  // sentence with the stack and the chain under it thrown away, and the
  // original's own `cause` with them. It is attached rather than merely
  // MENTIONED because `message` routinely replaces the cause's sentence, which
  // is the case where dropping it loses everything.
  throw new FatalError(message ?? errorMessage(cause), { cause });
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
 * `Retry-After` is not "let the engine decide" so much as "retry in a second",
 * which is exactly the behaviour a rate limit punishes.
 *
 * `cause` goes through the same helper for the same reason, and every caller
 * passes one: an error that names only its sentence is the thing this module
 * kept producing.
 */
function retryableError(message: string, at: Date | undefined, cause?: unknown): RetryableError {
  return new RetryableError(message, omitUndefined({ retryAfter: at, cause }));
}
