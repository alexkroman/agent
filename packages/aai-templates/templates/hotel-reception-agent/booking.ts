/**
 * Where a room booking stands, derived from what has been captured.
 *
 * Their `BookRoomTask._step()` reads the draft on every call and answers which
 * of seven steps the flow is on, so a correction lands the flow back on the
 * right step with no rollback bookkeeping. Here the same derivation answers the
 * EVENT the recording tool should send: every recording tool ends with
 * `sendFrom: (r) => ({ type: r.next })`, and the `booking` dialog in `desk.ts`
 * has a child state per step. Two things their flow expressed with a private
 * `_Owed` object — "offer the options before a room may be picked", "read the
 * booking back before it may be confirmed" — are states the dialog leaves on
 * the caller's next committed turn, so they need no counter at all.
 */

import { peekStayTotal } from "./hotel.ts";
import type { Room, RoomBooking } from "./records.ts";
import { speakUsd } from "./records.ts";
import { type BookingDraft, bookingByCode, type HotelState, newDraft } from "./shared.ts";

/** The event a recording tool sends: the step the draft is on now. */
export type BookingStep =
  | "NEED_STAY"
  | "NEED_ROOM"
  | "NEED_EXTRAS"
  | "NEED_DETAILS"
  | "NEED_CARD"
  | "READ_BACK";

/** The details still uncaptured, in ladder order. Empty means all present. */
export function missingDetails(d: BookingDraft): string[] {
  const missing: string[] = [];
  if (!(d.firstName && d.lastName)) missing.push("name");
  if (!d.email) missing.push("email");
  if (!d.phone) missing.push("phone");
  return missing;
}

/** Their `_step()`: derived from the captured values on every read. */
export function nextStep(d: BookingDraft): BookingStep {
  if (d.checkIn === null) return "NEED_STAY";
  if (d.roomType === null) return "NEED_ROOM";
  if (!d.extrasSet) return "NEED_EXTRAS";
  if (missingDetails(d).length > 0) return "NEED_DETAILS";
  if (d.cardLast4 === null) return "NEED_CARD";
  return "READ_BACK";
}

/**
 * Their `_status()`: an ACTION-oriented status, never a missing-field list. A
 * "still need: card" string gets parroted by the model as "What card should I
 * use?" — the field name leaks straight into the spoken question. Phrasing each
 * step as the next action avoids that.
 */
export function bookingStatus(d: BookingDraft): string {
  const step = nextStep(d);
  if (step === "READ_BACK") {
    const total = d.quotedTotal === null ? "" : `total ${speakUsd(d.quotedTotal)} including tax, `;
    return (
      "all required details captured - read the booking back in ONE sentence (dates, " +
      `${d.guests} guests, room and extras, ${total}card ending ${d.cardLast4}) and wait for the ` +
      "caller to agree; confirm_booking opens once they have answered. Quote ONLY this total - " +
      "never compute your own."
    );
  }
  if (step === "NEED_DETAILS") {
    return `room and extras captured - next: ask for the guest's ${missingDetails(d)[0]}, then call record_guest_details`;
  }
  return STATUS_BY_STEP[step];
}

/** The fixed directives, one per step that needs nothing from the draft. */
const STATUS_BY_STEP: Record<Exclude<BookingStep, "READ_BACK" | "NEED_DETAILS">, string> = {
  NEED_STAY: "no stay yet - ask the caller for dates and party size, then call set_stay",
  NEED_ROOM: "stay captured - ask which room type, then call choose_room",
  NEED_EXTRAS:
    "room captured, no total yet - offer the extras and ask which the caller wants, then call " +
    "set_extras (all four false if they want none). Each extra moves the total, so the total " +
    "only exists once this is answered",
  NEED_CARD: "guest details captured - next: take the card, then call record_card",
};

/** A fresh draft for a NEW booking. */
export function draftForNewBooking(): BookingDraft {
  return newDraft();
}

/**
 * Their `ModifyBookingTask.__init__`: a draft pre-filled from the booking, so
 * the recording tools change only what the caller names. Identity and card are
 * carried over — they are not modifiable here — which is what lets `nextStep`
 * land straight on `READ_BACK` after a change.
 */
export function draftForModification(booking: RoomBooking, room: Room): BookingDraft {
  return {
    mode: "modify",
    existingCode: booking.code,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guests: booking.guests,
    roomType: room.type,
    // `null` = no view change requested, so `confirm_booking` keeps the guest's
    // current room when it still fits. A stated view re-picks the room.
    view: null,
    smoking: room.smoking,
    extras: [...booking.extras],
    extrasSet: true,
    firstName: booking.firstName,
    lastName: booking.lastName,
    email: booking.email,
    phone: booking.phone,
    cardLast4: booking.cardLast4,
    quotedTotal: booking.total,
  };
}

/** What a modification draft differs from its booking on — their `_changed`. */
export function changedFields(d: BookingDraft, booking: RoomBooking, room: Room): string[] {
  const changed: string[] = [];
  if (
    d.checkIn !== booking.checkIn ||
    d.checkOut !== booking.checkOut ||
    d.guests !== booking.guests
  ) {
    changed.push("stay");
  }
  // A stated view re-picks the room, so it is a change even when the type is
  // unchanged — the whole point of moving an unhappy guest.
  if (d.roomType !== null && (d.roomType !== room.type || d.view !== null)) changed.push("room");
  if (d.smoking !== room.smoking) changed.push("smoking");
  if ([...d.extras].sort().join() !== [...booking.extras].sort().join()) changed.push("extras");
  return changed;
}

/**
 * Recompute the exact total for the room `confirm_booking` would pick right now.
 * Stays `null` until the extras are answered — a total quoted before then is one
 * that changes the moment the caller says "and breakfast".
 */
export function requote(hotel: HotelState, d: BookingDraft): void {
  if (!(d.extrasSet && d.roomType && d.checkIn && d.checkOut && d.guests)) {
    d.quotedTotal = null;
    return;
  }
  const existing = d.existingCode === null ? undefined : bookingByCode(hotel, d.existingCode);
  d.quotedTotal = peekStayTotal(
    hotel,
    {
      roomType: d.roomType,
      smoking: d.smoking,
      guests: d.guests,
      checkIn: d.checkIn,
      checkOut: d.checkOut,
      view: d.view,
      excludeCode: d.existingCode,
      prefer: existing?.roomId ?? null,
    },
    d.extras,
  );
}
