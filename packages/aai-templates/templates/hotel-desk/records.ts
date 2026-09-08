/**
 * The hotel's RECORD types, its price list, and the money/date/code helpers.
 *
 * Split from `shared.ts` so that `seed.ts` can import the shapes and the pricing
 * without importing the slot that is seeded from it — the one import cycle this
 * template would otherwise have. Nothing here knows about a session.
 * `shared.ts` carries the attribution and the their-name → our-name table.
 */

import {
  addDays as addIsoDays,
  daysBetween as daysBetweenIso,
  mintCode as mintSpokenCode,
  spokenAlphanumeric,
  spokenTime as spokenClockTime,
  spokenDate as spokenIsoDate,
  spokenMoney,
} from "@alexkroman1/aai";
import { formatMoney } from "@alexkroman1/aai/utils";

// ─── Money, dates, codes ─────────────────────────────────────────────────────

/** Their `Pricing` dataclass, in cents. */
export const PRICING = {
  breakfastPerNight: 2500,
  valetPerNight: 3500,
  lateCheckout: 4000,
  petFee: 5000,
  smokingCleaningFee: 25_000,
  taxRatePct: 12,
  cancellationWindowHours: 48,
  minibarAutoRefundThreshold: 2000,
} as const;

/** The largest party a normal restaurant table seats — and a room's max party. */
export const MAX_PARTY_SIZE = 6;

/** Their `HOTEL_TODAY` simulation pin: Monday, June 8, 2026. */
export const TODAY = "2026-06-08";

/** The partner property a walked guest is sent to. */
export const WALK_PARTNER_HOTEL = "the Harbor House";

/**
 * `$240.00` — for the sidebar and the ledger.
 *
 * The formatting is `formatMoney`'s; what is local is that this desk counts in
 * CENTS. The hand-rolled version here was `formatMoney` minus thousands
 * grouping, so a multi-night bill printed `$1240.00` where every other template
 * prints `$1,240.00`.
 */
export function usd(cents: number): string {
  return formatMoney(cents / 100);
}

/**
 * `240 dollars` / `240 dollars and 50 cents` — for anything the model reads out.
 *
 * `spokenMoney`'s, over the same cents-to-dollars division {@link usd} makes, so
 * the sidebar and the spoken total round identically. The hand-rolled version
 * here said "1 dollars" for a one-dollar minibar item and dropped the sign on a
 * refund.
 */
export function speakUsd(cents: number): string {
  return spokenMoney(cents / 100);
}

/**
 * A confirmation code as it is read down a phone: character by character,
 * with the dash spoken as the word "dash" — NOT spelled D, A, S, H, which
 * reads as four more code characters.
 */
export function speakCode(code: string): string {
  return [...code.toUpperCase()].map((c) => (c === "-" ? "dash" : c)).join(", ");
}

/**
 * A code as the desk compares them: case and punctuation are transcription
 * noise, and so is the word "dash" — a caller reads `HTL-AB12` as "H T L dash
 * A B one two", and a model relaying it faithfully passes the word along.
 */
export function normalizeCode(code: string): string {
  return spokenAlphanumeric(code.replaceAll(/\bdash\b/gi, ""));
}

/**
 * Mint a `PREFIX-XXXX` reference for this desk.
 *
 * `mintCode`'s, which owns the alphabet — 0/O, 1/I and L are absent because
 * every code this desk issues is read down a phone and read back, and those are
 * the characters that come back wrong — and which bounds its retries, where the
 * loop here was `for (;;)`.
 *
 * It takes no `random`: the four minting sites are reached through
 * {@link addTicket} and the two booking builders, none of which carries a
 * `ToolContext`, so threading `ctx.random` down to here would change fourteen
 * signatures to make one code assertable. A desk that wants that passes
 * `{ random }` to `mintCode` directly.
 */
export function mintCode(prefix: string, taken: ReadonlySet<string> = new Set()): string {
  return mintSpokenCode(prefix, { taken });
}

/**
 * The date and time fields ten tools used to declare by hand.
 *
 * Both are the SDK's, re-exported under this desk's names so the call sites
 * read as they did. What they replaced is worth remembering: the pairing of
 * `z.string().describe("YYYY-MM-DD")` with an `if (!isIsoDate(...)) return
 * toolFailure(...)` in the body — one rule declared twice, drifted across four
 * sentences, and learned by the model only through being refused. Six tools
 * were still on the raw form, and five hand-rolled the `HH:MM` check in three
 * wordings and two different failure shapes.
 */
export { clockTime, isIsoDate, isoDate } from "@alexkroman1/aai";

/** `iso` plus `days`, as ISO — the SDK's, computed in UTC. */
export const addDays = addIsoDays;

/** Whole days from `from` to `to` — a stay's night count. */
export const daysBetween = daysBetweenIso;

/**
 * `Monday, June 8` — a date as the receptionist says it.
 *
 * `spokenDate`'s. The version here called `toLocaleDateString("en-US", …)`,
 * which answers to the host's ICU build: correct on a laptop, and free to read
 * differently inside a sandbox with no spec able to see it.
 */
export const spokenDate = spokenIsoDate;

/** `7 PM` / `6:30 PM`, from `HH:MM`. */
export const spokenTime = spokenClockTime;

/** Digits only: a spoken number transcribes with unpredictable punctuation. */
export function digitsOf(value: string): string {
  return value.replaceAll(/\D/g, "");
}

// ─── The hotel's records ─────────────────────────────────────────────────────

export const ROOM_TYPES = ["king", "queen_2beds", "suite", "penthouse"] as const;
export type RoomType = (typeof ROOM_TYPES)[number];
export const ROOM_VIEWS = ["city", "ocean", "garden", "interior"] as const;
export type RoomView = (typeof ROOM_VIEWS)[number];
export const ROOM_EXTRAS = ["breakfast", "valet", "late_checkout", "pets"] as const;
export type RoomExtra = (typeof ROOM_EXTRAS)[number];

export interface Room {
  /** The human room number, e.g. `"201"` (floor 2, room 01) or `"PH"`. */
  id: string;
  type: RoomType;
  nightlyRate: number;
  maxOccupancy: number;
  smoking: boolean;
  petsAllowed: boolean;
  view: RoomView;
}

export interface RoomBooking {
  code: string;
  roomId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  extras: RoomExtra[];
  /** With tax — what the card was charged. */
  total: number;
  cardLast4: string;
  status: "confirmed" | "cancelled";
  lateArrivalNote: string | null;
}

export interface RestaurantTable {
  id: number;
  label: string;
  capacity: number;
  location: "indoor" | "terrace" | "bar";
  description: string;
}

export interface Reservation {
  code: string;
  tableId: number;
  firstName: string;
  lastName: string;
  phone: string;
  partySize: number;
  date: string;
  /** `HH:MM`, one of {@link DINNER_SLOTS}. */
  time: string;
  notes: string | null;
  status: "confirmed" | "cancelled";
}

/** The restaurant seats every half hour from 5:30 to the 9 PM last seating. */
export const DINNER_SLOTS = [
  "17:30",
  "18:00",
  "18:30",
  "19:00",
  "19:30",
  "20:00",
  "20:30",
  "21:00",
] as const;

export interface LineItem {
  label: string;
  amount: number;
}

export interface Invoice {
  bookingCode: string;
  lineItems: LineItem[];
  subtotal: number;
  taxes: number;
  total: number;
  paid: boolean;
}

export const DISPUTE_CATEGORIES = [
  "minibar",
  "room_service_restaurant",
  "damage_cleaning",
  "late_checkout_fee",
  "cancellation_fee",
  "no_show",
  "double_charge_billing_error",
  "other",
] as const;
export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];

export type DisputeOutcome =
  | "auto_refunded"
  | "credit_offered"
  | "explained_no_action"
  | "goodwill_waived"
  | "escalated_to_manager"
  | "accounting_ticket_opened"
  | "open";

export interface Dispute {
  caseNumber: string;
  bookingCode: string;
  lineItem: string;
  amount: number;
  category: DisputeCategory;
  callerNote: string;
  outcome: DisputeOutcome;
  refundAmount: number;
  status: "open" | "resolved" | "rejected";
}

export const FOLLOWUP_KINDS = [
  "housekeeping",
  "sales_lead",
  "identity_change",
  "callback",
  "verification_help",
  "early_checkout",
  "abandoned_booking",
  "lost_and_found",
  "other",
] as const;

export const TRANSFER_DESTINATIONS = ["restaurant", "duty_manager", "housekeeping"] as const;
export type TransferDestination = (typeof TRANSFER_DESTINATIONS)[number];

export const EMERGENCY_KINDS = ["medical", "fire", "security"] as const;
export type EmergencyKind = (typeof EMERGENCY_KINDS)[number];

/**
 * The fifteen write-only tables of their schema, as one shape.
 *
 * A followup, a wake-up call, a walk, a guest message, a florist order — each
 * was its own table with its own columns, and nothing ever read one back except
 * the grader and the playground. One record type with a `kind` and a bag of
 * details keeps the ledger renderable by one component, and keeps a new kind a
 * one-line addition rather than a schema change.
 */
export type TicketKind =
  | "followup"
  | "wakeup_call"
  | "do_not_disturb"
  | "waitlist"
  | "tour"
  | "spa"
  | "business_center"
  | "flowers"
  | "email"
  | "transfer"
  | "flight_reconfirmation"
  | "airport_car"
  | "emergency"
  | "guest_message"
  | "group_inquiry"
  | "walk";

export interface Ticket {
  code: string;
  kind: TicketKind;
  /** One line for the ledger. */
  summary: string;
  details: Record<string, string | number | boolean | null>;
}

export interface GuestHistory {
  lastName: string;
  preferences: string;
}

// ─── Pricing ─────────────────────────────────────────────────────────────────
// Their `extras_total` / `apply_tax` / `compute_invoice`: the one place a stay
// is priced, shared by the booking flow, the modification, and the seed, so no
// caller can drift.

/** What the chosen extras add to a stay of `nights` nights, in cents. */
export function extrasTotal(extras: readonly string[], nights: number): number {
  let total = 0;
  if (extras.includes("breakfast")) total += PRICING.breakfastPerNight * nights;
  if (extras.includes("valet")) total += PRICING.valetPerNight * nights;
  if (extras.includes("late_checkout")) total += PRICING.lateCheckout;
  if (extras.includes("pets")) total += PRICING.petFee;
  return total;
}

export function applyTax(cents: number): number {
  return Math.floor((cents * PRICING.taxRatePct) / 100);
}

export interface PricedStay {
  subtotal: number;
  taxes: number;
  total: number;
  lineItems: LineItem[];
}

/** The itemized invoice for a stay — the single source of truth for booking math. */
export function computeInvoice(
  nightlyRate: number,
  nights: number,
  extras: readonly string[],
): PricedStay {
  const roomSubtotal = nightlyRate * nights;
  const subtotal = roomSubtotal + extrasTotal(extras, nights);
  const taxes = applyTax(subtotal);
  const lineItems: LineItem[] = [{ label: `Room (${nights} nights)`, amount: roomSubtotal }];
  if (extras.includes("breakfast")) {
    lineItems.push({
      label: `Breakfast (${nights} nights)`,
      amount: PRICING.breakfastPerNight * nights,
    });
  }
  if (extras.includes("valet")) {
    lineItems.push({ label: `Valet (${nights} nights)`, amount: PRICING.valetPerNight * nights });
  }
  if (extras.includes("late_checkout"))
    lineItems.push({ label: "Late checkout", amount: PRICING.lateCheckout });
  if (extras.includes("pets")) lineItems.push({ label: "Pet fee", amount: PRICING.petFee });
  lineItems.push({ label: `Tax (${PRICING.taxRatePct}%)`, amount: taxes });
  return { subtotal, taxes, total: subtotal + taxes, lineItems };
}

/**
 * Each extra and what it adds to a stay of this length — priced through
 * {@link extrasTotal} so there is no second price table, and for the actual
 * nights, since breakfast and valet are per night while the other two are flat.
 */
export function describeExtras(nights: number): string {
  return ROOM_EXTRAS.map(
    (extra) => `- ${extra.replaceAll("_", " ")}: adds ${speakUsd(extrasTotal([extra], nights))}`,
  ).join("\n");
}
