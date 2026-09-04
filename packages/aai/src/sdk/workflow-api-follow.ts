// Copyright 2026 the AAI authors. MIT license.
/**
 * The two READ-UNTIL-IT-ENDS iterators over an agent's run streams.
 *
 * `watch` and `streamOutput` resolve the raw `Response` — deliberately, because
 * a caller writing its own fallback has to see the status first (a page that
 * polls when the route 404s is the browser client's whole design). What that
 * leaves every OTHER caller with is a `Response`, an SSE parser, a frame
 * vocabulary, and two protocol rules that are not guessable: the state stream
 * hands the client back with an `idle` frame after its duration cap, and the
 * output stream is bounded by the TAIL at the moment the request arrived, so one
 * read is never the whole log of a run that is still going.
 *
 * So these are the shape a script, a cron job or a CLI wants —
 * `for await (const run of api.follow(runId))` — and the protocol's two
 * continuation rules are honoured inside them rather than being re-derived at
 * every call site. There is no polling fallback here and there should not be: a
 * caller who needs one is the caller `watch` exists for.
 *
 * Split from the client for the file-length reason `workflow-api-types.ts` was,
 * and taking the two methods it needs as a parameter rather than the whole
 * client — a spec then drives them with an object literal.
 *
 * @internal
 */

import { apiFailure } from "./_workflow-api-envelope.ts";
import { readEventStream } from "./event-stream.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { sleep } from "./sleep.ts";
import type { WorkflowRunSnapshot } from "./workflow-run.ts";
import { isTerminal } from "./workflow-run.ts";

/**
 * How long to wait before re-opening the OUTPUT stream of a run that is still
 * going.
 *
 * The route is bounded by the tail it saw (`host/workflow-api-stream.ts`), so a
 * quiet run answers with a bare `done` immediately and a tight loop would spin
 * on it. This is the same second the browser client's progress reader waits.
 */
const OUTPUT_REOPEN_MS = 1000;

/** The two stream openers these need — a slice of `WorkflowApi`. */
export type RunStreamOpener = {
  watch(runId: string, signal?: AbortSignal): Promise<Response>;
  streamOutput(
    runId: string,
    options?: { namespace?: string; startIndex?: number; signal?: AbortSignal },
  ): Promise<Response>;
};

/** The body of an SSE response, or the agent's own sentence for why there is none. */
async function streamBody(res: Response): Promise<ReadableStream<Uint8Array>> {
  if (!res.ok) throw await apiFailure(res);
  if (!res.body) throw new Error("The agent answered the event stream with no body");
  return res.body;
}

/**
 * How ONE connection to the state stream ended.
 *
 * `handed-back` is the route's own `idle` frame, which is the only ending that
 * wants another connection. A `dropped` is every other way a stream can stop
 * with the run unsettled, and it is the caller's to decide about — see
 * {@link followRun}.
 */
type WatchEnding = "settled" | "handed-back" | "dropped";

/** One connection's worth of snapshots, reporting how it ended. */
async function* watchOnce(
  api: RunStreamOpener,
  runId: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<WorkflowRunSnapshot, WatchEnding> {
  const body = await streamBody(await api.watch(runId, signal));
  for await (const frame of readEventStream(body, signal)) {
    if (frame.event === "run" && frame.data) {
      const run = frame.data as WorkflowRunSnapshot;
      yield run;
      // The route sends `done` right after the terminal snapshot, but the
      // snapshot itself is the authority on whether anything more can happen.
      if (isTerminal(run)) return "settled";
      continue;
    }
    // `missing` is a stable answer: the world's record is durable, so an id that
    // does not exist never will.
    if (frame.event === "done" || frame.event === "missing") return "settled";
    if (frame.event === "idle") return "handed-back";
  }
  return "dropped";
}

/**
 * Yield a run's snapshots until it settles.
 *
 * The last value yielded is the TERMINAL snapshot — that is what ends the
 * iteration, so a caller that only wants the answer can keep the last one it
 * saw. An `idle` frame is the route handing the client back after its own
 * duration cap (five minutes; a run may sleep for hours), so it re-opens rather
 * than ending: to a caller, one `for await` covers the whole run.
 *
 * A stream that ends any other way is a DROPPED CONNECTION and throws, because
 * the alternative is indistinguishable from a run that finished — the one
 * failure a caller would act on wrongly. An unknown run id ends the iteration
 * having yielded nothing, matching `get`'s undefined.
 */
export async function* followRun(
  api: RunStreamOpener,
  runId: string,
  signal?: AbortSignal,
): AsyncGenerator<WorkflowRunSnapshot> {
  while (!signal?.aborted) {
    // `yield*` forwards every snapshot AND evaluates to the generator's return
    // value, which is what keeps the ending in one place.
    const ending = yield* watchOnce(api, runId, signal);
    if (ending === "settled" || signal?.aborted) return;
    if (ending === "dropped") {
      throw new Error(`The event stream for run ${runId} ended before the run settled`);
    }
  }
}

/**
 * What one bounded output read consumed, and whether the RUN is finished.
 *
 * `next` is the first index this read did NOT deliver, which is what
 * `StreamOptions.startIndex` takes: that parameter is an INCLUSIVE floor, so a
 * count of consumed chunks is directly a cursor and there is no `± 1` anywhere on
 * this path. Reading it as exclusive is what made a default `followRunOutput`
 * skip chunk 0 — `packages/aai-runtime/src/workflow-stream-cursor.test.ts` is the
 * oracle over the whole chain.
 */
type OutputEnding = { next: number; complete: boolean };

/** One bounded read of the output stream, from an absolute INCLUSIVE index. */
async function* outputOnce(
  api: RunStreamOpener,
  runId: string,
  options: { namespace?: string | undefined; signal?: AbortSignal | undefined },
  from: number,
): AsyncGenerator<unknown, OutputEnding> {
  const res = await api.streamOutput(
    runId,
    omitUndefined({ namespace: options.namespace, startIndex: from, signal: options.signal }),
  );
  const body = await streamBody(res);
  let next = from;
  for await (const frame of readEventStream(body, options.signal)) {
    if (frame.event === "chunk") {
      // Counted rather than read off the frame: the index is what the next read
      // resumes from, so it has to be what THIS read actually consumed.
      next += 1;
      yield frame.data;
      continue;
    }
    if (frame.event === "done") {
      const complete = (frame.data as { complete?: boolean } | undefined)?.complete === true;
      return { next, complete };
    }
    // An id no run answers to. Both SSE routes frame it — an endpoint that
    // streams cannot report a run vanishing mid-stream with a status code — and
    // it is STABLE, the world's record being durable, so there is nothing to
    // come back for. A 404 on either route means something else entirely now:
    // an agent serving no workflow API, which `streamBody` throws on above.
    if (frame.event === "missing") return { next, complete: true };
  }
  // No `done` frame: the connection dropped. Progress is a durable log, so the
  // next read simply asks again from where this one got to.
  return { next, complete: false };
}

/**
 * Yield everything a run WRITES, in order, until it settles.
 *
 * One read of `GET /runs/:id/stream` is bounded by the tail it saw, and its
 * `done` frame says whether the RUN was terminal — so this re-opens from the
 * next unread index until it was, which is what makes `for await` cover the
 * whole log of a live run. Chunks are retained with the run, so this is a replay
 * as much as a tail: by default it starts at the beginning.
 *
 * `fromIndex` is ABSOLUTE and INCLUSIVE — `fromIndex: 0`, the default, yields the
 * run's first chunk — and the raw route's "last N chunks" (a negative
 * `startIndex`) is deliberately not offered here: it names no position a re-open
 * can resume from — the tail it counts back from moves with every chunk the run
 * writes — so a reader resuming from it would ask for a different set entirely.
 * Use {@link WorkflowApi.streamOutput} for one bounded read of the tail.
 */
export async function* followRunOutput(
  api: RunStreamOpener,
  runId: string,
  options: {
    namespace?: string | undefined;
    fromIndex?: number | undefined;
    signal?: AbortSignal | undefined;
  } = {},
): AsyncGenerator<unknown> {
  let index = Math.max(0, options.fromIndex ?? 0);
  while (!options.signal?.aborted) {
    const ending = yield* outputOnce(api, runId, options, index);
    index = ending.next;
    if (ending.complete || options.signal?.aborted) return;
    await sleep(OUTPUT_REOPEN_MS, omitUndefined({ signal: options.signal }));
  }
}
