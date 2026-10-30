// Copyright 2026 the AAI authors. MIT license.
/**
 * The pipeline's own retry of a FAILED provider call, with a bound on how long
 * a turn will wait for it.
 *
 * **Not the AI SDK's `maxRetries`, because that one waits as long as the
 * provider asks.** ai@7 honours `retry-after` / `retry-after-ms` up to 60 s per
 * attempt (`getRetryDelayInMs`), and the wait runs BEFORE the SDK starts its
 * first-chunk clock — so `LLM_STALL_TIMEOUT_MS` (`./stream.ts`) never sees it.
 * Measured on a tau2-bench voice run, eight sessions on one Cerebras key: 429s
 * ("token_quota_exceeded", "queue_exceeded") whose retry-after the SDK obeyed
 * produced turns whose first token came 59.6–62.9 s after the request, and the
 * caller sat through the dead-air filler for that whole minute. A phone caller
 * does not wait a minute; failing the turn quickly and saying so is the better
 * answer, and the next turn usually lands once the window rolls over.
 *
 * So the pipeline sends `maxRetries: 0` to `streamText` for any model it can
 * wrap, and retries here instead — the same count (the author's `maxRetries`,
 * the SDK's default of 2 when unset) and the same retryable errors, but every
 * wait drawn from one per-request budget, {@link LLM_RETRY_BUDGET_MS}. A delay
 * that would overdraw the budget is not waited at all: the provider has said a
 * retry sooner will fail, so the error is surfaced now and the turn speaks
 * `errorPhrase`.
 *
 * A `fallback([...])` model is wrapped WHOLE, so a rate-limited primary still
 * moves on to the next member at once (`providers/_fallback-llm.ts` advances on
 * the throw, with no wait); only when every member fails does this retry, under
 * the same budget. A model given by id cannot be wrapped and keeps the SDK's
 * retry, as `./stall.ts` explains for its watchdog.
 */

import { sleep } from "@alexkroman1/aai/internal";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import {
  APICallError,
  type LanguageModel,
  type LanguageModelMiddleware,
  wrapLanguageModel,
} from "ai";
import type { Logger } from "../../../logger.ts";

/**
 * Total time one request may spend WAITING between retries of a failed call.
 *
 * 4 s: the exponential backoff below (1 s, then 2 s) fits inside it, so a
 * transient 5xx or a short 429 is still retried twice. A `retry-after` of
 * 60 s does not, and is surfaced at once instead of being waited out. The
 * opening dead-air filler lands ~4.6 s after the caller's last word
 * (`DEAD_AIR_OPENING_TARGET_MS`), so a turn that spends the whole budget and
 * then fails says `errorPhrase` around the time it would otherwise have said
 * its first filler.
 */
export const LLM_RETRY_BUDGET_MS = 4000;

/** First backoff when the provider names no `retry-after`; doubles per retry. */
export const LLM_RETRY_INITIAL_DELAY_MS = 1000;

/** The AI SDK's own default, kept so an unset `maxRetries` means what it did. */
export const DEFAULT_LLM_MAX_RETRIES = 2;

/** What {@link withBoundedRetries} needs beyond the model. */
export type BoundedRetryOptions = {
  /** Retries after the first attempt; unset is {@link DEFAULT_LLM_MAX_RETRIES}. */
  maxRetries?: number | undefined;
  /** Total wait across retries; unset is {@link LLM_RETRY_BUDGET_MS}. */
  budgetMs?: number | undefined;
  log: Logger;
  sid: string;
};

/**
 * The provider's own answer to "when may I retry", in ms — `retry-after-ms`,
 * then `retry-after` as seconds or an HTTP date — read the way the AI SDK
 * reads it, or `undefined` when it named none.
 */
export function requestedRetryDelayMs(error: unknown): number | undefined {
  const headers = responseHeaders(error);
  if (headers === undefined) return undefined;
  const ms = Number.parseFloat(headers["retry-after-ms"] ?? "");
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const after = headers["retry-after"];
  if (after === undefined) return undefined;
  const seconds = Number.parseFloat(after);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(after);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function responseHeaders(error: unknown): Record<string, string | undefined> | undefined {
  if (APICallError.isInstance(error)) return error.responseHeaders;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return APICallError.isInstance(cause) ? cause.responseHeaders : undefined;
}

/**
 * Retryable by the SDK's own test: an `APICallError` (or the gateway's error)
 * that marks itself `isRetryable` — 408, 409, 429 and 5xx, and network
 * failures.
 */
function isRetryable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { isRetryable?: unknown }).isRetryable === true
  );
}

/**
 * How long to wait before retry `attempt + 1` of a call that failed with
 * `err`, having already waited `waitedMs` — or `undefined` to surface `err`
 * now: the call was aborted, the attempts are spent, the failure is not
 * retryable, or the wait would overdraw the budget.
 */
function nextRetryDelay(
  err: unknown,
  state: { attempt: number; waitedMs: number; aborted: boolean },
  limits: { maxRetries: number; budgetMs: number; log: Logger; sid: string },
): number | undefined {
  if (state.aborted || state.attempt >= limits.maxRetries || !isRetryable(err)) return undefined;
  const delayMs = requestedRetryDelayMs(err) ?? LLM_RETRY_INITIAL_DELAY_MS * 2 ** state.attempt;
  const meta = {
    sid: limits.sid,
    attempt: state.attempt + 1,
    delayMs,
    waitedMs: state.waitedMs,
    budgetMs: limits.budgetMs,
    error: errorMessage(err),
  };
  if (state.waitedMs + delayMs > limits.budgetMs) {
    // LOGGED, because this is the line that explains a turn which failed in a
    // second against a provider that only asked for a wait.
    limits.log.warn("LLM retry delay exceeds budget; failing the turn", meta);
    return undefined;
  }
  limits.log.info("LLM call failed; retrying", meta);
  return delayMs;
}

/**
 * Wrap `model` so a failed `doStream` is retried within the budget — see the
 * module doc. A model given by id is returned as-is (`wrapped: false`), and the
 * caller leaves the SDK's `maxRetries` in charge of it.
 */
export function withBoundedRetries(
  model: LanguageModel,
  opts: BoundedRetryOptions,
): { model: LanguageModel; wrapped: boolean } {
  if (typeof model === "string") return { model, wrapped: false };
  const limits = {
    maxRetries: opts.maxRetries ?? DEFAULT_LLM_MAX_RETRIES,
    budgetMs: opts.budgetMs ?? LLM_RETRY_BUDGET_MS,
    log: opts.log,
    sid: opts.sid,
  };
  const middleware: LanguageModelMiddleware = {
    wrapStream: async ({ doStream, params }) => {
      const signal = params.abortSignal;
      let waitedMs = 0;
      for (let attempt = 0; ; attempt++) {
        try {
          return await doStream();
        } catch (err: unknown) {
          const aborted = signal?.aborted === true;
          const delayMs = nextRetryDelay(err, { attempt, waitedMs, aborted }, limits);
          if (delayMs === undefined) throw err;
          waitedMs += delayMs;
          // `sleep` resolves on abort; the re-check is what turns a barge-in
          // (or the stall clock) during the wait into the abort it is.
          await sleep(delayMs, omitUndefined({ signal }));
          if (signal?.aborted) throw signal.reason ?? err;
        }
      }
    },
  };
  return { model: wrapLanguageModel({ model, middleware }), wrapped: true };
}
