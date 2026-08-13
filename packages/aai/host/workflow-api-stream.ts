// Copyright 2026 the AAI authors. MIT license.
/**
 * `GET /workflows/runs/:id/stream` — what a run has WRITTEN, as server-sent
 * events.
 *
 * The sibling of `workflow-api-events.ts`, and the split between them is the
 * whole reason both exist. That one streams the run's STATE: the status
 * transitions the world records, which every run has whether or not it ever
 * wrote anything. This streams the run's own OUTPUT — the chunks a `"use step"`
 * function pushed into `getWritable()` — which is the only way a long run can say
 * anything before it finishes, because a snapshot carries a status and, once
 * terminal, an output, and nothing in between. A dashboard usually wants both:
 * one to know the run is alive, one to know what it is doing.
 *
 * Its own module rather than more cases in `workflow-api.ts`, which is at the
 * repo's line cap; the seam falls here because nothing below knows what a
 * workflow is beyond "a run id names a stream of values".
 *
 * @internal
 */

import type http from "node:http";
import type { StreamOptions } from "../sdk/workflow.ts";
import type { RunReader } from "./workflow-api-events.ts";
import { sendJson } from "./workflow-api-http.ts";

/** What this route needs of the client: read the run, then read its stream. */
export type StreamReader = RunReader & {
  stream(runId: string, options?: StreamOptions): Promise<ReadableStream<unknown>>;
};

/**
 * Serve one run's written chunks as SSE.
 *
 * The run is READ FIRST, for the same reason the events route reports `missing`
 * as its own frame: `ctx.workflows.stream` is lazy, so an unknown id would
 * otherwise open a 200 event stream and fail on the first pull — which a page
 * reads as a broken connection rather than as a wrong id.
 *
 * Frames are `chunk` (one per written value, JSON-encoded) then `done`. There is
 * deliberately no `idle` frame and no heartbeat, unlike the events stream: this
 * one ends when the writer closes, so there is nothing to keep alive across a
 * long sleep — a reader following a run across one reconnects with `startIndex`.
 */
export async function streamRunOutput(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  engine: StreamReader,
  runId: string,
): Promise<void> {
  const run = runId ? await engine.get(runId) : undefined;
  if (!run) {
    sendJson(res, 404, { error: `No workflow run with id ${runId}` });
    return;
  }
  const params = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const namespace = params.get("namespace");
  const startIndexParam = params.get("startIndex");
  const startIndex = startIndexParam === null ? undefined : Number(startIndexParam);
  // An integer check rather than `isFinite`: a chunk index is a position, and
  // `startIndex=1.5` is a caller mistake worth naming rather than truncating.
  if (startIndex !== undefined && !Number.isInteger(startIndex)) {
    sendJson(res, 400, { error: "`startIndex` must be an integer" });
    return;
  }
  const stream = await engine.stream(runId, {
    ...(namespace !== null && { namespace }),
    ...(startIndex !== undefined && { startIndex }),
  });
  await pipeChunksAsSse(res, stream, runId);
}

/**
 * Write a run's chunks out as SSE, ending cleanly whichever side stops first.
 *
 * Cancelling the reader when the CLIENT goes away is the half that is easy to
 * miss: without it a page navigating away mid-run leaves this pulling chunks out
 * of the world for a response nobody will receive, once per abandoned view.
 */
async function pipeChunksAsSse(
  res: http.ServerResponse,
  stream: ReadableStream<unknown>,
  runId: string,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Proxies that buffer would defeat the point; the conventional opt-out, and
    // inert where it is not understood.
    "X-Accel-Buffering": "no",
  });
  const reader = stream.getReader();
  let gone = false;
  const onClose = (): void => {
    gone = true;
    void reader.cancel().catch(() => {
      // The client is already gone; a cancel that fails has nobody to tell.
    });
  };
  res.on("close", onClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || gone) break;
      res.write(`event: chunk\ndata: ${JSON.stringify(value ?? null)}\n\n`);
    }
    if (!gone) res.write(`event: done\ndata: ${JSON.stringify({ runId })}\n\n`);
  } finally {
    res.off("close", onClose);
    // Ending a response whose socket is already gone is a no-op that logs; the
    // `close` handler has done the only teardown that matters.
    if (!gone) res.end();
  }
}
