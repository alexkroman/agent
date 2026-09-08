/**
 * What the CALL ITSELF writes on the call log — `agent({ events })`.
 *
 * Every other line in `TripState.log` is written by a tool, which means the log
 * records only what the model chose to do. The two things that end a call badly
 * are not tool calls at all: the caller hangs up, or the session reports an
 * error. Both arrive as session events, and until this file existed the sidebar
 * simply stopped — a log whose last line is "Awaiting confirmation: book
 * Harborview Suites…" reads as a call still in progress, of a caller who left.
 *
 * **A handler OBSERVES; it may not speak.** {@link SessionEventContext} carries
 * `slots` and deliberately no `send`, no `generate` and no `messages` — so the
 * only thing a hook here can do is record a fact, which is exactly the job. The
 * alternative the SDK's own doc names is worse and this template would have had
 * to take it: a tool the model is ASKED to call after a caller has already gone.
 *
 * **This is the second route the same hang-up takes, and the difference is the
 * point.** `gateFlow` declares `"@session.timed-out"` and moves the
 * conversation's POSITION to `abandoned`, which is what stops `confirm_action`
 * running for a caller who is not there. A handler cannot do that — it cannot
 * run a tool and does not settle `pending` — and a dialog cannot do this, because
 * a position is not a sentence anybody can read. One event, two declarations,
 * neither redundant.
 *
 * @module
 */

import type {
  SessionEventContext,
  SessionEventHandler,
  SessionEventHandlers,
} from "@alexkroman1/aai";
import { describeStaged, type FrozenTripState, tripSlot } from "./shared.ts";

/**
 * One line on the call log, from a hook.
 *
 * `line` is handed the state so an entry can name what was in flight, and takes
 * it FROZEN for the reason every other read helper here does. A hook's writes
 * commit after it returns, so this stays synchronous — an `await` before the
 * update lands after the commit for this event.
 */
function note(ctx: SessionEventContext, line: (trip: FrozenTripState) => string): void {
  tripSlot.update(ctx, (trip) => {
    trip.log.push(line(trip));
  });
}

/**
 * The caller is gone, and the log says what went with them.
 *
 * Typed as a bare {@link SessionEventHandler} because it reads nothing off the
 * event: a handler declared for the whole union is accepted under any one key,
 * which is the shape for the hooks that only care THAT something happened. The
 * staged action is NAMED rather than dropped — nothing applies it now, and a
 * booking the caller was never told about is the one thing a desk reading this
 * log afterwards needs to see.
 */
const noteHangUp: SessionEventHandler = (_event, ctx) =>
  note(ctx, (trip) =>
    trip.pending
      ? `Caller gone — never applied: ${describeStaged(trip.pending)}`
      : "Caller gone — nothing was waiting.",
  );

/**
 * The map the agent declares. Keyed by the wire event name, so a key that is not
 * one is a compile error rather than a handler that never runs — and a handler
 * declared under a key is handed THAT event, which is why the one below reads
 * `code`, `message` and `fatal` with no narrowing at the call site.
 */
export const callEvents: SessionEventHandlers = {
  "session.timed-out": noteHangUp,
  "error.reported": (event, ctx) =>
    note(ctx, () =>
      event.fatal
        ? `Call failed (${event.code}): ${event.message}`
        : `Trouble on the call (${event.code}): ${event.message}`,
    ),
};
