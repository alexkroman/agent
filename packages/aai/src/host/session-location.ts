// Copyright 2026 the AAI authors. MIT license.
/**
 * The location-aware BUILTINS' view of a session's location — `google_places`
 * and `open_meteo` default to "here" without the caller saying where here is.
 *
 * The location itself lives in `sdk/session-location.ts`, on a global slot a
 * custom tool in the agent bundle can read too (`sessionClientLocation`); what
 * this module adds is what only the builtins need: the coordinate cache, so a
 * geocode is paid once per location rather than once per call, and the town
 * extraction a place-name geocoder wants.
 *
 * The value is an address — treat it as PII: never log it.
 */

import {
  type SessionCoords,
  sessionClientLocation,
  sessionLocationEntry,
} from "../sdk/session-location.ts";

export type { SessionCoords } from "../sdk/session-location.ts";
export { setSessionLocation } from "../sdk/session-location.ts";

/** The session's effective location, if any — see `sessionClientLocation`. */
export function getSessionLocation(ctx: { sessionId: string }): string | undefined {
  return sessionClientLocation(ctx);
}

/**
 * The session location's coordinates, resolved once with `resolve` and
 * cached. `undefined` when the session has no location or it did not resolve.
 */
export async function sessionCoords(
  ctx: { sessionId: string },
  resolve: (location: string) => Promise<SessionCoords | undefined>,
): Promise<SessionCoords | undefined> {
  const entry = sessionLocationEntry(ctx.sessionId);
  if (!entry) return;
  if (entry.coords !== undefined) return entry.coords ?? undefined;
  const coords = await resolve(entry.location);
  // Re-read: the session may have reported a new location while this awaited.
  const now = sessionLocationEntry(ctx.sessionId);
  if (now?.location === entry.location) now.coords = coords ?? null;
  return coords;
}

/**
 * The town part of a street address, for a geocoder that matches place names
 * only: "123 Example St, Portland, OR 97201" → "Portland, OR". Drops a
 * leading street segment (one that starts with a house number) and postal
 * codes; an address with no commas is returned as it is.
 */
export function townOf(location: string): string {
  const parts = location.split(",").map((p) => p.trim());
  // The street goes first: a five-digit house number looks like a postcode.
  if (parts.length > 1 && /^\d/.test(parts[0] ?? "")) parts.shift();
  const town = parts.map((p) => p.replace(/\b\d{4,}(-\d+)?\b/g, "").trim()).filter(Boolean);
  return town.join(", ") || location;
}
