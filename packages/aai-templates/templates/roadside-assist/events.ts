import type {
  SessionEventContext,
  SessionEventHandler,
  SessionEventHandlers,
  SessionEventType,
} from "@alexkroman1/aai";
import { roadsideSlot } from "./shared.ts";

/**
 * The two things that happen to a roadside call which no tool can write down.
 *
 * The desk's log is the record of what happened on this call, and every line in
 * it so far was written by a tool — which means the log has nothing to say about
 * the two outcomes that involve no tool at all: the caller hanging up, and the
 * line itself failing. Both arrive as SESSION EVENTS, and an `events` handler is
 * how an agent observes its own stream.
 *
 * This is the second half of what `agent({ dialogs })` already does with
 * `@session.timed-out`. The dialog MOVES on a hang-up (to the final `abandoned`
 * state, which refuses every tool for the rest of the session); a handler
 * RECORDS it. Neither can do the other's job — a handler cannot change what the
 * agent says or does, by design, and a dialog transition writes nothing to the
 * slot — and the split is why both exist for one event.
 *
 * Three properties of a handler that this file depends on, all the SDK's:
 * a handler is OBSERVE-ONLY, a throw in one is non-fatal (a failing audit hook
 * must not end a phone call), and delivery is at-least-once. Nothing here is
 * non-idempotent — a duplicate line in a call log is not a duplicate truck —
 * so the last one costs nothing to accept.
 */

/**
 * Every session event the desk writes a line for.
 *
 * `satisfies readonly SessionEventType[]` rather than a bare `as const`: a name
 * that is not a wire event type fails HERE, at three characters of type
 * annotation, instead of becoming a handler key the runtime never calls. That
 * failure is otherwise invisible — an unmatched key is not an error, it is a
 * hook that quietly never fires — and `agent.test.ts` pins the roster against
 * what {@link DESK_EVENTS} actually declares.
 */
export const LOGGED_EVENTS = [
  "session.timed-out",
  "error.reported",
] as const satisfies readonly SessionEventType[];

/**
 * One line in the desk's own record of the call.
 *
 * Takes {@link SessionEventContext} — which is what a handler is handed, and is
 * NOT a `ToolContext`: there is no `generate`, no `delegate`, no `send`, and
 * nothing here could speak to the caller if it wanted to. What it does carry is
 * `slots`, which is all a slot write needs.
 */
function note(ctx: SessionEventContext, line: string): void {
  roadsideSlot.update(ctx, (state) => {
    state.log.push(line);
  });
}

/**
 * The caller is gone.
 *
 * Typed with the WIDE {@link SessionEventHandler} because it reads nothing off
 * the event — a handler that accepts any session event is assignable to any
 * key, which is the contravariance a mapped handler table gives for free. Its
 * neighbour below is written inline for the opposite reason: it reads `code`
 * and `message`, so it needs the narrowing the key provides.
 */
const noteHangUp: SessionEventHandler = (_event, ctx) => {
  note(ctx, "Caller gone — no dispatch, no lookup, no callback promised.");
};

/**
 * What `agent({ events })` is handed.
 *
 * Annotated rather than inferred, and the annotation is what does the work:
 * the mapped type narrows each handler's `event` to the one wire event its key
 * names, so the `error.reported` handler below reads `code` and `message`
 * without a guard and could not read a field belonging to another event.
 */
export const DESK_EVENTS: SessionEventHandlers = {
  "session.timed-out": noteHangUp,
  // Not always fatal — a turn-level STT failure is one the session survives —
  // so the line says which it was. A caller who was cut off mid-disclosure and
  // one whose transcription hiccuped are the same silence on a recording and
  // very different things to answer a complaint with.
  "error.reported": (event, ctx) => {
    const how = event.fatal ? "call dropped" : "recovered";
    note(ctx, `Line trouble (${event.code}, ${how}): ${event.message}`);
  },
};
