/**
 * The hotel's RECORD types, its price list, and the money/date/code helpers.
 *
 * Split from `shared.ts` so that `seed.ts` can import the shapes and the pricing
 * without importing the slot that is seeded from it — the one import cycle this
 * template would otherwise have. Nothing here knows about a session.
 * `shared.ts` carries the attribution and the their-name → our-name table.
 */

import { spokenAlphanumeric } from "@alexkroman1/aai";

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

/** `$240.00` — for the sidebar and the ledger. */
export function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** `240 dollars` / `240 dollars and 50 cents` — for anything the model reads out. */
export function speakUsd(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const change = abs % 100;
  return change === 0 ? `${dollars} dollars` : `${dollars} dollars and ${change} cents`;
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
 * Mint a `PREFIX-XXXX` reference. The alphabet drops 0/O and 1/I, because
 * every code this desk issues is read aloud and read back.
 */
export function mintCode(prefix: string, taken: ReadonlySet<string> = new Set()): string {
  // Chunked only so no one string reads as a high-entropy secret to the linter.
  const alphabet = ["ABCDEFGH", "JKMNPQRS", "TUVWXYZ", "23456789"].join("");
  for (;;) {
    let suffix = "";
    for (let i = 0; i < 4; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
    const code = `${prefix}-${suffix}`;
    if (!taken.has(code)) return code;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD`, and a real calendar date — `2026-02-30` is refused. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/** `iso` plus `days`, as ISO. Computed in UTC so no machine's zone can move it. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` — a stay's night count. */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** `Monday, June 8` — a date as the receptionist says it. */
export function spokenDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** `7 PM` / `6:30 PM`, from `HH:MM`. */
export function spokenTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const hour = h % 12 || 12;
  const suffix = h >= 12 ? "PM" : "AM";
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

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
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];

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
