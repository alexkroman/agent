// Copyright 2026 the AAI authors. MIT license.
/**
 * When a bound session's `last_event_at` is worth a round trip.
 *
 * The Postgres backend (`backends/postgres.ts`) moves a bound session's
 * `last_event_at` after an append. That used to happen on EVERY flush — a second
 * sequential query on the session's write path — for a column whose only reader
 * is `clientSessions`' `since` pre-filter. That `since` is a COARSE cutoff (an
 * app's `historySince`, a transcript's window), and the events inside a session
 * are re-filtered on their own `meta.at` (`session-client-history.ts`), so the
 * column only has to say "this session was active around then".
 *
 * So it is throttled: at most one touch per session per
 * {@link CLIENT_TOUCH_INTERVAL_MS}, the FIRST append after a bind always
 * touching, plus one at session stop (`settle`) when an append since the last
 * touch was skipped. The cost is stated as the contract: a LIVE session's
 * `last_event_at` may trail its newest event by up to the interval; a stopped
 * session's is exact. A process that dies mid-session leaves it at most one
 * interval stale.
 *
 * @module
 */

/**
 * At most one `last_event_at` touch per bound session per this long — see the
 * module doc for why a staleness this size is invisible to every reader.
 *
 * @internal
 */
export const CLIENT_TOUCH_INTERVAL_MS = 30_000;

/**
 * The per-session throttle over the touches. Tracks only sessions this process
 * BOUND, so an unbound session never asks for one.
 *
 * @internal
 */
export type ClientTouchThrottle = {
  /** The session was bound here. A re-bind keeps its throttle. */
  bind(sessionId: string): void;
  /**
   * An append landed: whether to touch NOW. A skipped touch is remembered, and
   * the answer is recorded before the caller's query so a concurrent flush
   * inside the window does not issue a second one while the first is in flight.
   */
  onAppend(sessionId: string): boolean;
  /** The session stopped: whether a skipped touch is still owed (and now paid). */
  onSettle(sessionId: string): boolean;
  /** The session was discarded: forget it until a resume re-binds. */
  forget(sessionId: string): void;
};

/**
 * Build a {@link ClientTouchThrottle}. `now` is injectable for the unit spec.
 *
 * @internal
 */
export function createClientTouchThrottle(
  now: () => number = Date.now,
  intervalMs = CLIENT_TOUCH_INTERVAL_MS,
): ClientTouchThrottle {
  const sessions = new Map<string, { touchedAt: number; owed: boolean }>();
  return {
    bind(sessionId) {
      if (!sessions.has(sessionId))
        sessions.set(sessionId, { touchedAt: Number.NEGATIVE_INFINITY, owed: false });
    },
    onAppend(sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) return false;
      const at = now();
      if (at - entry.touchedAt < intervalMs) {
        entry.owed = true;
        return false;
      }
      entry.touchedAt = at;
      entry.owed = false;
      return true;
    },
    onSettle(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry?.owed !== true) return false;
      entry.touchedAt = now();
      entry.owed = false;
      return true;
    },
    forget(sessionId) {
      sessions.delete(sessionId);
    },
  };
}
