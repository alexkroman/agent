/**
 * The restaurant half of their `HotelDB` — its tables, its eight seatings, and
 * the three writes a reservation ever takes.
 *
 * Split out of `hotel.ts` when that file crossed the 500-line source cap, and
 * along a seam that was already there: nothing here touches a room, a booking
 * or an invoice, and nothing in `hotel.ts` touches a table. Their schema kept
 * the two apart for the same reason — a restaurant reservation is not a stay,
 * and the only thing the two share is the guest's name.
 *
 * The rules each query encodes are stated where they live: the smallest free
 * table that seats the party wins, a shift prefers the table the party already
 * has, and a code is compared the way a caller reads one out.
 */

import type { ToolFailure } from "@alexkroman1/aai";
import { toolFailure } from "@alexkroman1/aai";
import { DINNER_SLOTS, digitsOf, mintCode, normalizeCode, type Reservation } from "./records.ts";
import { type FrozenHotelState, type HotelState, note, takenCodes } from "./shared.ts";

/** Their `list_restaurant_availability`: the open slots for a date and party. */
export function openDinnerSlots(
  state: FrozenHotelState,
  date: string,
  partySize: number,
): string[] {
  return DINNER_SLOTS.filter((slot) => freeTable(state, date, slot, partySize) !== undefined);
}

/** The smallest free table that seats the party at that slot. */
export function freeTable(
  state: FrozenHotelState,
  date: string,
  time: string,
  partySize: number,
  options: { exclude?: string; prefer?: number } = {},
) {
  const taken = new Set(
    state.reservations
      .filter(
        (r) =>
          r.status === "confirmed" &&
          r.date === date &&
          r.time === time &&
          r.code !== options.exclude,
      )
      .map((r) => r.tableId),
  );
  // The ordering picks a single winner, so this is a MINIMUM, not a sort: the
  // filtered copy and the O(t log t) that followed it both went to read `[0]`.
  // Same comparator, one pass, no intermediate array.
  type Seat = (typeof state.tables)[number];
  const order = (a: Seat, b: Seat) =>
    Number(b.id === options.prefer) - Number(a.id === options.prefer) ||
    a.capacity - b.capacity ||
    a.id - b.id;
  let best: Seat | undefined;
  for (const table of state.tables) {
    if (table.capacity < partySize || taken.has(table.id)) continue;
    if (best === undefined || order(table, best) < 0) best = table;
  }
  return best;
}

export interface ReserveTableInput {
  firstName: string;
  lastName: string;
  phone: string;
  partySize: number;
  date: string;
  time: string;
  notes: string | null;
}

export function reserveTable(
  state: HotelState,
  input: ReserveTableInput,
): Reservation | ToolFailure {
  const table = freeTable(state, input.date, input.time, input.partySize);
  if (table === undefined) return toolFailure(`restaurant full: ${input.date} ${input.time}`);
  const reservation: Reservation = {
    code: mintCode("RES", takenCodes(state)),
    tableId: table.id,
    firstName: input.firstName,
    lastName: input.lastName,
    phone: digitsOf(input.phone) || input.phone,
    partySize: input.partySize,
    date: input.date,
    time: input.time,
    notes: input.notes,
    status: "confirmed",
  };
  state.reservations.push(reservation);
  note(
    state,
    `Reserved ${reservation.code}: ${input.date} ${input.time}, party of ${input.partySize}`,
  );
  return reservation;
}

/**
 * Their `modify_restaurant_reservation`: a new date and time (and optionally a
 * new party size), keeping the code. Prefers the reservation's CURRENT table
 * when it is still free and big enough, so a same-evening shift keeps the seat.
 */
export function modifyReservation(
  state: HotelState,
  code: string,
  date: string,
  time: string,
  partySize: number | null,
): Reservation | ToolFailure {
  const reservation = state.reservations.find((r) => r.code === code && r.status === "confirmed");
  if (reservation === undefined) return toolFailure(`reservation not found: ${code}`);
  const party = partySize ?? reservation.partySize;
  const table = freeTable(state, date, time, party, { exclude: code, prefer: reservation.tableId });
  if (table === undefined) return toolFailure(`restaurant full: ${date} ${time}`);
  reservation.tableId = table.id;
  reservation.partySize = party;
  reservation.date = date;
  reservation.time = time;
  note(state, `Moved ${code} to ${date} ${time}, party of ${party}`);
  return reservation;
}

/**
 * A reservation by last name and code, whatever its status.
 *
 * Both sides go through {@link normalizeCode}, which is what `verify_booking`
 * uses on a room booking. The two halves here used to differ — the caller's
 * code was stripped of punctuation and folded, the STORED one only of its dash
 * — so `RES-AB12` compared as `RESAB12` against a `res ab12` that had already
 * become `RESAB12` and matched, while "R E S dash A B one two", which is how a
 * caller reads a code down a phone, kept the word `dash` and never did.
 */
export function findReservation<S extends FrozenHotelState | HotelState>(
  state: S,
  lastName: string,
  code: string,
): S["reservations"][number] | undefined {
  const wanted = normalizeCode(code);
  return state.reservations.find(
    (r) =>
      r.lastName.toLowerCase() === lastName.trim().toLowerCase() &&
      normalizeCode(r.code) === wanted,
  );
}
