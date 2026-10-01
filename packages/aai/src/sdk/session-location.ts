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
 * 2. `sessionContext`'s `location` (`aai-runtime`'s `aai-runtime/src/runtime/session-memory.ts`),
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
 * it. The map, the normalizing rule and the one writer are
 * `_session-identity-store.ts`.
 *
 * The value is an address — personal data: never log it.
 *
 * @module
 */

import {
  liveSessionEntry,
  recordSessionIdentity,
  type SessionLocationEntry,
  sessionLocationEntries,
} from "./_session-identity-store.ts";
import type { ToolContext } from "./tool-context.ts";

export {
  normalizeClientLocation,
  type SessionCoords,
  type SessionLocationEntry,
} from "./_session-identity-store.ts";

/**
 * Record the location for `sessionId`, normalized (`normalizeClientLocation`;
 * one the rule refuses is not recorded). The same location again keeps the
 * cached coordinates; a different one drops them.
 *
 * @internal — the runtime's half; `recordSessionIdentity` records every field at once.
 */
export function setSessionLocation(sessionId: string, location: string): void {
  recordSessionIdentity(sessionId, { location });
}

/**
 * The live entry for `sessionId` — the object itself, so the builtins' coordinate
 * cache can write to it.
 *
 * @internal
 */
export function sessionLocationEntry(sessionId: string): SessionLocationEntry | undefined {
  return liveSessionEntry(sessionLocationEntries(), sessionId);
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
