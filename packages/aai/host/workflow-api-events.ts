// Copyright 2026 the AAI authors. MIT license.
/**
 * `GET /workflows/runs/:id/events` — a run's state as server-sent events.
 *
 * The push half of {@link useWorkflowRun}, which polls. Polling is the honest
 * DEFAULT — a run outlives the page, so re-reading the id is the simplest correct
 * implementation and stays the fallback — but it is expensive in exactly the wrong
 * place: on the platform every read BROKERS, so N open tabs at a 2s interval is
 * N/2 brokered requests per second, each of which can boot a sandbox. One stream
 * per tab replaces all of that with one connection.
 *
 * **SSE, not a WebSocket, and that is not a preference.** A page mounts with
 * `page()`, which deliberately constructs no `SessionCore` — no socket, no audio
 * graph, no microphone. Adding a WebSocket here would put back the one thing that
 * split exists to keep out, for a stream that is one-directional anyway.
 *
 * **It watches by polling the STORE, in-process.** That sounds like it defeats the
 * purpose and does not: the expensive part was never the read, it was the HTTP hop
 * and the brokering in front of it. Here the read is one indexed query against the
 * database the run already lives in, next to it, with no platform in the path. An
 * engine-side notification would be faster still and would be WRONG on its own —
 * a run can be executed by another replica entirely, so the row is the only thing
 * that knows, which is the same reason `watchAgents` handlers re-read rather than
 * trusting a payload.
 *
 * @internal
 */

import type http from "node:http";
import { isTerminal, type WorkflowRunSnapshot } from "../sdk/workflow.ts";
import {
  RUN_EVENT_HEARTBEAT_MS,
  RUN_EVENT_POLL_MS,
  RUN_EVENT_STREAM_MAX_MS,
} from "./workflow-engine-limits.ts";

/** What the stream needs to read. A slice of the engine, so a test needs no engine. */
export type RunReader = { get(runId: string): Promise<WorkflowRunSnapshot | undefined> };

/** A live stream, so a caller can end it (shutdown) and a test can stop it. */
export type RunEventStream = { close(): void };

/**
 * Serve one run's state as SSE until it is terminal.
 *
 * Returns a handle whose `close()` ends the response CLEANLY — a terminating
 * chunk, not a destroyed socket. That distinction is the whole reason this returns
 * anything: a chunked body cut mid-frame is a protocol error to whatever is
 * reading, which on the platform is a proxy that surfaces it as a transfer-encoding
 * failure with nothing tying it back to a shutdown (see `live-streams.ts` in
 * aai-server, which exists for exactly this and which the platform's forwarder
 * registers this stream with).
 */
export function streamRunEvents(
  res: http.ServerResponse,
  reader: RunReader,
  runId: string,
  options: { now?: () => number } = {},
): RunEventStream {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The last snapshot SENT, as JSON. Compared rather than deep-equalled because
  // the payload is what the client receives — if the bytes are identical there is
  // nothing to tell it, and a status/step-count change always changes them.
  let last: string | undefined;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Proxies that buffer would defeat the point; this is the conventional opt-out
    // and is inert where it is not understood.
    "X-Accel-Buffering": "no",
  });

  const send = (event: string, data: unknown): void => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    res.end();
  };

  const tick = async (): Promise<void> => {
    if (closed) return;
    let run: WorkflowRunSnapshot | undefined;
    try {
      run = await reader.get(runId);
    } catch {
      // A read that failed says nothing about the run, so the stream holds and
      // tries again. Ending here would send a page back to polling over a blip.
      arm();
      return;
    }
    if (closed) return;
    if (run === undefined) {
      // A 404 is a STABLE answer — the journal is durable — so there is nothing to
      // wait for. Named as its own event so the client can stop rather than
      // reconnect, which is what it does for an ordinary end.
      send("missing", { runId });
      finish();
      return;
    }
    const encoded = JSON.stringify(run);
    if (encoded !== last) {
      last = encoded;
      send("run", run);
    }
    if (isTerminal(run)) {
      // Nothing will change again, so the stream is DONE rather than idle. Stated
      // explicitly so a client can tell "finished" from "connection dropped" and
      // not reconnect to a run that has nothing left to say.
      send("done", { runId });
      finish();
      return;
    }
    arm();
  };

  function arm(): void {
    if (closed) return;
    // A stream is capped in duration, deliberately. A run can sleep for hours and a
    // connection held that long is a connection nothing is maintaining — a proxy
    // idle timeout, a laptop lid, a scale-in. Ending it cleanly hands the client
    // back to its own reconnect, which is a normal path it already has, rather
    // than pretending the link is alive.
    if (now() - startedAt >= RUN_EVENT_STREAM_MAX_MS) {
      send("idle", { runId });
      finish();
      return;
    }
    timer = setTimeout(() => void tick(), RUN_EVENT_POLL_MS);
    // Unref'd: a page watching a run must never be the reason the guest stays up.
    // The guest's idle controller reads `busy()` for that, which is about the RUN.
    timer.unref?.();
  }

  // A comment frame on a fixed cadence, because nothing in the chain notices a
  // departed client until data flows — the same property `SSE_HEARTBEAT_MS` exists
  // for on the studio's streams. It also keeps an idle proxy from reaping a live
  // stream between two slow state changes.
  const heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, RUN_EVENT_HEARTBEAT_MS);
  heartbeat.unref?.();

  res.on("close", () => {
    clearInterval(heartbeat);
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
  });

  void tick();

  return {
    close: () => {
      clearInterval(heartbeat);
      finish();
    },
  };
}
