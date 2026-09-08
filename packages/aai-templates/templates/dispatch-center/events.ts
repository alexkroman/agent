import type { SessionEventHandlers } from "@alexkroman1/aai";
import { callInHand, dispatchSlot, logEvent } from "./shared.ts";

/**
 * The one thing that happens on a 911 call which no tool can write down: the
 * caller stops being there.
 *
 * Every line on an incident's timeline so far was written by a tool, so the
 * board has nothing to say about the outcome that involves no tool at all — the
 * line going dead. It arrives as a SESSION EVENT, and `agent({ events })` is
 * how an agent observes its own stream.
 *
 * **The dialog deliberately does NOT move on it, and that is the difference
 * between this desk and a phone desk.** `retail` and `roadside-assist` both
 * carry `"@session.timed-out"` into a `final` state, because there the caller
 * IS the conversation and a hang-up ends it. Here the caller is one input to a
 * shift: units are rolling, the board is live, and the dispatcher goes on
 * working every incident on it. So a hang-up is a FACT ABOUT ONE INCIDENT,
 * recorded where the rest of that incident's history is, and `callFlow` stays
 * exactly where it was.
 *
 * Which incident is {@link callInHand}'s question, and it is the same question
 * the flow's position answers — see its doc. On a shift with nothing open there
 * is nothing to write and nothing is written; a dropped call before the first
 * `incident_create` left no record to annotate.
 *
 * Three properties of a handler this file depends on, all the SDK's: a handler
 * is OBSERVE-ONLY (nothing here can make the desk say anything — a dispatcher
 * finding out is the timeline's job), a throw in one is non-fatal, and delivery
 * is at-least-once. The last one is why the line is worth checking against:
 * a duplicated timeline entry is a cosmetic repeat, not a duplicated truck.
 */
export const DISPATCH_EVENTS: SessionEventHandlers = {
  "session.timed-out": (_event, ctx) => {
    // A `SessionEventContext` is a `SlotHolder`, which is all a slot write
    // needs — and all it is: there is no `generate`, no `send`, and no way for
    // this to reach the caller who has just gone.
    dispatchSlot.update(ctx, (state) => {
      const incident = callInHand(state);
      if (incident === undefined) return;
      logEvent(
        incident,
        "CALLER LOST — line dropped or went silent. Units stay committed; " +
          "attempt callback on the number on file.",
      );
    });
  },
};
