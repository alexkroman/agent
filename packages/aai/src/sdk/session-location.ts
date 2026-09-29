// Copyright 2026 the AAI authors. MIT license.
/**
 * WHERE a session's client is — the street address a smart speaker was set up
 * with — so "near me" and "the weather" mean the right place without the
 * caller saying where that is.
 *
 * Two writers, one slot, and the later one wins:
 *
 * 1. The socket's `?location=` (`ws-upgrade.ts`), recorded before the session
 *    exists — what the DEVICE says about itself.
 * 2. `sessionContext`'s `location` (`aai-runtime`'s `runtime-session-memory.ts`),
 *    recorded once the app's own hook has answered — what the APP knows about
 *    that client. It runs after the upgrade, so it overrides: the address a
 *    person typed into the app's settings is a better answer than whatever a
 *    device was flashed with.
 *
 * Read by the location-aware builtins (`google_places`, `open_meteo`, through
 * `host/session-location.ts`, which adds their coordinate cache) and by a
 * custom tool through {@link sessionClientLocation}.
 *
 * ## A global slot, not a module-level map
 *
 * It WAS a module-level map in `host/`, and that was correct only while the
 * builtins were its sole reader: they run on the host, beside the writer. A
 * custom tool runs from the agent bundle's own copy of this SDK, and a map in
 * one copy is invisible to the other — the same two-copy rendezvous
 * `session-client.ts` argues, solved the same way (a `Symbol.for` key on
 * `globalThis`), with a TTL plus a hard cap so an abandoned process cannot grow
 * it.
 *
 * The value is an address — personal data: never log it.
 *
 * @module
 */

import { liveSessionEntry } from "./session-client.ts";
import type { ToolContext } from "./tool-context.ts";

const SESSION_LOCATIONS_SLOT = Symbol.for("@alexkroman1/aai.sessionLocations");

/** Same bound as the other session maps: a session is far shorter, this only reaps abandoned ones. */
const SESSION_LOCATION_TTL_MS = 86_400_000;
const MAX_SESSION_LOCATIONS = 10_000;

/**
 * Longest location honored, from either writer. A street address fits in a
 * fraction of this; the bound exists because the value is kept per session and
 * one writer is a query parameter on a public endpoint.
 */
const MAX_LOCATION_CHARS = 200;

/**
 * Coordinates a builtin resolved for the location, cached on the entry.
 *
 * @internal
 */
export type SessionCoords = { latitude: number; longitude: number };

/** @internal */
export type SessionLocationEntry = {
  location: string;
  /** `null` once a lookup failed, so a bad address costs one request, not one per call. */
  coords?: SessionCoords | null | undefined;
  expiresAt: number;
};

type Slot = { [SESSION_LOCATIONS_SLOT]?: Map<string, SessionLocationEntry> };

function entries(): Map<string, SessionLocationEntry> {
  const slot = globalThis as Slot;
  slot[SESSION_LOCATIONS_SLOT] ??= new Map();
  return slot[SESSION_LOCATIONS_SLOT];
}

/**
 * `raw` as a location worth keeping, or `undefined`. Control characters become
 * spaces — the value is interpolated into third-party API requests — runs of
 * whitespace collapse, and an over-long one is DROPPED rather than truncated
 * into a different place.
 *
 * One rule for both writers, so an app's `sessionContext` cannot put into the
 * slot what the socket would have refused.
 *
 * @internal
 */
export function normalizeClientLocation(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return;
  const location = raw
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return location && location.length <= MAX_LOCATION_CHARS ? location : undefined;
}

/**
 * Record the location for `sessionId`. The same location again keeps the
 * cached coordinates; a different one drops them.
 *
 * @internal — the runtime's half, called by both writers in the module doc.
 */
export function setSessionLocation(sessionId: string, location: string): void {
  const map = entries();
  const prev = liveSessionEntry(map, sessionId);
  const entry: SessionLocationEntry = {
    location,
    coords: prev?.location === location ? prev.coords : undefined,
    expiresAt: Date.now() + SESSION_LOCATION_TTL_MS,
  };
  // Delete-then-set keeps insertion order = least-recently-written first.
  map.delete(sessionId);
  map.set(sessionId, entry);
  while (map.size > MAX_SESSION_LOCATIONS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * The live entry for `sessionId` — the object itself, so the builtins' coordinate
 * cache can write to it.
 *
 * @internal
 */
export function sessionLocationEntry(sessionId: string): SessionLocationEntry | undefined {
  return liveSessionEntry(entries(), sessionId);
}

/**
 * Where this session's client is — the location `sessionContext` answered for
 * it, else the one its socket reported (`?location=` on `WS /websocket`, the
 * `location` option of `createBrowserSession` and `mountClient`) — or
 * `undefined` when neither said.
 *
 * The same value `google_places` and `open_meteo` default to, so a custom tool
 * that searches "near me" agrees with them:
 *
 * ```ts
 * import { sessionClientLocation, tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export default tool({
 *   description: "Find the nearest open pharmacy.",
 *   inputSchema: z.object({}),
 *   async execute(_args, ctx) {
 *     const near = sessionClientLocation(ctx);
 *     if (!near) return { error: "I don't know where this speaker is." };
 *     const url = `${ctx.env.PHARMACY_API}/nearest?near=${encodeURIComponent(near)}`;
 *     const res = await fetch(url);
 *     return await res.json();
 *   },
 * });
 * ```
 *
 * **Trust model: it is whatever the client or the app CLAIMED.** Nothing
 * geolocates the caller. Personal data: do not log it.
 */
export function sessionClientLocation(ctx: Pick<ToolContext, "sessionId">): string | undefined {
  return sessionLocationEntry(ctx.sessionId)?.location;
}
