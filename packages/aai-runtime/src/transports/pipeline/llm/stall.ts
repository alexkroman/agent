// Copyright 2026 the AAI authors. MIT license.
/**
 * The between-chunks half of the stall deadline (`LLM_STALL_TIMEOUT_MS` in
 * `./stream.ts`), timed on the MODEL's own stream.
 *
 * **Not the AI SDK's `timeout.chunkMs`, because that clock counts tool time.**
 * In ai@7 it is reset by each output chunk — the `tool-call` chunk included —
 * and cleared only when the step finishes, which is AFTER the step's tools have
 * run; its abort is merged into the signal every tool's `execute` receives. So
 * a tool slower than the deadline (a web search, `run_code`, a slow API, a
 * client tool) was aborted mid-call, and the turn failed with no retry, since
 * the tool call was already output. A write could be cut off part-way.
 *
 * This clock runs inside the provider stream itself: armed by each chunk the
 * model sends, cleared when that stream ends — which is before any of its tool
 * calls execute. It aborts the request with a `TimeoutError` and REPORTS that
 * it fired (`stalled()`), so nothing has to recognize its wording. It is also
 * armed while the request is being OPENED (retries included), which no SDK
 * clock covers. The FIRST-chunk clock after that stays the SDK's: it is cleared
 * by the first output chunk, so it is never armed while a tool runs.
 *
 * A model given by ID cannot be wrapped (`wrapLanguageModel` takes an object;
 * the SDK resolves an id itself), so it keeps the SDK's `chunkMs`: tool time
 * counts against it, which still beats no mid-stream deadline at all.
 */

import type { Transformer } from "node:stream/web";
import { type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { createCoalescingTimer, type RestartableTimer } from "../../../_timer.ts";

/**
 * Wrap `model` so a gap of `ms` between two of its stream chunks aborts the
 * request. Answers the request's model and signal, whether the watchdog
 * fired, and the SDK `chunkMs` to set — present only for a model given by id,
 * which cannot be wrapped.
 */
export function withChunkWatchdog(
  model: LanguageModel,
  ms: number,
  signal: AbortSignal,
): { model: LanguageModel; signal: AbortSignal; stalled: () => boolean; chunkMs?: number } {
  if (typeof model === "string") return { model, signal, stalled: () => false, chunkMs: ms };
  const stall = new AbortController();
  const middleware: LanguageModelMiddleware = {
    wrapStream: async ({ doStream }) => {
      // Re-armed on every chunk: the coalescing timer keeps ONE pending timeout.
      const clock = createCoalescingTimer(() =>
        stall.abort(
          new DOMException(`Stream timeout: no model output for ${ms}ms`, "TimeoutError"),
        ),
      );
      // Armed BEFORE the call, not on its first chunk: opening the response
      // is where retries wait (`./retry.ts`) and where a provider that queues
      // requests holds them, and the SDK's first-chunk clock only starts once
      // `doStream` has resolved. Without this a request could sit unanswered
      // for undici's 300 s header timeout, the wait the stall deadline exists
      // to cut. A call that fails disarms it — the failure is the answer.
      clock.arm(ms);
      let opened: Awaited<ReturnType<typeof doStream>>;
      try {
        opened = await doStream();
      } catch (err: unknown) {
        clock.clear();
        throw err;
      }
      const { stream, ...rest } = opened;
      return {
        ...rest,
        stream: stream.pipeThrough(clockedPassThrough(clock, ms)),
      };
    },
  };
  return {
    model: wrapLanguageModel({ model, middleware }),
    signal: AbortSignal.any([signal, stall.signal]),
    stalled: () => stall.signal.aborted,
  };
}

/**
 * Pass chunks through, re-arming `clock` on each. Every way the stream can
 * stop disarms it: it ended (`flush`), or it errored or was cancelled — a
 * barge-in aborting the request is both, and a pipe calls `cancel` on either.
 * A clock left armed would abort a request that had already finished.
 *
 * Typed with Node's `Transformer` (`cancel` included, Node >= 24 being this
 * package's floor), not the DOM lib's, which a consumer compiling this file
 * may load and which lacks it — hence an annotated variable, not a literal.
 */
function clockedPassThrough<T>(clock: RestartableTimer, ms: number): TransformStream<T, T> {
  const transformer: Transformer<T, T> = {
    transform(chunk, controller) {
      clock.arm(ms);
      controller.enqueue(chunk);
    },
    flush: clock.clear,
    cancel: clock.clear,
  };
  return new TransformStream(transformer);
}
