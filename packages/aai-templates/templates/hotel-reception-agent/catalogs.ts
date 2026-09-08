/**
 * The concierge desk's four catalogs — tours, spa, business centre, florist —
 * and the one rule each carries about how it is priced.
 *
 * Their `hotel_db.py` declared these beside a comment on each: "policies/spa.md
 * describes the same catalog to the agent - keep the two in sync." Here the
 * policy TEXT is rendered from the catalog (`policies.ts`), so there is nothing
 * to keep in sync and a price changed here changes what the receptionist quotes.
 */

import { speakUsd, spokenTime } from "./records.ts";

export interface Tour {
  name: string;
  pickupTime: string;
  pickupLocation: string;
  /** Cents per person, or `null` for a flat-priced tour. */
  pricePerPerson: number | null;
  flatPrice: number | null;
  maxParty: number;
  description: string;
}

export const TOURS = {
  half_day_city: {
    name: "Half-day city highlights",
    pickupTime: "09:00",
    pickupLocation: "hotel lobby",
    pricePerPerson: 6500,
    flatPrice: null,
    maxParty: 12,
    description: "small group, English-speaking guide, about 4.5 hours, entry fees included",
  },
  full_day_city: {
    name: "Full-day city and bay",
    pickupTime: "08:30",
    pickupLocation: "hotel lobby",
    pricePerPerson: 11_000,
    flatPrice: null,
    maxParty: 12,
    description:
      "small group, English-speaking guide, lunch and entry fees included, back about 5 PM",
  },
  private_city: {
    name: "Private half-day tour",
    pickupTime: "10:00",
    pickupLocation: "hotel lobby",
    pricePerPerson: null,
    flatPrice: 29_000,
    maxParty: 4,
    description: "private car and English-speaking guide, flexible start, up to 4 guests",
  },
} as const satisfies Record<string, Tour>;

export interface SpaService {
  name: string;
  /** Cents, per guest. */
  price: number;
  durationMin: number;
  maxParty: number;
  description: string;
}

export const SPA_SERVICES = {
  deep_tissue_massage: {
    name: "Deep-tissue massage",
    price: 14_000,
    durationMin: 60,
    maxParty: 2,
    description: "60-minute deep-tissue massage with a licensed therapist",
  },
  signature_facial: {
    name: "Signature facial",
    price: 12_000,
    durationMin: 50,
    maxParty: 2,
    description: "50-minute signature facial, all skin types",
  },
  personal_training: {
    name: "Personal training session",
    price: 8000,
    durationMin: 45,
    maxParty: 1,
    description: "45-minute one-on-one session in the health club with a trainer",
  },
  group_yoga: {
    name: "Group yoga class",
    price: 4000,
    durationMin: 60,
    maxParty: 8,
    description: "60-minute group yoga class in the studio",
  },
} as const satisfies Record<string, SpaService>;

export interface BusinessCenterService {
  name: string;
  pricePerHour: number | null;
  flatPrice: number | null;
  maxHours: number;
  description: string;
}

export const BUSINESS_CENTER_SERVICES = {
  meeting_room: {
    name: "Meeting room",
    pricePerHour: 4000,
    flatPrice: null,
    maxHours: 8,
    description: "seats up to 8, screen and whiteboard, booked by the hour",
  },
  secretarial: {
    name: "Secretarial service",
    pricePerHour: 3500,
    flatPrice: null,
    maxHours: 4,
    description: "typing, dictation, and document prep, booked by the hour",
  },
  printing: {
    name: "Printing and binding",
    pricePerHour: null,
    flatPrice: 2500,
    maxHours: 1,
    description: "flat-rate print, copy, and bind job, ready same day",
  },
} as const satisfies Record<string, BusinessCenterService>;

export interface FloralArrangement {
  name: string;
  /** Cents, flat per arrangement. */
  price: number;
  description: string;
}

export const FLORIST_ARRANGEMENTS = {
  bouquet: {
    name: "Seasonal hand-tied bouquet",
    price: 6500,
    description: "florist's pick of the day's fresh seasonal stems",
  },
  roses: {
    name: "Dozen long-stem roses",
    price: 9500,
    description: "a dozen long-stem roses, classic and elegant",
  },
  centerpiece: {
    name: "Table centerpiece arrangement",
    price: 14_000,
    description: "a low table centerpiece for a room or event",
  },
} as const satisfies Record<string, FloralArrangement>;

/** The hotel car: flat to SFO, seats four with luggage, charged to the room. */
export const AIRPORT_CAR = { flatPrice: 8500, maxPassengers: 4, destination: "SFO" } as const;

// ─── The catalogs as policy prose ────────────────────────────────────────────
// Their `tours.md` / `spa.md` / `business_center.md` / `florist.md`, generated.

export function toursPolicy(): string {
  const lines = Object.values(TOURS).map((t) => {
    const price =
      t.flatPrice !== null
        ? `${speakUsd(t.flatPrice)} flat`
        : `${speakUsd(t.pricePerPerson ?? 0)} per person`;
    return `${t.name}: ${t.description}, ${spokenTime(t.pickupTime)} pickup at the ${t.pickupLocation}, up to ${t.maxParty} guests, ${price}.`;
  });
  return (
    "Three tours, all with English-speaking guides and lobby pickup (book_tour):\n" +
    `${lines.join("\n")}\n\n` +
    "Narrow before booking: group or private, half or full day, and the date and party size. " +
    "Quote the pickup time, pickup spot, and price from this list when confirming - they're fixed, " +
    'so the caller gets concrete details, not "the operator will tell you".'
  );
}

export function spaPolicy(): string {
  const lines = Object.values(SPA_SERVICES).map(
    (s) =>
      `${s.name}: ${s.description}, ${s.durationMin} minutes, ${speakUsd(s.price)} per person, ` +
      (s.maxParty === 1 ? "single guest only." : `up to ${s.maxParty} guests.`),
  );
  return (
    "Spa hours: 8:00 AM to 8:00 PM daily; last booking starts one hour before close. " +
    "The spa and health club are on the third floor.\n\n" +
    "Four services bookable through the desk (book_spa_appointment):\n" +
    `${lines.join("\n")}\n\n` +
    "Narrow before booking: which service, the date, the start time, and party size. " +
    "Quote the duration and price from this list when confirming - they're fixed."
  );
}

export function businessCenterPolicy(): string {
  const lines = Object.values(BUSINESS_CENTER_SERVICES).map((s) => {
    const price =
      s.flatPrice !== null
        ? `${speakUsd(s.flatPrice)} flat`
        : `up to ${s.maxHours} hours, ${speakUsd(s.pricePerHour ?? 0)} per hour`;
    return `${s.name}: ${s.description}, ${price}.`;
  });
  return (
    "The business centre is open 7:00 AM to 9:00 PM daily (book_business_center):\n" +
    `${lines.join("\n")}\n\n` +
    "Narrow before booking: which service, the date and start time, and how many hours " +
    "(printing is a flat one-hour job). Quote the rate and total from this list when confirming."
  );
}

export function floristPolicy(): string {
  const lines = Object.values(FLORIST_ARRANGEMENTS).map(
    (a) => `${a.name}: ${a.description}, ${speakUsd(a.price)}.`,
  );
  return (
    "Three arrangements, flat-priced, delivered by the in-house florist (order_flowers):\n" +
    `${lines.join("\n")}\n\n` +
    "Each order takes a delivery date, where it goes (a room number or a recipient's name), and a " +
    "gift-card message. Same-day delivery if the order is placed before the 2 PM cutoff; orders after " +
    "2 PM go out the next morning. The florist delivers daily between 10 AM and 6 PM. Read the " +
    "gift-card message back to the caller before placing the order so it's exactly right."
  );
}
