// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio's SSE subscription plumbing — a fetch-streamed reader rather
 * than `EventSource`, because the studio authenticates with a bearer header
 * and `EventSource` cannot send one.
 *
 * Split from api.ts, which is otherwise a flat list of one-shot REST calls:
 * this is the one stateful thing in that surface (a long-lived body, a
 * cancelation handle, and a reason taxonomy the caller's backoff depends on).
 * The routes themselves stay on `api` — see `watchProject`/`watchProjects`.
 *
 * **The FRAMING is the SDK's** (`readEventStream` from
 * `@alexkroman1/aai/workflow-api`), and what is left here is the studio's own
 * stream POLICY. This module used to hold a `drainEventStream` of its own —
 * the third copy of that parser in the repo, and the one the SDK module's doc
 * names as such; aai-ui's `_sse.ts` was deleted rather than kept when the
 * reader moved into the SDK, and this is the same deletion. A stream parser is
 * duplication that goes wrong quietly: the spec corners it gets right (`\r\n`
 * and lone-`\r` delimiters, multi-line `data:`, a field split across two
 * chunk boundaries by a re-chunking proxy) are invisible until a proxy in
 * front of one deployment starts exercising them.
 *
 * Two consequences of adopting it, both wanted. The SDK's reader hands back
 * `data` already JSON-parsed, so this package no longer casts a `JSON.parse`
 * into shape at the three dispatch sites — a frame is narrowed by a real guard
 * instead (`isProjectData` and friends in `api-types.ts`). And a frame with no
 * `event:` name is dropped by the reader rather than here; the heartbeats this
 * server sends are NAMED (`event: ping`) and reach `onFrame` with an
 * `undefined` payload, which every dispatch ignores because it keys off the
 * name it wants.
 */

import { type EventStreamFrame, readEventStream } from "@alexkroman1/aai/workflow-api";
import { ApiError } from "./api-error.ts";

/**
 * Why an event stream went down. The distinction is load-bearing: a
 * `transport` failure (server restart, preempted container, flaky network)
 * is fixed by reconnecting, while `auth` means THIS bearer is dead and
 * reconnecting with it can only loop. Retrying an expired session token
 * every few seconds is exactly how one backgrounded tab produced 4,300
 * `401`s in three hours, each one re-verified against Supabase.
 */
export type StreamDownReason = "auth" | "transport";

/**
 * Fetch-streamed SSE subscription against a studio events route. Returns an
 * abort function. `onOpen` fires once the server accepted the stream (the
 * caller's signal to reset its backoff); `onDown` fires when the stream ends
 * or fails, with the reason — but never on the caller's own abort.
 */
export function watchEventStream(
  key: string,
  path: string,
  handlers: {
    onFrame: (frame: EventStreamFrame) => void;
    onOpen?: () => void;
    onDown: (reason: StreamDownReason) => void;
  },
): () => void {
  const controller = new AbortController();
  void (async () => {
    let reason: StreamDownReason = "transport";
    try {
      const res = await fetch(path, {
        headers: { Authorization: `Bearer ${key}`, Accept: "text/event-stream" },
        signal: controller.signal,
      });
      // A session token expires after ~1h and supabase-js pauses its refresh
      // ticker on hidden tabs, so a long-open studio tab reconnects with a
      // token the server rejects. That needs a new token, not another try.
      if (res.status === 401 || res.status === 403) reason = "auth";
      if (!(res.ok && res.body)) throw new ApiError(res.status, "Event stream unavailable");
      handlers.onOpen?.();
      // The signal is passed as well as being the `fetch`'s: aborting the
      // request already ends the read, but it lets the reader stop between
      // frames rather than inside a `read()` that has to reject first.
      for await (const frame of readEventStream(res.body, controller.signal)) {
        handlers.onFrame(frame);
      }
    } catch {
      // Aborted (caller unsubscribed) or failed — the finally decides.
    } finally {
      if (!controller.signal.aborted) handlers.onDown(reason);
    }
  })();
  return () => controller.abort();
}
