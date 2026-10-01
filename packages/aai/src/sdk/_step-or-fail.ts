// Copyright 2026 the AAI authors. MIT license.
/**
 * The FUNCTION arm of `orFail`: a call, with its failure classified for the
 * step engine.
 *
 * `orFail(stepGenerate)` is the one spelling for what eight `*OrFail` twins on
 * `@alexkroman1/aai/step-errors` used to spell one name each. Every twin was the
 * call plus {@link throwStepError}, and `stepFetchOrFail` added the one branch
 * the others had no use for: a resolved `Response` that is not `ok` is a
 * failure too, because `fetch` RESOLVES a 503. That branch is here as well, so
 * `orFail(stepFetch)` is the old `stepFetchOrFail` exactly — same verdict, same
 * message, labelled by the request (`GET https://…`) whenever the call's first
 * argument is a URL.
 *
 * `_`-prefixed because it is not an import path: `orFail` is declared once, in
 * `tool-failure-flow.ts`, and dispatches here when handed a function — one
 * declaration so the root barrel and `/step-errors` publish the SAME `orFail`
 * rather than two names that read alike and mean different things.
 */

import { isResponseLike, throwStepError, toStepError } from "./_step-verdict.ts";
import { isRecord } from "./is-record.ts";
import { responseErrorMessage } from "./utils.ts";

/**
 * A thenable, recognised structurally — an async function in a bundle with its
 * own Promise realm is still one.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

/**
 * What a failed `Response` is labelled by in the thrown message: the REQUEST,
 * when the call was handed a URL first (`stepFetch(url, init)`), because a
 * run's log holds many of these and a status alone does not say which call
 * answered. Otherwise the response's own `url`, when it has one.
 */
function requestLabel(args: readonly unknown[], response: Response): string | undefined {
  const [target, init] = args;
  if (typeof target === "string" || target instanceof URL) {
    const method = isRecord(init) && typeof init.method === "string" ? init.method : "GET";
    return `${method} ${String(target)}`;
  }
  return response.url === "" ? undefined : response.url;
}

/** A settled value: unchanged, unless it is a non-2xx `Response`. */
async function settled(value: unknown, args: readonly unknown[]): Promise<unknown> {
  if (!isResponseLike(value) || value.ok) return value;
  throw toStepError(value, await responseErrorMessage(value, requestLabel(args, value)));
}

/**
 * `call`, wrapped so that what it throws — or a non-2xx `Response` it resolves
 * to — leaves as the verdict {@link toStepError} reaches: `FatalError` for a
 * failure that will answer the same way, `RetryableError` carrying the far
 * side's `Retry-After` for one that will not, and anything unclassifiable
 * unchanged.
 *
 * Answers in kind: a sync `call` stays sync (its throw is classified, its
 * value returned as is), an async one is awaited.
 */
export function classifiedCall<A extends readonly unknown[], R>(
  call: (...args: A) => R,
): (...args: A) => R {
  return (...args: A): R => {
    let out: R;
    try {
      out = call(...args);
    } catch (err) {
      return throwStepError(err);
    }
    if (!isThenable(out)) return out;
    return Promise.resolve(out).then(
      (value) => settled(value, args),
      (err: unknown) => throwStepError(err),
    ) as R;
  };
}
