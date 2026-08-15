// Copyright 2026 the AAI authors. MIT license.
/**
 * The session event stream's budgets.
 *
 * Split out of `constants.ts` at the 500-line cap, the same way
 * `client-audio-constants.ts` was — but NOT re-exported from there, which that
 * one is. The difference is the audience: those budgets are read by the browser
 * client through `@alexkroman1/aai/internal`, and these three are read by
 * `host/session-event-stream.ts` and nothing else, so a re-export would widen a
 * surface for no caller.
 *
 * @module
 */

/**
 * Cap on how many events one session RETAINS.
 *
 * Sized off the shape of a real call rather than picked: a tool-heavy turn emits
 * on the order of ten control events, so 10,000 covers a session of ~1,000 turns
 * — far past any voice call — while still bounding a runaway emitter in the
 * tenant's own schema, which `appDatabaseUsage` shows an author as their own
 * usage.
 *
 * Exceeding it costs RETENTION, not correctness: the live session keeps emitting
 * to its client, and what stops is the durable append (reported once). The same
 * posture as {@link MAX_SESSION_STATE_BYTES}.
 *
 * @internal
 */
export const MAX_SESSION_EVENTS = 10_000;
/**
 * How many pending events force a flush before a turn boundary does.
 *
 * The batch exists because a per-event round trip is unaffordable inside a turn
 * with a ~1.0s time-to-first-token budget; this bounds how much a crash can cost
 * when a turn runs long (a 10-step tool chain emits well past this).
 *
 * @internal
 */
export const SESSION_EVENT_FLUSH_THRESHOLD = 32;
/**
 * Events per read of the session event stream — the page size a reader gets, and
 * what bounds one response's memory.
 *
 * @internal
 */
export const SESSION_EVENT_READ_LIMIT = 500;
