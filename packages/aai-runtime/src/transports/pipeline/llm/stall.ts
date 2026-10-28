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
 */

import { type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from "ai";

/** The request's model and signal, with the chunk clock folded into both. */
export type ChunkWatchdog = { model: LanguageModel; signal: AbortSignal };

/**
 * Wrap `model` so a gap of `ms` between two of its stream chunks aborts the
 * request. A model given by id (a string) has no stream to wrap and is
 * returned as-is: the first-chunk clock still covers it.
 *
 * @internal
 */
export function withChunkWatchdog(
  model: LanguageModel,
  ms: number,
  signal: AbortSignal,
): ChunkWatchdog {
  if (typeof model === "string") return { model, signal };
  const stall = new AbortController();
  const middleware: LanguageModelMiddleware = {
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const disarm = () => clearTimeout(timer);
      const arm = () => {
        disarm();
        timer = setTimeout(
          () => stall.abort(new DOMException(`Chunk timeout of ${ms}ms exceeded`, "TimeoutError")),
          ms,
        );
      };
      signal.addEventListener("abort", disarm, { once: true });
      return {
        ...rest,
        stream: stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              arm();
              controller.enqueue(chunk);
            },
            flush() {
              disarm();
              signal.removeEventListener("abort", disarm);
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
