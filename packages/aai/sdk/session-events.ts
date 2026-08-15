// Copyright 2026 the AAI authors. MIT license.
/**
 * The AUTHOR's side of the session event stream: what `agent({ events })`
 * declares and what a handler is handed.
 *
 * Its own module rather than part of `types.ts` for the reason `tool-context.ts`
 * is: this is a per-CALL surface an author writes against, `types.ts` holds the
 * agent-level declarations, and that file is at its cap. It is also the one
 * place the authoring surface touches the WIRE vocabulary — the keys of
 * {@link SessionEventHandlers} are the protocol's own event names — which is
 * exactly why those names were renamed before this existed. After this, renaming
 * one breaks every hook anyone has written.
 *
 * @module
 */

import type { Db } from "./db.ts";
import type { SessionEvent } from "./protocol-events.ts";

/**
 * What a session event handler is handed alongside the event.
 *
 * Deliberately much smaller than `ToolContext`, and the omissions are the
 * design: there is no `send`, no `slots`, no `generate` and no `messages`,
 * because a handler is OBSERVE-ONLY. Giving it a way to speak would make the
 * event stream a second control path into the turn — which is the thing that
 * keeps a log honest, since anything a reader can change it can no longer
 * describe.
 *
 * `db` is here because the first thing an audit hook wants is somewhere to write,
 * and the agent already has one.
 *
 * @public
 */
export type SessionEventContext = {
  /** The session this event belongs to — the id a stream read is keyed by. */
  sessionId: string;
  /**
   * Environment variables available to this agent (from `.env` under `aai dev`,
   * `aai secret` in production).
   */
  env: Readonly<Record<string, string>>;
  /**
   * The app database, when storage is enabled. Accessing it without throws with
   * the enablement guidance, exactly as `ctx.db` does in a tool.
   */
  db: Db;
};

/**
 * One handler: an event of the type it was declared under, plus the context.
 *
 * The return type is `unknown`, and that is deliberate rather than lazy.
 * `void | Promise<void>` reads better and does not compile for the most obvious
 * handler anyone writes: TypeScript's rule that a value-returning function is
 * assignable where `void` is expected applies to `void` ALONE, not to a union
 * containing it — so `(e) => seen.push(e)` (returning `number`) and
 * `(e) => void db.query(…)` are errors, on an observe-only API where the return
 * value is by definition ignored. `unknown` accepts every shape, and the emitter
 * checks for a promise at run time to decide whether to attach a rejection
 * handler.
 */
export type SessionEventHandler<E extends SessionEvent = SessionEvent> = (
  event: E,
  ctx: SessionEventContext,
) => unknown;

/**
 * The `events` map an agent declares — keyed by event type, plus `"*"`.
 *
 * The mapped half is what makes a handler's parameter TYPED: declaring
 * `"tool.called"` hands the handler an event that has `toolName` and `args`,
 * with no narrowing at the call site. `"*"` receives the whole union, which is
 * the right shape for the handlers that motivate it (a log line, a metrics
 * counter) and the reason it cannot be typed more narrowly.
 *
 * @public
 */
export type SessionEventHandlers = {
  [K in SessionEvent["type"]]?: SessionEventHandler<Extract<SessionEvent, { type: K }>>;
} & {
  /** Runs for every event, AFTER the typed handler for that event. */
  "*"?: SessionEventHandler;
};
