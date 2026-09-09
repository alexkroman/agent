/**
 * The hotel's world — its rooms, tables, ledgers and one session slot — and the
 * pure helpers every tool reaches for.
 *
 * **Adapted from LiveKit Agents' `hotel_receptionist` example** (Apache-2.0,
 * <https://github.com/livekit/agents>, `examples/hotel_receptionist/`): a
 * boutique-hotel receptionist over a live SQLite database, with sub-agents for
 * the booking flows and a policy knowledge base. It is the largest example that
 * repository ships — nineteen files, thirty-odd tools, five `AgentTask`s and a
 * twenty-table schema — and the one with the most MECHANISM behind its prompt:
 * verification the tools run, a booking flow whose next step is derived from
 * what has been captured, a dispute engine, and a re-accommodation procedure.
 *
 * | hotel_receptionist | here |
 * | --- | --- |
 * | `HotelDB` over apsw/SQLite, seeded by `fake_data/seed.py` | {@link HotelState}, one `sessionSlot` (in `session.ts`) seeded from `seed.ts` per session |
 * | `Userdata` (verified booking, turn counters, transferred_to) | the same fields on {@link HotelState} |
 * | `VerifyBookingTask` (last name + code, or + card last four; three strikes) | `tools/verify_booking.ts` + {@link requireVerified}, checked by every booking tool |
 * | `BookRoomTask` + `ModifyBookingTask` (one `AgentTask` each, `_step()` derived from captured values) | ONE `booking` dialog in `desk.ts`, `nextStep` in `booking.ts`, a `mode` on the draft |
 * | `_Owed` (speech owed before a tool may run, discharged by the caller's next turn) | `offering` and `readBack` states leaving on `@user-transcript.committed` |
 * | `GetNameTask` / `GetEmailTask` / `GetPhoneNumberTask` | `tools/record_guest_details.ts` |
 * | `GetCardTask` (Luhn, expiry, code length) | `tools/record_card.ts`, `tools/update_card.ts` |
 * | `BookRestaurantTask` | `tools/reserve_table.ts`, one call, refusing with the open slots |
 * | `DISPUTE_POLICIES` + `_resolve_dispute_outcome` | `disputes.ts`, verbatim |
 * | `resolve_room_conflict` + `_SQL_FREE_BETTER_ROOM` | `resolveRoomConflict` in `hotel.ts` |
 * | `policies/*.md` + `build_lookup_policy_tool` | `policies.ts` + `tools/lookup_policy.ts` |
 * | `TOURS` / `SPA_SERVICES` / `BUSINESS_CENTER_SERVICES` / `FLORIST_ARRANGEMENTS` | `catalogs.ts`, and `concierge.ts` makes one tool of each |
 * | `record_followup`, `take_guest_message`, `dispatch_emergency`, … (write-only tables) | {@link Ticket}s on the slot, rendered by `client.tsx` |
 * | a caller who rings off mid-booking (their `abandoned_booking` followup) | `events.ts`, on `agent({ events })` — the one write no tool can make |
 * | `HOTEL_TODAY=2026-06-08` (the simulation pin) | {@link TODAY}, fixed |
 * | `ui_view.py` (SQLite changesets streamed to the playground) | `deskView`, pushed by `syncState` via `session.ts`'s `deskProjection` |
 *
 * **The LLM never owns a money value**, which is their README's first
 * sentence and this port's too: every total comes out of {@link computeInvoice},
 * a dispute's refund is read off the stored line item, and a cancellation's
 * forfeit is one night at the RATE THE BOOKING HOLDS. A model that is handed the
 * number cannot mis-multiply it.
 *
 * **Their database was a SQLite file per session; ours is a slot.** Every write
 * their tools made was a row, and the grader diffed the final database against
 * an expected one — "did the call do real work" is a question about rows, not
 * about what the agent said. The slot is the same idea with the same
 * consequence: a spec asserts what is IN the state after a call, and the sidebar
 * renders the ledger of what this call wrote.
 *
 * **`TODAY` is frozen at their own simulation date.** Every seeded stay is an
 * offset from it (in-house, arriving tomorrow, the oversold night, the sold-out
 * Friday), and a receptionist reasons about "next Saturday" against it — a
 * template whose scenarios moved with the calendar would have a walk scenario
 * that only reproduces on Mondays. `executive-inbox-agent` freezes its calendar
 * for the same reason.
 */

import type { DeepReadonly, Message, ToolFailure } from "@alexkroman1/aai";
import { toolFailure } from "@alexkroman1/aai";
import {
  type Dispute,
  type GuestHistory,
  type Invoice,
  mintCode,
  normalizeCode,
  type Reservation,
  type RestaurantTable,
  type Room,
  type RoomBooking,
  type RoomExtra,
  type RoomType,
  type RoomView,
  spokenDate,
  type Ticket,
  type TicketKind,
  TODAY,
  type TransferDestination,
  usd,
} from "./records.ts";

// ─── The booking draft ───────────────────────────────────────────────────────

/**
 * What the `booking` dialog is capturing — their `BookRoomTask`'s private
 * fields and `ModifyBookingTask`'s draft, as one shape with a `mode`.
 *
 * Every field is `null` until captured, and `extrasSet` is tracked apart from
 * the list for the reason their comment gives: an empty extras list is a real
 * answer, indistinguishable from never having asked, and no total is quoted
 * until the question has been answered because every extra moves it.
 */
export interface BookingDraft {
  mode: "new" | "modify";
  /** The booking being modified, in `modify` mode. */
  existingCode: string | null;
  checkIn: string | null;
  checkOut: string | null;
  guests: number | null;
  roomType: RoomType | null;
  /** A stated view narrows WHICH room; `null` is "no preference". */
  view: RoomView | null;
  /** Opt-in, industry-standard: non-smoking unless the caller asks. */
  smoking: boolean;
  extras: RoomExtra[];
  extrasSet: boolean;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  cardLast4: string | null;
  /** The exact total for the room `confirm_booking` would pick right now. */
  quotedTotal: number | null;
}

export function newDraft(): BookingDraft {
  return {
    mode: "new",
    existingCode: null,
    checkIn: null,
    checkOut: null,
    guests: null,
    roomType: null,
    view: null,
    smoking: false,
    extras: [],
    extrasSet: false,
    firstName: null,
    lastName: null,
    email: null,
    phone: null,
    cardLast4: null,
    quotedTotal: null,
  };
}

// ─── Session state ───────────────────────────────────────────────────────────

export interface HotelState {
  rooms: Room[];
  tables: RestaurantTable[];
  bookings: RoomBooking[];
  reservations: Reservation[];
  invoices: Invoice[];
  disputes: Dispute[];
  guestHistory: GuestHistory[];
  /** Everything this call wrote that is not a booking, reservation or dispute. */
  tickets: Ticket[];
  /** The booking the caller has verified against, or `null`. */
  verifiedCode: string | null;
  /** Failed verifications on this call — three is where a human takes over. */
  verifyAttempts: number;
  draft: BookingDraft | null;
  /** Departments already transferred to: a transfer happens exactly once. */
  transferredTo: TransferDestination[];
  /**
   * The last cancellation's outcome, and how many times the caller had spoken
   * when it happened — so a cancel re-invoked with no caller input since
   * re-surfaces that answer instead of re-verifying into "already cancelled".
   */
  lastCancel: { message: string; callerTurns: number } | null;
  /** The last completed room booking and the caller-turn count at the time — the
   *  double-booking guard `start_room_booking` reads. */
  lastBooking: { code: string; callerTurns: number } | null;
  log: string[];
}

/**
 * The hotel's shape with nothing in it — no seed.
 *
 * `session.ts`'s {@link createHotelState} builds the real seeded state on top
 * of this, so the shape is declared once. It lives HERE, apart from that,
 * because `client.tsx` needs a `HotelState` for its pre-first-call fallback and
 * must not import `session.ts`: that module pulls `seed.ts`, which would then
 * land in the browser bundle.
 */
export function emptyHotelState(): HotelState {
  return {
    rooms: [],
    tables: [],
    bookings: [],
    reservations: [],
    invoices: [],
    disputes: [],
    guestHistory: [],
    tickets: [],
    verifiedCode: null,
    verifyAttempts: 0,
    draft: null,
    transferredTo: [],
    lastCancel: null,
    lastBooking: null,
    log: [],
  };
}

/** The hotel as a READ hands it out: deep-frozen, and typed to say so. */
export type FrozenHotelState = DeepReadonly<HotelState>;

/** One line of the call log — the slot's `caps` keep it to the newest forty. */
export function note(state: HotelState, line: string): void {
  state.log.push(line);
}

/** Every reference this hotel has issued — what {@link mintCode} avoids. */
export function takenCodes(state: FrozenHotelState): Set<string> {
  return new Set([
    ...state.bookings.map((b) => b.code),
    ...state.reservations.map((r) => r.code),
    ...state.disputes.map((d) => d.caseNumber),
    ...state.tickets.map((t) => t.code),
  ]);
}

/** Write one ledger record and return it. */
export function addTicket(
  state: HotelState,
  kind: TicketKind,
  prefix: string,
  summary: string,
  details: Ticket["details"],
): Ticket {
  const ticket: Ticket = { code: mintCode(prefix, takenCodes(state)), kind, summary, details };
  state.tickets.push(ticket);
  note(state, `${kind}: ${summary}`);
  return ticket;
}

/**
 * How many times the caller has spoken — their `_count_caller_turns`.
 *
 * Typed `readonly Message[]` rather than the structural `{ role: string }[]` it
 * used to take: the argument is always `ctx.messages`, and naming the SDK's own
 * shape is what makes a spec's hand-built history fail HERE (a bad `role`, a
 * missing `content`) rather than compile against a stand-in this file invented.
 */
export function callerTurns(messages: readonly Message[]): number {
  return messages.filter((m) => m.role === "user").length;
}

// ─── Verification ────────────────────────────────────────────────────────────

export const VERIFY_HINT =
  "Verify the caller first with verify_booking: last name plus confirmation code, " +
  "or last name plus the last four digits of the card on file.";

/** The booking a code names, whatever its status. */
export function bookingByCode<S extends FrozenHotelState | HotelState>(
  state: S,
  code: string,
): S["bookings"][number] | undefined {
  const wanted = normalizeCode(code);
  return state.bookings.find((b) => normalizeCode(b.code) === wanted);
}

/**
 * The booking this call has verified against — or the refusal naming the tool.
 *
 * Their `_verified_booking` ran a `VerifyBookingTask` on demand from inside
 * every tool that needed one. A voice tool cannot open a sub-conversation, so
 * the check is a gate: the tool refuses with the sentence that says what to do,
 * and `verify_booking` is what fills the slot. Generic over the state so a
 * mutating tool gets a draft's booking back and a read gets the frozen one.
 *
 * It answers a {@link ToolFailure}, not a `{ error: string }` of its own. The
 * two are the same object, and that was the problem: eleven tools narrowed with
 * `"error" in booking` and then RE-WRAPPED the sentence with
 * `toolFailure(booking.error)`, building a second failure out of a perfectly
 * good one. A failure PROPAGATES — `if (isToolFailure(b)) return b;` — and the
 * SDK's guard is what makes the narrowing safe on a value that could be
 * anything.
 */
export function requireVerified<S extends FrozenHotelState | HotelState>(
  state: S,
): S["bookings"][number] | ToolFailure {
  if (state.verifiedCode === null) return toolFailure(`Not verified yet. ${VERIFY_HINT}`);
  const booking = bookingByCode(state, state.verifiedCode);
  if (booking === undefined) return toolFailure(`Not verified yet. ${VERIFY_HINT}`);
  return booking;
}

// ─── What the browser sees ───────────────────────────────────────────────────

export interface DeskView {
  verified: { name: string; code: string; room: string; stay: string; status: string } | null;
  draft: {
    mode: BookingDraft["mode"];
    stay: string | null;
    room: string | null;
    extras: string | null;
    guest: string | null;
    card: string | null;
    total: string | null;
  } | null;
  /** Newest first. */
  ledger: { code: string; kind: TicketKind; summary: string }[];
  inHouse: number;
  arrivingToday: number;
}

/** The receptionist's own screen: who is verified, what is being booked, what
 *  this call has written. No card number ever reaches the slot, so none can
 *  reach here. */
export function deskView(state: FrozenHotelState): DeskView {
  const verified =
    state.verifiedCode === null ? undefined : bookingByCode(state, state.verifiedCode);
  const d = state.draft;
  return {
    verified: verified
      ? {
          name: `${verified.firstName} ${verified.lastName}`,
          code: verified.code,
          room: verified.roomId,
          stay: `${spokenDate(verified.checkIn)} → ${spokenDate(verified.checkOut)}`,
          status: verified.status,
        }
      : null,
    draft: d
      ? {
          mode: d.mode,
          stay:
            d.checkIn && d.checkOut
              ? `${spokenDate(d.checkIn)} → ${spokenDate(d.checkOut)}, ${d.guests ?? "?"} guests`
              : null,
          room: d.roomType
            ? `${d.roomType.replaceAll("_", " ")}${d.view ? `, ${d.view} view` : ""}`
            : null,
          extras: d.extrasSet ? (d.extras.length > 0 ? d.extras.join(", ") : "none") : null,
          guest: d.firstName && d.lastName ? `${d.firstName} ${d.lastName}` : null,
          card: d.cardLast4 ? `•••• ${d.cardLast4}` : null,
          total: d.quotedTotal === null ? null : usd(d.quotedTotal),
        }
      : null,
    // `slice(-12)` before the reverse, not after: `tickets` carries no cap (only
    // `log` does), so copying the whole list to show twelve of it grew with the
    // call — and this runs on every tool call, being what `syncState` sends.
    ledger: state.tickets
      .slice(-LEDGER_ENTRIES)
      .reverse()
      .map((t) => ({ code: t.code, kind: t.kind, summary: t.summary })),
    ...bookingCounts(state),
  };
}

/** How many ledger entries the sidebar shows. */
const LEDGER_ENTRIES = 12;

/** The two headline counts, in one pass over the bookings rather than two. */
function bookingCounts(state: FrozenHotelState): { inHouse: number; arrivingToday: number } {
  let inHouse = 0;
  let arrivingToday = 0;
  for (const b of state.bookings) {
    if (b.status !== "confirmed") continue;
    if (b.checkIn <= TODAY && b.checkOut > TODAY) inHouse += 1;
    if (b.checkIn === TODAY) arrivingToday += 1;
  }
  return { inHouse, arrivingToday };
}
