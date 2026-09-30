// Copyright 2026 the AAI authors. MIT license.
/**
 * Which CLIENT each session belongs to, durably — the index a device's one
 * conversation across many sessions is read back through.
 *
 * `?client=<id>` on `WS /websocket` used to be an in-memory `sessionId → id`
 * map (`sdk/session-client.ts`), good for exactly one thing: a tool reading
 * the id to hand a run. Nothing could answer the question a device with one
 * conversation asks every time it connects — "what have I said before" —
 * because a session's events were keyed by its own id, the next connect has a
 * new one, and the rows were deleted `SESSION_RESUME_GRACE_MS` after it
 * stopped. So a binding is now a ROW, written when a session that names a
 * client starts, and it changes two things:
 *
 * - **A bound session's EVENTS are never discarded.** The grace sweep still
 *   reclaims its SLOTS — a cart is not a conversation — but its raw
 *   transcript is kept for as long as the database is, because the client's
 *   future sessions and the app's summarizer (`stepClientTranscript`) both
 *   read it. That is a retention decision, and it is the app's database: an
 *   app that wants less deletes rows itself.
 * - **A client's sessions can be LISTED**, newest first, which is what
 *   `session-client-history.ts` pages through to seed a new session.
 *
 * ## Optional on the backend, and absent on the PLATFORM
 *
 * Memory and Postgres implement it. The platform backend does not: its tables
 * are the platform's (`aai_platform.session_*`, reached over HTTP), and adding
 * a client index there is a platform migration plus a route this package does
 * not own. So a deployed agent keeps today's behaviour — no client history, and
 * `stepClientTranscript` answers no sessions — and the platform's retention cron
 * (`aai-server/pg-cron-bodies.ts`, `SESSION_STATE_RETENTION`, 2 days) needs no
 * exemption, because nothing it sweeps is ever bound to a client. When the
 * platform grows the route, that cron is the thing that must learn to skip a
 * bound session's events, exactly as `discard` below does.
 *
 * A backend without these methods is not an error anywhere: every caller
 * treats their absence as "this backend keeps no client log".
 */

/**
 * One session's binding to a client, as {@link ClientSessionLog.clientSessions}
 * lists it.
 *
 * @public
 */
export type ClientSessionRecord = {
  sessionId: string;
  /** Epoch ms of the FIRST bind — a resume of the same session keeps it. */
  startedAt: number;
  /**
   * Epoch ms of the last event appended while bound (or the bind, before any).
   * A backend may let a LIVE session's trail by up to `CLIENT_TOUCH_INTERVAL_MS`
   * (`client-touch.ts`); a stopped session's is exact.
   */
  lastEventAt: number;
};

/**
 * The client half of a `SessionStateBackend` (`store.ts`).
 *
 * @public
 */
export type ClientSessionLog = {
  /**
   * Record that `sessionId` belongs to `clientId`. Idempotent: a second bind
   * of the same session keeps its `startedAt` and moves it to the client named
   * last (a device that re-flashed its id is the same speaker).
   */
  bindClient(sessionId: string, clientId: string): Promise<void>;
  /**
   * `clientId`'s sessions, most recently STARTED first, at most `limit`, and
   * only those whose `lastEventAt` is at or after `since` when it is given.
   */
  clientSessions(
    clientId: string,
    options: { since?: number | undefined; limit: number },
  ): Promise<readonly ClientSessionRecord[]>;
};
