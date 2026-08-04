// Copyright 2026 the AAI authors. MIT license.
// Holding an SSE subscription open across drops: the reconnect policy for the
// studio's live project/chat pushes (api.watchProject / api.watchProjects).
//
// Two failure modes, and conflating them is a bug with real cost. A TRANSPORT
// drop (server restart, a preempted Modal container, flaky network) is fixed by
// reconnecting. An AUTH rejection is not: the bearer itself is dead, so every
// retry is rejected identically. Retrying the latter at the floor interval is
// how one backgrounded studio tab issued 4,346 `401`s over three hours — two
// requests every four seconds, each one costing the server a Supabase token
// verification — because supabase-js pauses its refresh ticker on hidden tabs
// and nothing here asked for a new token.

import { useEffect } from "react";
import type { StreamDownReason } from "./api.ts";

/** First backoff before resubscribing a dropped event stream, then doubling. */
const EVENTS_RETRY_MS = 3000;
/**
 * Ceiling on that backoff. A stream that cannot connect must not poll the
 * platform forever at the floor interval.
 */
const EVENTS_RETRY_MAX_MS = 60_000;

export type StreamHandlers = {
  onOpen: () => void;
  onDown: (reason: StreamDownReason) => void;
};

/**
 * Hold one server event-stream subscription while mounted, resubscribing with
 * an exponential backoff (reset whenever a stream opens, so a long-lived
 * subscription that drops once reconnects promptly) whenever it drops.
 * `subscribe` must be referentially stable (useCallback) — it opens the stream
 * and gets the retry triggers; subscribing can be skipped by returning a no-op
 * unsubscribe.
 *
 * `onAuthFailure` handles the one failure retrying cannot fix: the bearer is
 * refreshed before the next attempt, and a SUCCESSFUL refresh re-runs this
 * effect through the changed bearer — which cancels the retry scheduled below,
 * so the recovered stream reconnects immediately rather than waiting it out.
 */
export function useEventStream(
  subscribe: (handlers: StreamHandlers) => () => void,
  onAuthFailure: () => Promise<void>,
) {
  useEffect(() => {
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const start = () => {
      unsubscribe = subscribe({
        onOpen: () => {
          failures = 0;
        },
        onDown: (reason) => {
          if (stopped) return;
          if (reason === "auth") void onAuthFailure();
          failures += 1;
          const delay = Math.min(EVENTS_RETRY_MS * 2 ** (failures - 1), EVENTS_RETRY_MAX_MS);
          retry = setTimeout(start, delay);
        },
      });
    };
    start();
    return () => {
      stopped = true;
      if (retry !== undefined) clearTimeout(retry);
      unsubscribe?.();
    };
  }, [subscribe, onAuthFailure]);
}
