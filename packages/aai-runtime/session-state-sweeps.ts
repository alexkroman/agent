// Copyright 2026 the AAI authors. MIT license.
/**
 * Grace-window reclamation of a session's slot state.
 *
 * A disconnect is not the end of a session's context: the client reconnects
 * with `?sessionId=<id>` (see ws-handler) and the resumed session must find
 * the state it left behind — deleting it the instant the old session's
 * stop() settled made every resume start with fresh slots (the agent
 * "forgot" everything a resume exists to keep). State is reclaimed only after
 * {@link SESSION_RESUME_GRACE_MS} passes with no resume.
 *
 * **This is one of TWO reclamation paths, and it can only be one of two.** It
 * runs in the process that holds the session, so it covers a session that ended
 * cleanly — and by construction it cannot cover the case a durable store makes
 * possible: rows belonging to a guest that is GONE, which is the ordinary end of
 * an agent sandbox (it self-exits on idle). Those are swept by the PLATFORM, as a
 * `platformCronJobs()` entry in `aai-server/pg-cron.ts`. The same split
 * `workflow-wake.ts` records: "a durable run outlives the call that started it,
 * and on the platform the SANDBOX does not."
 */

import { SESSION_RESUME_GRACE_MS } from "@alexkroman1/aai/host-internal";
import type { SessionStateStore } from "./session-state-store.ts";

export type StateSweeps = {
  /** Reclaim `sessionId`'s state after the grace window (replaces any pending sweep). */
  schedule(sessionId: string): void;
  /** A resume under `sessionId` keeps its state — cancel the pending sweep. */
  cancel(sessionId: string): void;
  /** Drop every pending sweep (runtime shutdown — the store is being cleared anyway). */
  clear(): void;
};

/** Create the sweep scheduler over the runtime's session-state store. */
export function createStateSweeps(store: SessionStateStore): StateSweeps {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function cancel(sessionId: string): void {
    const timer = timers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(sessionId);
  }

  function schedule(sessionId: string): void {
    cancel(sessionId);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      // Reclaims the cache entry AND the stored rows: a durable value that
      // outlived its grace window is not waiting for anything, and leaving it
      // would make the platform's TTL sweep the only thing that ever removed a
      // row for a session that ended normally.
      store.discard(sessionId);
    }, SESSION_RESUME_GRACE_MS);
    // A pending sweep must never hold the event loop open (e.g. a finished
    // CLI process) — clear() reclaims everything on shutdown anyway.
    timer.unref?.();
    timers.set(sessionId, timer);
  }

  function clear(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { schedule, cancel, clear };
}
