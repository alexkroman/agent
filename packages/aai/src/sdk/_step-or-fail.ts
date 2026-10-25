// Copyright 2026 the AAI authors. MIT license.
/**
 * The FUNCTION arm of `orFail`: a call, with its failure classified for the
 * step engine.
 *
 * `orFail(stepGenerate)` is the one spelling for what eight `*OrFail` twins on
 * `@alexkroman1/aai/step-errors` used to spell one name each (they are gone).
 * Every twin was the call plus {@link throwStepError}, and `stepFetchOrFail`
 * added the one branch the others had no use for: a resolved `Response` that is
 * not `ok` is a failure too, because `fetch` RESOLVES a 503. That branch is here
 * as well, so `orFail(stepFetch)` is the old `stepFetchOrFail` exactly — same
 * verdict, same message, labelled by the request (`GET https://…`) whenever the
 * call's first argument is a URL.
 *
 * `_`-prefixed because it is not an import path: `orFail` is declared once, in
 * `tool-failure-flow.ts`, and dispatches here when handed a function — one
 * declaration so the root barrel and `/step-errors` publish the SAME `orFail`
 * rather than two names that read alike and mean different things.
 */

import { isResponseLike, throwStepError, toStepError } from "./_step-verdict.ts";
import { isRecord } from "./is-record.ts";
import { isThenable } from "./is-thenable.ts";
import { responseErrorMessage } from "./utils.ts";

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
 * `call`, wrapped so that what it throws — or rejects with — leaves through
 * `fail`, and what it resolves with passes through `resolved`.
 *
 * Answers in kind: a sync `call` stays sync (its throw is classified, its
 * value returned as is — `resolved` is for the AWAITED value only), an async
 * one is awaited. The one shape behind {@link orFail}'s function arm and
 * `fatalOn` (`step-errors.ts`): each is a classifier, and this is the
 * call-then-classify they used to spell separately.
 *
 * @param fail - The verdict for a thrown value or a rejection; must throw.
 * @param resolved - What an awaited value becomes; by default itself.
 */
export function classifiedCall<A extends readonly unknown[], R>(
  call: (...args: A) => R,
  fail: (err: unknown) => never,
  resolved: (value: unknown, args: A) => unknown = (value) => value,
): (...args: A) => R {
  return (...args: A): R => {
    let out: R;
    try {
      out = call(...args);
    } catch (err) {
      return fail(err);
    }
    if (!isThenable(out)) return out;
    return Promise.resolve(out).then((value) => resolved(value, args), fail) as R;
  };
}

/**
 * `call` with its failure classified for the step engine — the verdict
 * {@link toStepError} reaches: `FatalError` for a failure that will answer the
 * same way, `RetryableError` carrying the far side's `Retry-After` for one that
 * will not, and anything unclassifiable unchanged. A non-2xx `Response` it
 * resolves to is a failure too.
 */
export function stepClassifiedCall<A extends readonly unknown[], R>(
  call: (...args: A) => R,
): (...args: A) => R {
  return classifiedCall(call, throwStepError, settled);
}
