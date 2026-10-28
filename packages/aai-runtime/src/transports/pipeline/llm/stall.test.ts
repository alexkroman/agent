// Copyright 2026 the AAI authors. MIT license.
// The between-chunks clock, on the model's own stream. End-to-end behaviour (the
// retry, a slow tool running to completion) is in stream-stall.test.ts.

import { type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel } from "../../../_pipeline-test-fakes.ts";
import { withChunkWatchdog } from "./stall.ts";

type Part = { type: "stream-start"; warnings: [] } | { type: "text-start"; id: string };

/** A model whose one stream is driven by hand: `send` a part, `end` or `fail` it. */
function handDrivenModel(): {
  model: LanguageModel;
  send: (part: Part) => void;
  end: () => void;
  fail: (error: Error) => void;
} {
  const fake = createFakeLanguageModel({ script: [] });
  if (typeof fake === "string") throw new Error("expected a model object");
  let controller: ReadableStreamDefaultController<Part> | undefined;
  const stream = new ReadableStream<Part>({
    start(c) {
      controller = c;
    },
  });
  const middleware: LanguageModelMiddleware = { wrapStream: async () => ({ stream }) };
  return {
    model: wrapLanguageModel({ model: fake, middleware }),
    send: (part) => controller?.enqueue(part),
    end: () => controller?.close(),
    fail: (error) => controller?.error(error),
  };
}

/** Open the watched model's stream and read it in the background. */
async function open(model: LanguageModel, signal: AbortSignal): Promise<void> {
  if (typeof model === "string") throw new Error("expected a model object");
  const { stream } = await model.doStream({ prompt: [], abortSignal: signal });
  const reader = stream.getReader();
  const drain = async (): Promise<void> => {
    while (!(await reader.read()).done) {
      // Read and discard: the clock watches the source, not this reader.
    }
  };
  void drain().catch(() => undefined);
}

describe("withChunkWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a gap between chunks aborts the request, and the watchdog says it fired", async () => {
    const hand = handDrivenModel();
    const watched = withChunkWatchdog(hand.model, 100, new AbortController().signal);
    await open(watched.model, watched.signal);
    hand.send({ type: "stream-start", warnings: [] });
    await vi.advanceTimersByTimeAsync(99);
    expect(watched.signal.aborted).toBe(false);
    expect(watched.stalled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(watched.signal.aborted).toBe(true);
    expect(watched.stalled()).toBe(true);
    expect((watched.signal.reason as DOMException).name).toBe("TimeoutError");
  });

  test("each chunk re-arms the clock", async () => {
    const hand = handDrivenModel();
    const watched = withChunkWatchdog(hand.model, 100, new AbortController().signal);
    await open(watched.model, watched.signal);
    for (let i = 0; i < 5; i++) {
      hand.send({ type: "text-start", id: String(i) });
      await vi.advanceTimersByTimeAsync(90);
    }
    expect(watched.signal.aborted).toBe(false);
  });

  // The whole point: a step's tools run AFTER its model stream ends.
  test("once the model's stream ends, no wait aborts the request", async () => {
    const hand = handDrivenModel();
    const watched = withChunkWatchdog(hand.model, 100, new AbortController().signal);
    await open(watched.model, watched.signal);
    hand.send({ type: "stream-start", warnings: [] });
    hand.end();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watched.signal.aborted).toBe(false);
  });

  // A barge-in aborts the request, which errors its stream: the clock must not
  // fire later into a request that already ended.
  test("a stream that errors disarms the clock", async () => {
    const hand = handDrivenModel();
    const watched = withChunkWatchdog(hand.model, 100, new AbortController().signal);
    await open(watched.model, watched.signal);
    hand.send({ type: "stream-start", warnings: [] });
    hand.fail(new Error("aborted"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watched.stalled()).toBe(false);
  });

  test("the caller's own abort still reaches the request", () => {
    const hand = handDrivenModel();
    const turn = new AbortController();
    const watched = withChunkWatchdog(hand.model, 100, turn.signal);
    turn.abort();
    expect(watched.signal.aborted).toBe(true);
  });

  // An id cannot be wrapped, so it keeps the SDK's own between-chunks clock
  // rather than losing a mid-stream deadline altogether.
  test("a model given by id is passed through, with the SDK's chunk clock", () => {
    const signal = new AbortController().signal;
    const watched = withChunkWatchdog("openai/gpt-5", 100, signal);
    expect(watched).toMatchObject({ model: "openai/gpt-5", signal, chunkMs: 100 });
    expect(watched.stalled()).toBe(false);
  });
});
