// Copyright 2026 the AAI authors. MIT license.
/**
 * `GET /:slug/workflow-stream` — a LIVE read of one run's stream.
 *
 * The seventh Streamer member, and the one that could not share the RPC route the
 * other six use. `readFromStream(name, startIndex?)` returns a
 * `ReadableStream<Uint8Array>` that stays open and yields chunks AS THEY ARRIVE,
 * closing only when the stream does. That is a streaming response, not one request
 * and one reply, so it gets its own route and its own module.
 *
 * ## The tenant boundary is the NAME, not a run check
 *
 * This is the one method with no run id in its signature, so there is nothing to
 * check ownership of. What makes it safe is the same qualification the other six
 * use (`workflow-stream-namespace.ts`): the name is built from the AUTHENTICATED
 * slug plus whatever the caller asked for, so a caller can only ever name
 * `<their-slug>/<name>`. Reaching another agent's stream would require holding
 * their bearer, which is the same thing as being them.
 *
 * That is stronger than a check rather than weaker: there is no window, no lookup
 * that could return the wrong row, and nothing to forget. It is also the only
 * option — their query is `where(eq(streams.streamId, name))` with no run filter,
 * so a run check here would gate a read that still could not be pointed at the
 * right stream.
 *
 * ## Chunk boundaries are NOT preserved, and that is correct
 *
 * Their `ReadableStream` enqueues discrete `Uint8Array`s; an HTTP body is a byte
 * stream and coalesces them. That matches what a stream IS in the DevKit — bytes
 * written by `writeToStream(name, runId, chunk: string | Uint8Array)`, read by a
 * consumer that decodes incrementally — so nothing downstream depends on where one
 * write ended. A framed protocol would need length prefixes; this is not one, and
 * inventing them would mean the guest had to strip them again.
 *
 * ## Why the response is bounded
 *
 * A stream closes when the run writes its EOF, which may be never: a run that
 * fails mid-stream leaves it open, and the platform would hold a connection and a
 * pooled reader for it indefinitely. {@link STREAM_READ_MAX_MS} ends the response
 * instead, and the guest reconnects with `startIndex` — which is what that
 * parameter is for, and why their own doc explains resolving a negative one
 * against `getStreamInfo`.
 */

import { errorMessage } from "@alexkroman1/aai";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "./context.ts";
import { assertGuestBearer } from "./guest-bearer.ts";
import { createLogger } from "./logger.ts";
import type { PlatformWorldStorage } from "./workflow-storage-world.ts";
import { qualifyStreamName } from "./workflow-stream-namespace.ts";

const log = createLogger("workflow.stream");

/** This route's own path under `/:slug`. */
export const WORKFLOW_STREAM_ROUTE = "/workflow-stream";

/**
 * How long one live read may hold the response open.
 *
 * Ten minutes, and the number matters less than the fact that there IS one: a
 * stream whose run died mid-write never sees an EOF, so without a bound the
 * platform holds a connection and a pooled reader for the life of the process.
 * Ending the response is not data loss — the guest reconnects with `startIndex`,
 * which is exactly what that parameter exists for.
 */
export const STREAM_READ_MAX_MS = 600_000;

/**
 * `startIndex` off the query, or undefined.
 *
 * NEGATIVE values are legal and load-bearing: their doc says a negative starts
 * that many chunks before the current end, which is how a reconnecting reader asks
 * for "the last few". So this validates finiteness and integrality, not sign.
 */
function parseStartIndex(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new HTTPException(400, { message: "startIndex must be an integer" });
  }
  return value;
}

/** `readFromStream` off the world's streamer, or a 501 when their shape moved. */
function readerOf(
  storage: PlatformWorldStorage,
): (name: string, startIndex?: number) => Promise<ReadableStream<Uint8Array>> {
  const fn = storage.streamer.readFromStream;
  if (typeof fn !== "function") {
    throw new HTTPException(501, { message: "live stream reads are unavailable" });
  }
  return fn as (name: string, startIndex?: number) => Promise<ReadableStream<Uint8Array>>;
}

export type StreamHandlerOptions = {
  /** The platform's world. Absent means this deployment serves no run storage. */
  storage?: PlatformWorldStorage | undefined;
};

/**
 * Build the live-read handler.
 *
 * @internal
 */
export function createWorkflowStreamHandler(
  opts: StreamHandlerOptions,
): (c: AppContext) => Promise<Response> {
  return async (c) => {
    const slug = c.var.slug;
    await assertGuestBearer(c, slug);
    const storage = opts.storage;
    if (!storage) {
      throw new HTTPException(501, { message: "platform run storage not configured" });
    }

    const name = c.req.query("name");
    if (name === undefined || name === "") {
      throw new HTTPException(400, { message: "name is required" });
    }
    const startIndex = parseStartIndex(c.req.query("startIndex"));

    // The qualification IS the tenant boundary here — see the module doc. The slug
    // comes from the bearer that was just checked, never from the request.
    const qualified = qualifyStreamName(slug, name);
    let source: ReadableStream<Uint8Array>;
    try {
      source = await readerOf(storage)(qualified, startIndex);
    } catch (err: unknown) {
      if (err instanceof HTTPException) throw err;
      log.warn("live stream read failed", { slug, error: errorMessage(err) });
      throw new HTTPException(503, { message: "could not open the stream", cause: err });
    }

    return new Response(bounded(source, slug), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        // A live read must not be buffered by anything between here and the guest,
        // or chunks arrive in batches and the stream stops being live.
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  };
}

/**
 * The source stream, ended at {@link STREAM_READ_MAX_MS}.
 *
 * The timer is cleared on every natural end — close, error, or the client going
 * away — because a `setTimeout` that outlives its stream is a reference the process
 * holds for ten minutes per read, which at any volume is the leak this bound exists
 * to prevent.
 */
function bounded(source: ReadableStream<Uint8Array>, slug: string): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        // CLOSE, not error: the reader has everything up to here, and its next
        // request resumes with `startIndex`. An error would read as a fault.
        log.debug("live stream read reached its bound", { slug });
        controller.close();
        void reader.cancel().catch(() => undefined);
      }, STREAM_READ_MAX_MS);
      // `unref` so a held-open read cannot keep the process alive through a
      // shutdown; the platform's drain does not wait on tenant streams.
      timer.unref?.();
    },
    async pull(controller) {
      try {
        const { done: finished, value } = await reader.read();
        if (finished) {
          done();
          controller.close();
          return;
        }
        if (value !== undefined) controller.enqueue(value);
      } catch (err: unknown) {
        done();
        controller.error(err);
      }
    },
    cancel(reason) {
      // The client went away. Cancelling upstream is what releases their
      // subscription and its `LISTEN` handler.
      done();
      return reader.cancel(reason);
    },
  });
}
