/**
 * Their `HotelDB`, as functions over the session's state.
 *
 * Every query here was a SQL statement (`_SQL_AVAILABILITY`, `_SQL_FREE_ROOM`,
 * `_SQL_FREE_BETTER_ROOM`, …) and every mutation a transaction. A slot is a plain
 * object, so a query is a filter and a mutation writes the draft it is handed —
 * which is why the WRITERS take a {@link HotelState} and the READERS take the
 * frozen shape: a mutable state satisfies `FrozenHotelState`, so a tool inside
 * `hotelSlot.update` can call either, while a read-only tool can call only the
 * reads.
 *
 * What did not change is the rule each query encodes, stated where it lives:
 * two stays overlap unless one ends before the other starts; a modified booking
 * keeps its own room when that room still fits; a conflicted guest is moved to
 * the same category or better, never down; a table shift prefers the table the
 * party already has.
 *
 * **Every writer here answers `T | ToolFailure`, and the three that open with a
 * lookup are `failable`.** `updateBooking`, `cancelBooking` and
 * `resolveRoomConflict` each began by re-deriving `find(b => b.code === code &&
 * b.status === "confirmed")` and the same `booking not found` sentence, and
 * `resolveRoomConflict` re-derived the floor-plan lookup on top. Those are
 * {@link requireConfirmedBooking} and `requireFloorPlanRoom` now, and the
 * forwarding is `orFail` — `failable` replaces the `function` keyword, so it
 * costs nothing and each guard statement it removes is a line. A lookup that
 * ends in a REFUSAL still returns one plainly: `failable` absorbs it, and the
 * spelling stays the one a reader can see the sentence in.
 */

import type { ToolFailure } from "@alexkroman1/aai";
import { failable, orFail, spokenAlphanumeric, toolFailure } from "@alexkroman1/aai";
import {
  addDays,
  computeInvoice,
  daysBetween,
  digitsOf,
  type Invoice,
  mintCode,
  type Room,
  type RoomBooking,
  type RoomExtra,
  type RoomType,
  type RoomView,
  speakUsd,
  TODAY,
  WALK_PARTNER_HOTEL,
} from "./records.ts";
import { addTicket, type FrozenHotelState, type HotelState, note, takenCodes } from "./shared.ts";

// ─── Rooms ───────────────────────────────────────────────────────────────────

/** Two stays overlap unless one ends before the other begins. ISO dates compare as strings. */
function overlaps(
  a: { checkIn: string; checkOut: string },
  checkIn: string,
  checkOut: string,
): boolean {
  return !(a.checkOut <= checkIn || a.checkIn >= checkOut);
}

/** Is `room` free for the whole window, ignoring the booking `exclude` names? */
function roomFree(
  state: FrozenHotelState,
  roomId: string,
  checkIn: string,
  checkOut: string,
  exclude: string | null,
): boolean {
  return !state.bookings.some(
    (b) =>
      b.roomId === roomId &&
      b.status === "confirmed" &&
      b.code !== exclude &&
      overlaps(b, checkIn, checkOut),
  );
}

/**
 * One bookable type+view pairing and what the cheapest room in it costs.
 *
 * The pairing is the unit a caller actually picks, not the type: rate varies
 * with the view (a city king is 240 a night, an ocean king 260), so a price
 * quoted per type is a price that moves once the view is known.
 */
export interface RoomOption {
  type: RoomType;
  view: RoomView;
  nightlyRate: number;
}

export interface StayQuery {
  checkIn: string;
  checkOut: string;
  guests: number;
  /** `undefined` is no preference — both kinds. */
  smoking?: boolean | undefined;
  /** A booking to ignore when checking for conflicts — the one being modified. */
  excludeCode?: string | null | undefined;
}

/** Their `_SQL_AVAILABILITY`: the free pairings for a stay, cheapest first. */
export function listRoomOptions(state: FrozenHotelState, q: StayQuery): RoomOption[] {
  const best = new Map<string, RoomOption>();
  for (const room of state.rooms) {
    if (room.maxOccupancy < q.guests) continue;
    if (q.smoking !== undefined && room.smoking !== q.smoking) continue;
    if (!roomFree(state, room.id, q.checkIn, q.checkOut, q.excludeCode ?? null)) continue;
    const key = `${room.type}/${room.view}`;
    const seen = best.get(key);
    if (seen === undefined || room.nightlyRate < seen.nightlyRate) {
      best.set(key, { type: room.type, view: room.view, nightlyRate: room.nightlyRate });
    }
  }
  return [...best.values()].sort(
    (a, b) =>
      a.nightlyRate - b.nightlyRate || a.type.localeCompare(b.type) || a.view.localeCompare(b.view),
  );
}

/**
 * The bookable pairings as one line each — one type with one view and that
 * pairing's price. Rolling a type's views onto a single line lets a neighbouring
 * line's view bind to the wrong type (a garden-view king, which has never
 * existed) and hides that the view moves the price.
 */
export function describeRoomOptions(options: readonly RoomOption[]): string {
  return options
    .map(
      (o) => `- ${o.type.replaceAll("_", " ")}, ${o.view} view: ${speakUsd(o.nightlyRate)}/night`,
    )
    .join("\n");
}

export interface FreeRoomQuery extends StayQuery {
  roomType: RoomType;
  smoking: boolean;
  view?: RoomView | null | undefined;
  /** The room to hand out if it still fits — a date change must never quietly
   *  move someone out of their garden view. */
  prefer?: string | null | undefined;
}

/** Their `_SQL_FREE_ROOM`: the room `bookRoom` would pick, cheapest first. */
export function freeRoom(state: FrozenHotelState, q: FreeRoomQuery): Room | undefined {
  const candidates = state.rooms.filter(
    (room) =>
      room.type === q.roomType &&
      room.smoking === q.smoking &&
      room.maxOccupancy >= q.guests &&
      (q.view === undefined || q.view === null || room.view === q.view) &&
      roomFree(state, room.id, q.checkIn, q.checkOut, q.excludeCode ?? null),
  );
  candidates.sort(
    (a, b) =>
      Number(b.id === q.prefer) - Number(a.id === q.prefer) ||
      a.nightlyRate - b.nightlyRate ||
      a.id.localeCompare(b.id),
  );
  // `.sort` on a readonly array's filter result is fine: `filter` returns a fresh, mutable array.
  return candidates[0] as Room | undefined;
}

/** The exact total (with tax) for the room `bookRoom` would pick right now, so
 *  the read-back quotes the real number and never per-night arithmetic. */
export function peekStayTotal(
  state: FrozenHotelState,
  q: FreeRoomQuery,
  extras: readonly RoomExtra[],
): number | null {
  const room = freeRoom(state, q);
  if (room === undefined) return null;
  return computeInvoice(room.nightlyRate, daysBetween(q.checkIn, q.checkOut), extras).total;
}

/**
 * The CONFIRMED booking a code names, or the refusal.
 *
 * Three writers below opened with the same `find(b => b.code === code &&
 * b.status === "confirmed")` and the same `booking not found: ${code}`
 * sentence, and `resolveRoomConflict` then re-derived the floor-plan lookup on
 * top of it. One helper answering `RoomBooking | ToolFailure` is what lets each
 * of them start with a single `orFail` line instead — the forwarding is written
 * once, in the SDK, rather than as a guard statement per lookup.
 */
export function requireConfirmedBooking<S extends FrozenHotelState | HotelState>(
  state: S,
  code: string,
): S["bookings"][number] | ToolFailure {
  const booking = state.bookings.find((b) => b.code === code && b.status === "confirmed");
  return booking ?? toolFailure(`booking not found: ${code}`);
}

/** The room a booking sits in, or the refusal — a booking always has one. */
function requireFloorPlanRoom<S extends FrozenHotelState | HotelState>(
  state: S,
  roomId: string,
): S["rooms"][number] | ToolFailure {
  const room = state.rooms.find((r) => r.id === roomId);
  return room ?? toolFailure(`room ${roomId} is not on the floor plan`);
}

export interface BookRoomInput {
  roomType: RoomType;
  smoking: boolean;
  view: RoomView | null;
  guests: number;
  checkIn: string;
  checkOut: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  cardLast4: string;
  extras: readonly RoomExtra[];
}

/** Their `book_room`: pick the room, price the stay, write the booking and its invoice. */
export function bookRoom(state: HotelState, input: BookRoomInput): RoomBooking | ToolFailure {
  const room = freeRoom(state, { ...input, excludeCode: null, prefer: null });
  if (room === undefined) {
    const what = input.view ? `${input.view}-view ${input.roomType}` : input.roomType;
    return toolFailure(`sold out: no ${what.replaceAll("_", " ")} is free for those dates`);
  }
  const nights = daysBetween(input.checkIn, input.checkOut);
  const extras = [...input.extras].sort();
  const priced = computeInvoice(room.nightlyRate, nights, extras);
  const booking: RoomBooking = {
    code: mintCode("HTL", takenCodes(state)),
    roomId: room.id,
    firstName: input.firstName,
    lastName: input.lastName,
    // Spoken emails are case-free; transcription capitalization is noise.
    email: input.email.trim().toLowerCase(),
    phone: digitsOf(input.phone) || input.phone,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    guests: input.guests,
    extras,
    total: priced.total,
    cardLast4: input.cardLast4,
    status: "confirmed",
    lateArrivalNote: null,
  };
  state.bookings.push(booking);
  state.invoices.push({ bookingCode: booking.code, ...priced, paid: false });
  note(state, `Booked ${booking.code}: room ${room.id}, ${input.checkIn} → ${input.checkOut}`);
  return booking;
}

export interface UpdateBookingInput {
  roomType: RoomType;
  smoking: boolean;
  view: RoomView | null;
  guests: number;
  checkIn: string;
  checkOut: string;
  extras: readonly RoomExtra[];
}

/**
 * Their `update_booking`: re-pick a free room of the new type for the new dates,
 * ignoring the booking itself (so "extend by one night" does not conflict with
 * its own stay), preferring the room the guest already has. A requested `view`
 * filters to rooms with that view — which is how an unhappy guest gets MOVED.
 */
export const updateBooking = failable(
  (state: HotelState, code: string, input: UpdateBookingInput): RoomBooking | ToolFailure => {
    const booking = orFail(requireConfirmedBooking(state, code));
    const room = freeRoom(state, { ...input, excludeCode: code, prefer: booking.roomId });
    if (room === undefined) {
      const what = input.view ? `${input.view}-view ${input.roomType}` : input.roomType;
      return toolFailure(`sold out: no ${what.replaceAll("_", " ")} is free for those dates`);
    }
    const nights = daysBetween(input.checkIn, input.checkOut);
    const extras = [...input.extras].sort();
    const priced = computeInvoice(room.nightlyRate, nights, extras);
    booking.roomId = room.id;
    booking.checkIn = input.checkIn;
    booking.checkOut = input.checkOut;
    booking.guests = input.guests;
    booking.extras = extras;
    booking.total = priced.total;
    const invoice = state.invoices.find((i) => i.bookingCode === code);
    if (invoice) Object.assign(invoice, priced);
    note(state, `Updated ${code}: room ${room.id}, ${input.checkIn} → ${input.checkOut}`);
    return booking;
  },
);

/** Their `cancel_room_booking` — the status flip only; the refund maths is the tool's. */
export const cancelBooking = failable((state: HotelState, code: string): RoomBooking => {
  const booking = orFail(requireConfirmedBooking(state, code));
  booking.status = "cancelled";
  note(state, `Cancelled ${code}`);
  return booking;
});

/**
 * Their `reinstate_booking`: reactivate a cancelled booking, but only if its
 * original room is still free for its dates. A no-op on a confirmed one.
 */
export function reinstateBooking(state: HotelState, code: string): RoomBooking | ToolFailure {
  const booking = state.bookings.find((b) => b.code === code);
  if (booking === undefined) return toolFailure(`booking not found: ${code}`);
  if (booking.status === "confirmed") return booking;
  if (!roomFree(state, booking.roomId, booking.checkIn, booking.checkOut, code)) {
    return toolFailure("that room is no longer free for those dates");
  }
  booking.status = "confirmed";
  note(state, `Reinstated ${code}`);
  return booking;
}

/** The overlap window if another confirmed booking holds this booking's room. */
export function roomConflict(
  state: FrozenHotelState,
  code: string,
): { from: string; to: string } | null {
  const a = state.bookings.find((b) => b.code === code && b.status === "confirmed");
  if (a === undefined) return null;
  const b = state.bookings.find(
    (other) =>
      other.roomId === a.roomId &&
      other.code !== a.code &&
      other.status === "confirmed" &&
      other.checkIn < a.checkOut &&
      other.checkOut > a.checkIn,
  );
  if (b === undefined) return null;
  return {
    from: a.checkIn > b.checkIn ? a.checkIn : b.checkIn,
    to: a.checkOut < b.checkOut ? a.checkOut : b.checkOut,
  };
}

export type ConflictResolution =
  | { kind: "moved"; roomId: string; type: RoomType; view: RoomView; upgraded: boolean }
  | { kind: "walked"; partner: string; returnDate: string };

/**
 * The house re-accommodation procedure, in fixed order: move the booking to a
 * free room of the same or higher category for the whole remaining stay — an
 * upgrade is free — and only when nothing in the house fits, arrange a walk:
 * tonight at the partner hotel on us, back in the original room the next day.
 *
 * The rate on the booking never changes: a forced move is never the guest's
 * cost, so an upgrade rides at the original total.
 */
export const resolveRoomConflict = failable(
  (state: HotelState, code: string): ConflictResolution | ToolFailure => {
    const booking = orFail(requireConfirmedBooking(state, code));
    if (roomConflict(state, code) === null) {
      return toolFailure("no room conflict on this booking - nothing to resolve");
    }
    const original = orFail(requireFloorPlanRoom(state, booking.roomId));
    const start = booking.checkIn > TODAY ? booking.checkIn : TODAY;

    // Their `_SQL_FREE_BETTER_ROOM`: fits the party, matches smoking, same or
    // higher rate, free for the whole remaining stay, cheapest first.
    const candidate = state.rooms
      .filter(
        (r) =>
          r.id !== original.id &&
          r.maxOccupancy >= booking.guests &&
          r.smoking === original.smoking &&
          r.nightlyRate >= original.nightlyRate &&
          roomFree(state, r.id, start, booking.checkOut, code),
      )
      .sort((a, b) => a.nightlyRate - b.nightlyRate || a.id.localeCompare(b.id))[0];

    if (candidate !== undefined) {
      booking.roomId = candidate.id;
      note(state, `Conflict on ${code}: moved to ${candidate.id}`);
      return {
        kind: "moved",
        roomId: candidate.id,
        type: candidate.type,
        view: candidate.view,
        upgraded: candidate.nightlyRate > original.nightlyRate,
      };
    }

    const returnDate = addDays(start, 1);
    addTicket(state, "walk", "WLK", `${code} walked to ${WALK_PARTNER_HOTEL}, back ${returnDate}`, {
      bookingCode: code,
      partnerHotel: WALK_PARTNER_HOTEL,
      returnDate,
    });
    return { kind: "walked", partner: WALK_PARTNER_HOTEL, returnDate };
  },
);

/**
 * A spoken room number ("304", "room 304", "ph") as the floor plan spells it.
 *
 * The strip-and-fold is `spokenAlphanumeric`'s — this had its own regex pair
 * doing the same job in the other order, and it is `normalizeCode`'s basis too,
 * so the desk now reads a room number and a confirmation code by one rule. What
 * stays local is the word "room" itself, which is this floor plan's vocabulary
 * rather than a fact about spoken ids.
 */
export function requireRoom(state: FrozenHotelState, spoken: string): Room | ToolFailure {
  const id = spokenAlphanumeric(spoken).replace(/^(ROOM|RM)/, "");
  const room = state.rooms.find((r) => r.id === id);
  return (
    room ?? toolFailure(`no such room: ${spoken} - re-confirm the room number with the caller`)
  );
}

export function invoiceFor(state: FrozenHotelState, code: string): Invoice | undefined {
  return state.invoices.find((i) => i.bookingCode === code) as Invoice | undefined;
}
