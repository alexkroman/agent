// Copyright 2026 the AAI authors. MIT license.
/**
 * Grace-window reclamation of per-session tool state (`ctx.state`).
 *
 * A disconnect is not the end of a session's context: the client reconnects
 * with `?sessionId=<id>` (see ws-handler) and the resumed session must find
 * the tool state it left behind — deleting it the instant the old session's
 * stop() settled made every resume start with fresh `ctx.state` (the agent
 * "forgot" everything a resume exists to keep). State is reclaimed only after
 * {@link SESSION_RESUME_GRACE_MS} passes with no resume.
 */

import { SESSION_RESUME_GRACE_MS } from "../sdk/constants.ts";

export type StateSweeps = {
  /** Reclaim `sessionId`'s state after the grace window (replaces any pending sweep). */
  schedule(sessionId: string): void;
  /** A resume under `sessionId` keeps its state — cancel the pending sweep. */
  cancel(sessionId: string): void;
  /** Drop every pending sweep (runtime shutdown — the maps are being cleared anyway). */
  clear(): void;
};

/** Create the sweep scheduler over the runtime's per-session state map. */
export function createStateSweeps(stateMap: Map<string, Record<string, unknown>>): StateSweeps {
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
      stateMap.delete(sessionId);
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
