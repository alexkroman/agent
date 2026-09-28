// Copyright 2026 the AAI authors. MIT license.
/**
 * In-process store for the location a CLIENT reported for its session — a
 * smart speaker's configured street address, sent as `?location=` on the
 * WebSocket upgrade — so the location-aware builtins (`google_places`,
 * `open_meteo`) can default to "here" without the caller saying where here is.
 *
 * Shaped like `session-notes.ts` and for the same reasons: module-level and
 * keyed by sessionId, because builtins run on the host on both the
 * self-hosted and the platform path and `ctx.sessionId` is the one per-session
 * handle both give them (the platform path hands builtins a detached slot
 * store). TTL plus a hard cap, so an abandoned host process cannot grow it.
 *
 * The value is an address — treat it as PII: never log it.
 */

import { omitUndefined } from "../sdk/omit-undefined.ts";

/** Coordinates a builtin resolved for the location, cached per session. */
export type SessionCoords = { latitude: number; longitude: number };

type LocationEntry = {
  location: string;
  /** `null` once a lookup failed, so a bad address costs one request, not one per call. */
  coords?: SessionCoords | null;
  expiresAt: number;
};

const sessionLocations = new Map<string, LocationEntry>();

/** Same bound as session notes: a session is far shorter, this only reaps abandoned ones. */
export const SESSION_LOCATION_TTL_MS = 86_400_000;
const MAX_SESSION_LOCATION_ENTRIES = 10_000;

function liveEntry(sessionId: string): LocationEntry | undefined {
  const entry = sessionLocations.get(sessionId);
  if (!entry) return;
  if (entry.expiresAt <= Date.now()) {
    sessionLocations.delete(sessionId);
    return;
  }
  return entry;
}

/**
 * Record the location a client reported for `sessionId`. A resume that
 * reports the same location keeps the cached coordinates; a different one
 * drops them.
 */
export function setSessionLocation(sessionId: string, location: string): void {
  const prev = liveEntry(sessionId);
  const entry: LocationEntry = {
    location,
    ...omitUndefined({ coords: prev?.location === location ? prev.coords : undefined }),
    expiresAt: Date.now() + SESSION_LOCATION_TTL_MS,
  };
  // Delete-then-set keeps insertion order = least-recently-written first.
  sessionLocations.delete(sessionId);
  sessionLocations.set(sessionId, entry);
  while (sessionLocations.size > MAX_SESSION_LOCATION_ENTRIES) {
    const oldest = sessionLocations.keys().next().value;
    if (oldest === undefined) break;
    sessionLocations.delete(oldest);
  }
}

/** The location the session's client reported, if any. */
export function getSessionLocation(ctx: { sessionId: string }): string | undefined {
  return liveEntry(ctx.sessionId)?.location;
}

/**
 * The session location's coordinates, resolved once with `resolve` and
 * cached. `undefined` when the session has no location or it did not resolve.
 */
export async function sessionCoords(
  ctx: { sessionId: string },
  resolve: (location: string) => Promise<SessionCoords | undefined>,
): Promise<SessionCoords | undefined> {
  const entry = liveEntry(ctx.sessionId);
  if (!entry) return;
  if (entry.coords !== undefined) return entry.coords ?? undefined;
  const coords = await resolve(entry.location);
  // Re-read: the session may have reported a new location while this awaited.
  const now = liveEntry(ctx.sessionId);
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
