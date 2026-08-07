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
 */

import { createParser } from "eventsource-parser";
import { ApiError } from "./api-error.ts";

export type SseFrame = { event: string; data: string };

/**
 * Read the stream to its end, delivering each complete named frame.
 * Parsing is `eventsource-parser` (the incremental parser the AI SDK
 * ecosystem runs on) rather than hand-rolled line splitting, so spec
 * corners — comments, CR line endings, multi-line data, fields split
 * across chunk boundaries by a re-chunking proxy — are its problem, not
 * ours. Unnamed or empty events (pings) are dropped; callers dispatch on
 * the event name.
 */
async function drainEventStream(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void,
): Promise<void> {
  const parser = createParser({
    onEvent: (message) => {
      if (message.event && message.data) onFrame({ event: message.event, data: message.data });
    },
  });
  const reader = body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    parser.feed(decoder.decode(value, { stream: true }));
  }
}

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
    onFrame: (frame: SseFrame) => void;
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
      await drainEventStream(res.body, handlers.onFrame);
    } catch {
      // Aborted (caller unsubscribed) or failed — the finally decides.
    } finally {
      if (!controller.signal.aborted) handlers.onDown(reason);
    }
  })();
  return () => controller.abort();
}
