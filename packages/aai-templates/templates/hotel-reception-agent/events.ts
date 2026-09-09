/**
 * The one thing that happens on this call when no tool is running: the caller
 * goes away.
 *
 * `desk.ts` already handles the CONVERSATION half — `@session.timed-out` moves
 * the dialog to `hungUp`, which is `final`, so a model still talking to a dead
 * line cannot confirm a booking. What a transition does not do is WRITE
 * anything, and a booking abandoned at the card step is exactly the row their
 * schema had a table for: `record_followup(kind: "abandoned_booking")`, which
 * their receptionist called when a caller said they would ring back. Nobody can
 * call it once the caller is gone, so the desk was losing the one lead a
 * dropped booking leaves behind — the guest's name and number, and how far they
 * got.
 *
 * This is the pairing `agent({ dialogs })` + `agent({ events })` exists for: the
 * dialog decides what the agent may still DO, the handler records what
 * happened. A handler cannot speak, generate or send — nothing on the event
 * stream may decide what the agent says — and it does not need to: the call is
 * over.
 *
 * **The write is synchronous**, which is the rule for a hook rather than a
 * preference: a hook's write is committed after the handler returns, so an
 * `await` in front of `hotelSlot.update` would store the value outside the
 * commit. There is nothing to await here anyway.
 */

import type { SessionEventHandler, SessionEventHandlers, SlotHolder } from "@alexkroman1/aai";
import { bookingStatus } from "./booking.ts";
import type { Ticket } from "./records.ts";
import { digitsOf } from "./records.ts";
import { hotelSlot } from "./session.ts";
import { addTicket, note } from "./shared.ts";

/**
 * File the abandoned booking, if there was one, and return the ticket.
 *
 * Takes a {@link SlotHolder} — `{ slots, sessionId }`, the two fields any slot
 * accessor reads — rather than the `SessionEventContext` it is called with. The
 * annotation is the seam: it says this needs nothing an event carries, so the
 * spec drives it with an ordinary tool context and the same function serves
 * both. Answers `null` when no booking flow was open, which is the common case
 * (most calls end at the desk) and the one that must write nothing.
 */
export function recordAbandonedBooking(ctx: SlotHolder): Ticket | null {
  return hotelSlot.update(ctx, (hotel) => {
    note(hotel, "Caller gone - call ended");
    const d = hotel.draft;
    if (d === null) return null;
    // Cleared first: the sidebar's "Booking in progress" is a claim about a
    // live call, and the ledger entry below is what replaces it.
    hotel.draft = null;
    const who = [d.firstName, d.lastName].filter(Boolean).join(" ") || "name not given";
    const phone = d.phone === null ? "no number" : digitsOf(d.phone) || d.phone;
    return addTicket(hotel, "followup", "FUP", `abandoned_booking: ${who} dropped mid-booking`, {
      kind: "abandoned_booking",
      callerName: who,
      callerPhone: phone,
      // WHERE they got to, in the same words `bookingStatus` gives the model,
      // so whoever picks the lead up knows what is still to ask for.
      summary: `${d.mode === "modify" ? "modification" : "new booking"} abandoned - ${bookingStatus(d)}`,
      status: "open",
    });
  });
}

/** The caller hung up, or the line went quiet long enough to count as one. */
const onCallerGone: SessionEventHandler = (_event, ctx) => {
  recordAbandonedBooking(ctx);
};

/**
 * What `agent({ events })` is handed.
 *
 * Annotated rather than inferred because the KEYS are the whole contract: a
 * standalone literal would accept `"session.timedout"` as a perfectly good
 * property name and the handler would simply never run.
 */
export const DESK_EVENTS: SessionEventHandlers = {
  "session.timed-out": onCallerGone,
};
