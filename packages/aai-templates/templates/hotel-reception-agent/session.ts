// Copyright 2026 the AAI authors. MIT license.
/**
 * The session's hotel: the seeded factory and the slot it fills.
 *
 * Kept apart from `shared.ts` so the browser never reaches `seed.ts`: a slot
 * holds its factory, so any module that imports `hotelSlot` imports the seed
 * with it, and `client.tsx` reads the slot by NAME with `emptyHotelState()`'s
 * view as its fallback. `empty` below is the same frame on the server side —
 * what the slot projects before a tool has run.
 */

import { sessionSlot } from "@alexkroman1/aai";
import { TODAY } from "./records.ts";
import { seedHotel } from "./seed.ts";
import { deskView, emptyHotelState, type HotelState } from "./shared.ts";

/** A pristine hotel per session, seeded around {@link TODAY}. */
export function createHotelState(): HotelState {
  return { ...emptyHotelState(), ...seedHotel(TODAY) };
}

/**
 * The session's hotel, as one typed slot. No `after` hook: nothing stored here
 * is derived from anything else stored here. The call log is the one
 * append-only list, and its bound is declared on the slot so it holds for
 * every path that writes it.
 */
export const hotelSlot = sessionSlot("hotel", createHotelState, {
  view: deskView,
  sync: true,
  empty: emptyHotelState,
  caps: { log: 40 },
});
