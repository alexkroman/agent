// Copyright 2026 the AAI authors. MIT license.
/**
 * The server-sent-event parser every reader of an agent's streams goes through.
 *
 * The routes that serve them are `host/workflow-api-events.ts` (a run's state)
 * and `host/workflow-api-stream.ts` (what a run has written). Both speak the
 * same wire format, and this is the one place it is decoded.
 *
 * It is HERE, and public, for the reason the client beside it is: it had been
 * written twice already — once in `aai-ui/_sse.ts` for the two browser readers,
 * and the studio has a third for a different API — and a stream parser is the
 * kind of duplication that goes wrong quietly. The high-level iterators
 * ({@link WorkflowApi.follow}, {@link WorkflowApi.followOutput}) are what a
 * caller should reach for; this is what the caller who took the raw `Response`
 * from {@link WorkflowApi.watch} needs, and what keeps the browser client from
 * carrying a second copy.
 *
 * `EventSource` is deliberately not the mechanism anywhere here: it cannot send
 * an `Authorization` header, so an agent that sets `AAI_WORKFLOW_API_TOKEN`
 * would be unreachable, and it reconnects on its own schedule, which fights the
 * caller's.
 *
 * @example
 * ```ts
 * import { createAgentClient, readEventStream } from "@alexkroman1/aai/workflow-api";
 *
 * const agent = createAgentClient({ baseUrl: "https://agents.example/my-agent" });
 * const res = await agent.watch("wrun_1");
 * if (res.ok && res.body) {
 *   for await (const frame of readEventStream(res.body)) {
 *     if (frame.event === "run") console.log(frame.data);
 *   }
 * }
 * ```
 */

import { createParser } from "eventsource-parser";
import { safeJsonParse } from "./safe-json-parse.ts";

/**
 * One parsed frame. Comment frames (the heartbeats an idle stream sends) are
 * skipped rather than yielded, and so is a frame with no `event:` name — the
 * routes here name every frame they send, and an unnamed one cannot be
 * classified by any caller.
 *
 * @public
 */
export type EventStreamFrame = {
  /** The frame's `event:` name — `run`, `chunk`, `done`, `idle`, `missing`. */
  event: string;
  /**
   * The frame's `data:` line, JSON-parsed, or `undefined` when it was not JSON.
   *
   * Never a reason to tear the stream down: a run frame carries a WHOLE
   * snapshot, so the next one restates the same state, and a progress read is
   * re-opened from where it left off.
   */
  data: unknown;
};

/**
 * Parse an SSE byte stream into frames, with `eventsource-parser`.
 *
 * The parser is a dependency rather than a hand-rolled line splitter, and the
 * three edges that decided it are the three a splitter gets wrong:
 *
 * - Splitting on `"\n\n"` only. The spec permits `\n`, `\r\n` and `\r`, and a
 *   CRLF stream is `\r\n\r\n` — no two adjacent `\n`, so **not one frame ever
 *   parsed**, and an intermediary re-terminating lines is not our choice to
 *   make.
 * - `line.startsWith("event: ")` requires the space the spec makes optional.
 * - Keeping only the LAST `data:` line rather than joining a multi-line one.
 *
 * Three properties of the parser this leans on. `feed` invokes `onEvent`
 * SYNCHRONOUSLY for every complete event in the chunk, so a batch is collected
 * per read and yielded in arrival order. An event with no `data:` line at all is
 * not dispatched (also per spec); every frame these routes emit carries one. And
 * a chunk ending in a lone `\r` holds that byte back, because it may yet turn
 * out to be the first half of a `\r\n` — so a CR-ONLY stream chunked per frame
 * dispatches one frame behind, and its last frame not at all. Nothing emits
 * CR-only endings, and the outcome if anything did is the safe one for every
 * reader here: a stream that ends with no final frame is read as a dropped
 * connection.
 *
 * `signal` is optional because most callers already own the `fetch` that opened
 * the body — aborting that ends the read. Pass one when the reader's lifetime is
 * shorter than the request's.
 *
 * @public
 */
export async function* readEventStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<EventStreamFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let batch: EventStreamFrame[] = [];
  const parser = createParser({
    onEvent: ({ event, data }) => {
      if (event === undefined) return;
      // `safeJsonParse` rather than a local try/catch — see `EventStreamFrame.data`.
      batch.push({ event, data: safeJsonParse(data) });
    },
  });
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      parser.feed(decoder.decode(value, { stream: true }));
      if (batch.length === 0) continue;
      const frames = batch;
      batch = [];
      // An explicit loop, not `yield*`: async delegation awaits the array's
      // iterator per element, which adds turns of the microtask queue for no
      // reason and puts the frame count into this module's timing.
      for (const frame of frames) yield frame;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
