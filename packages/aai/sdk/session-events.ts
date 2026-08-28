// Copyright 2026 the AAI authors. MIT license.
/**
 * The AUTHOR's side of the session event stream: what `agent({ events })`
 * declares and what a handler is handed.
 *
 * A handler OBSERVES the session and MAINTAINS the session's own state; it does
 * not drive the turn. {@link SessionEventContext} is where that line is drawn
 * and argued.
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

import type { SessionEvent } from "./protocol-events.ts";
import type { SlotStore } from "./session-state.ts";

/**
 * What a session event handler is handed alongside the event.
 *
 * Deliberately much smaller than `ToolContext`, and the omissions are still the
 * design: there is no `send`, no `generate`, no `delegate` and no `messages`. A
 * handler MAY NOT SPEAK. Giving it a way to would make the event stream a second
 * control path into the turn — which is the thing that keeps a log honest, since
 * anything a reader can change it can no longer describe.
 *
 * **`slots` is here, and it does not cross that line.** The rule the omissions
 * enforce is that a handler cannot change the TURN — what the agent says, which
 * tool runs, whether a reply is cancelled. Maintaining the session's own state is
 * a different act, and one the alternative made worse: an author who wanted a
 * fact recorded per turn had no choice but to declare a TOOL for it and instruct
 * the model to call it, which is a model-cooperation problem standing in for a
 * bookkeeping one — see `infocom-adventure`, whose `game_state_history` tool
 * existed to hand the framework back a transcript it already had. A hook writes
 * the fact directly, on every turn, whether or not the model cooperates.
 *
 * What a write here still cannot do is be READ by the turn it happened in: the
 * model sees a slot's value through a tool result, and this runs beside that
 * path rather than in front of it.
 *
 * `db` used to be here, because the first thing an audit hook wants is somewhere
 * to write and the agent already had one. It is gone with `ctx.db`: the platform
 * provides no database, so a hook that wants to persist brings its own client and
 * credential — the same change tool code saw, and for the same reason.
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
  // `Partial` for the same reason as `ToolContext.env`: a variable that was
  // never set is `undefined` however the type reads, and typed `string` an
  // undeclared read compiled and deployed. See `requireEnv`.
  env: Readonly<Partial<Record<string, string>>>;
  /**
   * This session's slot storage — **reach for {@link sessionSlot}, not this**,
   * exactly as in a tool. It is on the context because a slot declared in one
   * module has no other way to find the session.
   *
   * A handler's writes are committed after it returns, so a hook that mutates
   * should do so SYNCHRONOUSLY. An `await` before `slot.update` still stores the
   * value, but it lands after the commit for this event and is not persisted
   * until the next one (or the next tool call) commits — which for a `durable`
   * slot means a crash in between loses it.
   */
  slots: SlotStore;
};

/**
 * One handler: an event of the type it was declared under, plus the context.
 *
 * The return type is `unknown`, and that is deliberate rather than lazy.
 * `void | Promise<void>` reads better and does not compile for the most obvious
 * handler anyone writes: TypeScript's rule that a value-returning function is
 * assignable where `void` is expected applies to `void` ALONE, not to a union
 * containing it — so `(e) => seen.push(e)` (returning `number`) and
 * `(e) => void persist(…)` are errors, on an observe-only API where the return
 * value is by definition ignored. `unknown` accepts every shape, and the emitter
 * checks for a promise at run time to decide whether to attach a rejection
 * handler.
 */
export type SessionEventHandler<E extends SessionEvent = SessionEvent> = (
  event: E,
  ctx: SessionEventContext,
) => unknown;

/**
 * Every event name a handler map may be keyed by, as a union.
 *
 * The keys of {@link SessionEventHandlers} are computed from the wire union, so
 * without this alias the only way to read the list is the event schema itself —
 * which renders as one long type expression. Name it to get an autocompletable
 * union, and to write a handler map's key type down in your own code:
 *
 * ```ts
 * import type { SessionEventType } from "@alexkroman1/aai";
 *
 * const AUDITED: readonly SessionEventType[] = ["tool.called", "error.reported"];
 * ```
 *
 * @public
 */
export type SessionEventType = SessionEvent["type"];

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
  [K in SessionEventType]?: SessionEventHandler<Extract<SessionEvent, { type: K }>>;
} & {
  /** Runs for every event, AFTER the typed handler for that event. */
  "*"?: SessionEventHandler;
};
