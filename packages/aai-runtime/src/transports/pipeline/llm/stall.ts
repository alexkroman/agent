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
 * calls execute. It aborts the request with the same `TimeoutError` shape the
 * SDK's clocks use, so `isStallTimeout` reads both alike. The FIRST-chunk clock
 * stays the SDK's: it is cleared by the first output chunk, so it is never armed
 * while a tool runs.
 *
 * A model given by ID cannot be wrapped (`wrapLanguageModel` takes an object;
 * the SDK resolves an id itself), so it keeps the SDK's `chunkMs`: tool time
 * counts against it, which still beats no mid-stream deadline at all.
 */

import { type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { createCoalescingTimer } from "../../../_timer.ts";

/**
 * Wrap `model` so a gap of `ms` between two of its stream chunks aborts the
 * request. Answers the request's model and signal, and the SDK `chunkMs` to
 * set — present only for a model given by id, which cannot be wrapped.
 */
export function withChunkWatchdog(
  model: LanguageModel,
  ms: number,
  signal: AbortSignal,
): { model: LanguageModel; signal: AbortSignal; chunkMs?: number } {
  if (typeof model === "string") return { model, signal, chunkMs: ms };
  const stall = new AbortController();
  const middleware: LanguageModelMiddleware = {
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();
      // Re-armed on every chunk: the coalescing timer keeps ONE pending timeout.
      const clock = createCoalescingTimer(() =>
        stall.abort(new DOMException(`Chunk timeout of ${ms}ms exceeded`, "TimeoutError")),
      );
      signal.addEventListener("abort", clock.clear, { once: true });
      return {
        ...rest,
        stream: stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              clock.arm(ms);
              controller.enqueue(chunk);
            },
            flush() {
              clock.clear();
              signal.removeEventListener("abort", clock.clear);
            },
          }),
        ),
      };
    },
  };
  return {
    model: wrapLanguageModel({ model, middleware }),
    signal: AbortSignal.any([signal, stall.signal]),
  };
}
