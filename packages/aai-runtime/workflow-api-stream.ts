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
import { requestQuery } from "@alexkroman1/aai/host-internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { StreamOptions } from "@alexkroman1/aai/workflow-api";
import { isTerminal } from "@alexkroman1/aai/workflow-api";
import type { RunReader } from "./workflow-api-events.ts";
import { SSE_HEADERS, sendJson, sseFrame } from "./workflow-api-http.ts";

/** What this route needs of the client: the run, its stream, and the stream's end. */
export type StreamReader = RunReader & {
  stream(runId: string, options?: StreamOptions): Promise<ReadableStream<unknown>>;
  streamTail(runId: string, options?: StreamOptions): Promise<number>;
};

/**
 * Serve one run's written chunks as SSE.
 *
 * The run is READ FIRST, for the same reason the events route reports `missing`
 * as its own frame: `ctx.workflows.stream` is lazy, so an unknown id would
 * otherwise open a 200 event stream and fail on the first pull — which a page
 * reads as a broken connection rather than as a wrong id.
 *
 * Frames are `chunk` (one per written value, JSON-encoded) then `done`, whose
 * payload carries `complete` — whether the RUN was already terminal when the read
 * started. A reader handed `complete: false` re-opens from where it left off; one
 * handed `complete: true` is finished.
 *
 * ## It is BOUNDED BY THE TAIL, and that is what makes it terminate
 *
 * A workflow stream reports its end only once it has been CLOSED, and a progress
 * channel never is: successive steps append to it and no step knows it is the
 * last. So piping the readable until it ends hangs forever — including on a
 * COMPLETED run, which is the case a page hits most. Measured before this was
 * bounded, against a real transformed workflow: `GET /runs/:id/stream` on a
 * finished two-line run held the response open until the suite's 120-second
 * timeout, and no unit test could see it because a fake stream is a closed one.
 *
 * So the read is bounded by `streamTail()` — the index of the last chunk written
 * at the moment the request arrived — and ends there. That makes progress a
 * durable log a reader RE-READS rather than a socket it holds, which is also why
 * this route needs neither the events stream's heartbeat nor its `idle` cap:
 * nothing here stays open across a sleep.
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
  const params = requestQuery(req.url);
  const namespace = params.get("namespace");
  const startIndexParam = params.get("startIndex");
  const startIndex = startIndexParam === null ? undefined : Number(startIndexParam);
  // An integer check rather than `isFinite`: a chunk index is a position, and
  // `startIndex=1.5` is a caller mistake worth naming rather than truncating.
  if (startIndex !== undefined && !Number.isInteger(startIndex)) {
    sendJson(res, 400, { error: "`startIndex` must be an integer" });
    return;
  }
  // `namespace ?? undefined` because it comes off `URLSearchParams.get`, which
  // reports absence as `null` — `omitUndefined` speaks the one absence this
  // codebase builds optional properties from.
  const options = omitUndefined({ namespace: namespace ?? undefined, startIndex });
  // The tail is read BEFORE the stream, so a chunk written between the two is
  // simply not in this read's budget — it belongs to the reader's next one. The
  // other order would let the budget name an index the read has to wait for.
  const tail = await engine.streamTail(runId, options);
  // `tail` is an absolute index and `startIndex` may be negative (counting back
  // from the end), so the BUDGET is what this read may emit, not a position.
  const budget = budgetFor(tail, startIndex);
  const complete = isTerminal(run);
  // A budget of zero opens NOTHING. This is the poll a caught-up page makes
  // every second — `useWorkflowProgress` advances `startIndex` by what it has
  // consumed, so a run that is mid-step and writing nothing answers 0 for as
  // long as the step lasts — and opening a stream to read no chunks from it is
  // both a world read for nothing and the exact shape that leaks: a reader
  // cancelled before its own background connect has finished used to strand a
  // `chunk:`/`close:` listener pair per request (see the `@workflow/core`
  // patch). The frames a caller receives are unchanged: an empty read was
  // already a bare `done`.
  if (budget === 0) {
    res.writeHead(200, SSE_HEADERS);
    res.write(sseFrame("done", { runId, complete }));
    res.end();
    return;
  }
  const stream = await engine.stream(runId, options);
  await pipeChunksAsSse(res, stream, { runId, budget, complete });
}

/**
 * How many chunks a read starting at `startIndex` may emit to reach `tail`.
 *
 * `tail` is `-1` for a stream nothing has written, which yields 0 — the response
 * is then a bare `done`, which is the honest answer for a run that has not said
 * anything yet.
 */
function budgetFor(tail: number, startIndex: number | undefined): number {
  const available = tail + 1;
  if (startIndex === undefined || startIndex === 0) return available;
  // Negative counts back from the end, so it asks for at most that many.
  if (startIndex < 0) return Math.min(available, -startIndex);
  return Math.max(0, available - startIndex);
}

/**
 * Write a run's chunks out as SSE, ending at `budget` or when the caller leaves.
 *
 * The budget is what terminates this — see `streamRunOutput`. Cancelling the
 * reader when the CLIENT goes away is the other half, and the one that is easy to
 * miss: without it a page navigating away mid-run leaves this pulling chunks out
 * of the world for a response nobody will receive, once per abandoned view.
 */
async function pipeChunksAsSse(
  res: http.ServerResponse,
  stream: ReadableStream<unknown>,
  end: { runId: string; budget: number; complete: boolean },
): Promise<void> {
  res.writeHead(200, SSE_HEADERS);
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
    // `emitted < budget` is the loop's bound, and it is checked BEFORE the read:
    // a read past the budget is the one that blocks forever, so it must never be
    // issued. `done` is still honoured — a stream that a workflow really did
    // close ends on its own — but nothing depends on it arriving.
    for (let emitted = 0; emitted < end.budget; emitted += 1) {
      const { done, value } = await reader.read();
      if (done || gone) break;
      res.write(sseFrame("chunk", value ?? null));
    }
    if (!gone) {
      res.write(sseFrame("done", { runId: end.runId, complete: end.complete }));
    }
  } finally {
    res.off("close", onClose);
    // Cancelled whether or not the budget was spent: a live run's stream is still
    // open behind this reader, and leaving it uncancelled holds the world's read
    // for a response that has already ended.
    void reader.cancel().catch(() => undefined);
    // Ending a response whose socket is already gone is a no-op that logs; the
    // `close` handler has done the only teardown that matters.
    if (!gone) res.end();
  }
}
