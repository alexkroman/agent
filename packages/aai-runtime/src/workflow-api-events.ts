// Copyright 2026 the AAI authors. MIT license.
/**
 * `GET /workflows/runs/:id/events` — a run's state as server-sent events.
 *
 * The push half of `useWorkflowRun`, which polls. Polling is the honest DEFAULT
 * — a run outlives the page, so re-reading the id is the simplest correct
 * implementation and stays the fallback — but it is expensive in exactly the
 * wrong place: on the platform every read BROKERS, so N open tabs at a 2s
 * interval is N/2 brokered requests per second, each of which can boot a
 * sandbox. One stream per tab replaces all of that with one connection.
 *
 * **SSE, not a WebSocket, and that is not a preference.** A page mounts with
 * `page()`, which deliberately constructs no `BrowserSession` — no socket, no audio
 * graph, no microphone. Adding a WebSocket here would put back the one thing
 * that split exists to keep out, for a stream that is one-directional anyway.
 *
 * **It watches by POLLING, and the read is SHARED.** This module used to argue
 * that the poll was cheap because the read was in-process — one query against
 * the world the run already lives in, with no platform in the path. On a
 * deployed agent that is false: `selectJournal` puts the platform arm first, so
 * every read is a `POST /:slug/workflow-journal`. And one sandbox serves one
 * slug fleet-wide, so the three tabs this file's opening paragraph counts are
 * three streams in ONE process, which is where the multiplication actually
 * happened. So the stream asks `workflow-run-reads.ts` for its observations:
 * every watcher of a run, streams and the other two loops alike, shares one
 * read per tick. A push notification from the world would be faster still and
 * would be WRONG on its own — a run can be executed by another replica
 * entirely, so the world's record is the only thing that knows.
 *
 * @internal
 */

import { errorMessage } from "@alexkroman1/aai/utils";
import { isTerminal, type WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import { SSE_HEADERS, sseFrame } from "./workflow-api-http.ts";
import { isRunWatchClosed, type RunReader, type RunWatch, watchRun } from "./workflow-run-reads.ts";

/**
 * How soon a live stream wants its next look at the run.
 *
 * A DEADLINE handed to the shared reader rather than a period of its own: a
 * faster watcher of the same run (a synchronous wait, at
 * `WORKFLOW_WAIT_POLL_MS`) pulls the tick in, and this stream is answered
 * early for free. What it never does is answer LATE.
 */
export const RUN_EVENT_POLL_MS = 1000;

/**
 * How often a comment frame goes out on an otherwise silent stream.
 *
 * Nothing in the chain notices a departed client until data flows, and an idle
 * proxy will reap a live stream between two slow state changes — a run that
 * sleeps for an hour produces no frames at all.
 */
export const RUN_EVENT_HEARTBEAT_MS = 15_000;

/**
 * How long one stream may stay open before handing the client back to its own
 * reconnect.
 *
 * Capped deliberately. A run can sleep for hours, and a connection held that
 * long is a connection nothing is maintaining — a proxy idle timeout, a laptop
 * lid, a scale-in. Ending it cleanly with an `idle` frame puts the client on a
 * path it already has, rather than pretending the link is alive.
 */
export const RUN_EVENT_STREAM_MAX_MS = 5 * 60_000;

/**
 * How many CONSECUTIVE failed reads the stream absorbs before handing the
 * client back.
 *
 * Retrying a failed read is right for a blip and wrong for anything permanent,
 * and the two are indistinguishable from here — so the retry has to be bounded
 * or a dead stream presents as a healthy quiet one. It produces no frames
 * either way, so a page watching a run whose world has gone sees nothing but
 * heartbeats until {@link RUN_EVENT_STREAM_MAX_MS}, while its own poll — which
 * would have surfaced the error — never takes over.
 *
 * Observed under `aai dev`: `GET /workflows/runs//events`, which is what the
 * route's suffix-stripping makes of `/workflows/runs/events`, reached the world
 * with an empty id. An id the world cannot PARSE is rejected rather than
 * answered "no such run", so every read threw and the response held for its
 * full five minutes without a single event. The empty id is guarded below as
 * well — that spelling should never reach a read — but the cap is what makes
 * the general case (a lost database, a serialization fault) end in seconds
 * instead of minutes.
 *
 * CONSECUTIVE, not a total: a stream watching a long run over a flaky link
 * would reach any fixed total eventually, and each of those reads recovered.
 */
export const RUN_EVENT_MAX_READ_FAILURES = 5;

/**
 * What the stream needs to read. A slice of the client, so a test needs no
 * world.
 *
 * DECLARED in `workflow-run-reads.ts`, which keys a run's shared reads by it,
 * and re-exported here because this is the module its readers already import
 * it from.
 */
export type { RunReader } from "./workflow-run-reads.ts";

/**
 * What the stream needs to WRITE — the four members of `http.ServerResponse` it
 * touches, and nothing else.
 *
 * Narrowed rather than taking the whole class, for the reason the whole file is
 * about frames: a spec asserts the SEQUENCE of chunks, and a `ServerResponse`
 * has ~40 members a recorder would have to fake or cast past. Naming the slice
 * makes the double an ordinary object literal rather than a laundered cast, and
 * it is also the honest statement of what this function does to a response.
 */
export type EventSink = {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end(): unknown;
  on(event: "close", listener: () => void): unknown;
};

/** A live stream, so a caller can end it (shutdown) and a test can stop it. */
export type RunEventStream = { close(): void };

/**
 * What one observation tells the stream's loop to do next.
 *
 * Named so the two things that can happen to a read — a snapshot, a failure —
 * are handled in a function each rather than as nested branches inside the
 * loop, which is what the cognitive-complexity ceiling is about.
 */
type StreamStep = "wait" | "stop";

/**
 * The one method this module logs through, so a caller can pass its own
 * `Logger` and a spec can pass an object literal.
 */
export type RunEventLogger = { warn?: (message: string, meta?: Record<string, unknown>) => void };

/**
 * Serve one run's state as SSE until it is terminal.
 *
 * Returns a handle whose `close()` ends the response CLEANLY — a terminating
 * chunk, not a destroyed socket. That distinction is the whole reason this
 * returns anything: a chunked body cut mid-frame is a protocol error to whatever
 * is reading, which on the platform is a proxy that surfaces it as a
 * transfer-encoding failure with nothing tying it back to a shutdown.
 */
export function streamRunEvents(
  res: EventSink,
  reader: RunReader,
  runId: string,
  options: { now?: () => number; logger?: RunEventLogger | undefined } = {},
): RunEventStream {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let closed = false;
  /**
   * This stream's place in the run's shared reads.
   *
   * Assigned synchronously by {@link pump} before it first suspends, so the
   * close handler below can never find it unset.
   */
  let watch: RunWatch | undefined;
  /** Consecutive failed reads — see {@link RUN_EVENT_MAX_READ_FAILURES}. */
  let failures = 0;
  // The last snapshot SENT, as JSON. Compared rather than deep-equalled because
  // the payload is what the client receives — if the bytes are identical there
  // is nothing to tell it, and any state change always changes them.
  let last: string | undefined;

  res.writeHead(200, SSE_HEADERS);

  const send = (event: string, data: unknown): void => {
    if (closed) return;
    res.write(sseFrame(event, data));
  };

  const finish = (): void => {
    if (closed) return;
    closed = true;
    // Leaving the shared reads BEFORE ending the response, so the last watcher
    // of a run stops its reader now rather than one tick from now — and so a
    // pending observation cannot come back to a stream that is over.
    watch?.close();
    res.end();
  };

  /**
   * One failed read: count it, report it, and decide whether the stream has
   * absorbed enough of them.
   */
  const onReadFailure = (err: unknown): StreamStep => {
    // A read that failed says nothing about the run, so the stream holds and
    // tries again. Ending here would send a page back to polling over a blip.
    // BOUNDED, though: past the cap the failure is not a blip, and a stream
    // that keeps this to itself is worse than no stream at all — see
    // RUN_EVENT_MAX_READ_FAILURES.
    failures += 1;
    options.logger?.warn?.("Workflow run event read failed", {
      runId,
      error: errorMessage(err),
      failures,
    });
    if (failures < RUN_EVENT_MAX_READ_FAILURES) return "wait";
    // `idle`, which the client already reads as "this stream gave up, go back
    // to polling" — the poll then reports the underlying failure the way it
    // reports every other one. A new frame kind would need every client to
    // learn it to reach the same place.
    send("idle", { runId });
    finish();
    return "stop";
  };

  /** One observation: frame whatever changed, and stop on a final answer. */
  const onObservation = (run: WorkflowRunSnapshot | undefined): StreamStep => {
    if (closed) return "stop";
    if (run === undefined) {
      // A 404 is a STABLE answer — a run the world does not know about now will
      // not appear later — so there is nothing to wait for. Named as its own
      // event so the client can stop rather than reconnect.
      send("missing", { runId });
      finish();
      return "stop";
    }
    const encoded = JSON.stringify(run);
    if (encoded !== last) {
      last = encoded;
      send("run", run);
    }
    if (!isTerminal(run)) return "wait";
    // Nothing will change again, so the stream is DONE rather than idle. Stated
    // explicitly so a client can tell "finished" from "connection dropped" and
    // not reconnect to a run with nothing left to say.
    send("done", { runId });
    finish();
    return "stop";
  };

  /**
   * One iteration: hold for the run's next shared observation, then act on it.
   *
   * Its own function so {@link pump} is a loop and nothing else — and because
   * the three ways an iteration can end (the duration cap, a read failure, a
   * final answer) each read better beside the state they touch than as a
   * branch nested inside a `for`.
   */
  const advance = async (joined: RunWatch, within: number): Promise<StreamStep> => {
    if (closed) return "stop";
    if (now() - startedAt >= RUN_EVENT_STREAM_MAX_MS) {
      send("idle", { runId });
      finish();
      return "stop";
    }
    // Settled into a VALUE rather than caught, so the two handlers below sit
    // outside the guarded region: a `res.write` that throws is a broken socket,
    // and counting it as a failed read would spend this stream's failure budget
    // on the wrong fault.
    const observed = await joined.next(within).then(
      (run) => ({ ok: true as const, run }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    if (closed) return "stop";
    if (!observed.ok) {
      // A teardown is not a failed read, and counting it as one would spend
      // this stream's failure budget on its own shutdown.
      if (isRunWatchClosed(observed.err)) return "stop";
      return onReadFailure(observed.err);
    }
    failures = 0;
    return onObservation(observed.run);
  };

  /**
   * Read, frame, wait, repeat — one iteration per shared observation.
   *
   * A loop rather than the self-arming `setTimeout` this used to be, because
   * the wait is no longer this stream's to schedule: `next(within)` IS the
   * wait, and it resolves when the run's shared reader next reads, which may be
   * sooner than this stream asked because somebody else asked sooner.
   */
  const pump = async (): Promise<void> => {
    const joined = watchRun(reader, runId);
    watch = joined;
    // ZERO for the first look, which is what the old `void tick()` did: a page
    // that has just connected must not watch a spinner for a second to be told
    // about a run that finished before it asked.
    let within = 0;
    while ((await advance(joined, within)) === "wait") {
      within = RUN_EVENT_POLL_MS;
    }
  };

  const heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, RUN_EVENT_HEARTBEAT_MS);
  heartbeat.unref?.();

  res.on("close", () => {
    clearInterval(heartbeat);
    closed = true;
    watch?.close();
  });

  if (runId) {
    void pump();
  } else {
    // The empty id every sibling route refuses before its read: `readRun` and
    // `streamRunOutput` spell it `runId ? … : undefined`, `cancelRun` and
    // `wakeRun` open with `if (!runId)`. It is not a run that is gone but an id
    // the world cannot parse, so asking would throw rather than answer — which
    // is how this route's five-minute silent hold was found. `missing` is the
    // right frame for it either way: an id that can never name a run is the
    // stable answer the client already stops on.
    send("missing", { runId });
    finish();
  }

  return {
    close: () => {
      clearInterval(heartbeat);
      finish();
    },
  };
}
