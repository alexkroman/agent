// Copyright 2026 the AAI authors. MIT license.
/**
 * The session's hotel: the seeded factory, the slot it fills, and the
 * projection both ends read.
 *
 * **This module exists to keep `seed.ts` out of the browser bundle**, and it is
 * the same split `retail-orders-agent` makes for the same reason. A slot's
 * factory is a live reference held by the slot object, so nothing can shake it
 * out: any module that reaches `hotelSlot` reaches {@link createHotelState},
 * which reaches `seedHotel`, which is 18.5 KB of seeded bookings on top of
 * `records.ts`. While all three lived in `shared.ts` — the module `client.tsx`
 * imports for its view — every one of those bytes shipped to the page. Measured
 * before this split: all 43 of `seed.ts`'s guest phone numbers were present in
 * the built client bundle.
 *
 * So the rule this file enforces is a layering one: `shared.ts` holds the
 * SHAPES and the pure {@link deskView}, both halves import it freely, and it
 * reaches no seed. Everything that touches seeded data lives here, and the
 * browser never imports this module.
 */

import { sessionSlot } from "@alexkroman1/aai";
import { TODAY } from "./records.ts";
import { seedHotel } from "./seed.ts";
import { deskView, emptyHotelState, type HotelState } from "./shared.ts";

/**
 * A pristine hotel per session, seeded around {@link TODAY}.
 *
 * Built on top of `emptyHotelState()` so the SHAPE is declared once, in
 * `shared.ts`, where the browser's pre-first-call fallback can reach it without
 * reaching the seed.
 */
export function createHotelState(): HotelState {
  return { ...emptyHotelState(), ...seedHotel(TODAY) };
}

/**
 * The session's hotel, as one typed slot.
 *
 * No `after` hook: nothing stored here is derived from anything else stored
 * here. An invoice is written beside its booking by the one function that
 * prices a stay, and a refund decrements the invoice where the dispute is filed.
 * The call log is the one append-only list, and its bound is declared on the
 * slot so it holds whatever path writes it.
 */
export const hotelSlot = sessionSlot("hotel", createHotelState, { caps: { log: 40 } });

/**
 * The projection `syncState` pushes.
 *
 * `client.tsx` deliberately does NOT import this — see the note there. It
 * derives its own empty frame from `deskView` instead, because taking the
 * projection would take the slot, and the slot takes the seed.
 */
export const deskProjection = hotelSlot.projection(deskView);
