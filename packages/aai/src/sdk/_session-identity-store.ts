// Copyright 2026 the AAI authors. MIT license.
/**
 * The one store behind WHO a session is — its client id, the location and
 * phone number the client reported, and the phone call it arrived as. Each has
 * a public reader in its own module (`session-client.ts`, `session-location.ts`,
 * `session-phone.ts`, `session-call.ts`); the write side is here, once.
 *
 * ## One writer, and it normalizes
 *
 * {@link recordSessionIdentity} is the only write. It applies each field's rule
 * at the store rather than trusting the caller to have: a phone number is
 * stored in E.164 ({@link normalizeE164}) or not at all, a location by
 * {@link normalizeClientLocation}, a call frozen. So the socket, `sessionContext`,
 * an eval session and `createToolContext` cannot put different shapes into the
 * same slot. A caller that must REPORT a refused value (the upgrade warns, an
 * eval throws) still checks first; what it records is re-checked here.
 *
 * ## Global slots, not module-level maps
 *
 * The runtime records and a tool in the agent bundle reads, and those are two
 * copies of this module, so each map hangs off `globalThis` under a `Symbol.for`
 * key both copies agree on (registered in `_boundary.ts`). The keys are unchanged from
 * when each map lived in its own module — a bundle built against either layout
 * shares them. Each map is bounded by a TTL plus a hard cap, so an abandoned
 * process cannot grow it.
 *
 * Every value here is personal data or a credential-shaped id: never log one.
 *
 * @module _session-identity-store
 * @internal
 */

import { globalSlot, type SlotName } from "./_boundary.ts";
import type { SessionCall } from "./session-call.ts";

/** Longer than any session; this only reaps abandoned entries. */
const SESSION_IDENTITY_TTL_MS = 86_400_000;
/** Per map. */
const MAX_SESSION_IDENTITIES = 10_000;

/**
 * Longest location honored, from either writer. A street address fits in a
 * fraction of this; the bound exists because the value is kept per session and
 * one writer is a query parameter on a public endpoint.
 */
const MAX_LOCATION_CHARS = 200;

/** Longest raw `?phone=` looked at: formatting included, a real number is far shorter. */
const MAX_RAW_PHONE_CHARS = 64;

/** A `+`, then 8–15 digits, the first not 0 (no country code starts with 0). */
const E164_RE = /^\+[1-9]\d{7,14}$/;

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

type ClientEntry = { clientId: string; expiresAt: number };
type PhoneEntry = { phone: string; expiresAt: number };
type CallEntry = { call: SessionCall; expiresAt: number };

/**
 * A lazily created map in a global slot.
 *
 * @param key - The registered slot name. Never rename one: see the module doc.
 */
function mapSlot<E>(key: SlotName): () => Map<string, E> {
  const slot = globalSlot<Map<string, E>>(key);
  return () => {
    let map = slot.get();
    if (map === undefined) {
      map = new Map();
      slot.set(map);
    }
    return map;
  };
}

/** @internal */
export const sessionClientEntries = mapSlot<ClientEntry>("sessionClients");
/** @internal */
export const sessionLocationEntries = mapSlot<SessionLocationEntry>("sessionLocations");
/** @internal */
export const sessionPhoneEntries = mapSlot<PhoneEntry>("sessionPhones");
/** @internal */
export const sessionCallEntries = mapSlot<CallEntry>("sessionCalls");

/**
 * A per-session entry that has not outlived its TTL, reaping it if it has — the
 * read side every bounded session map shares.
 *
 * @internal
 */
export function liveSessionEntry<E extends { expiresAt: number }>(
  map: Map<string, E>,
  sessionId: string,
): E | undefined {
  const entry = map.get(sessionId);
  if (!entry) return;
  if (entry.expiresAt <= Date.now()) {
    map.delete(sessionId);
    return;
  }
  return entry;
}

/**
 * Write `entry` under `key` as the most recent, then evict the oldest while the
 * map holds more than `max` — the write side of every bounded map keyed in
 * insertion order.
 *
 * @internal
 */
export function writeSessionEntry<K, V>(map: Map<K, V>, key: K, entry: V, max: number): void {
  // Delete-then-set keeps insertion order = least-recently-written first.
  map.delete(key);
  map.set(key, entry);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * `raw` as an E.164 number (`+15035550123`), or `undefined` when it is not one.
 * Spaces, dashes, dots and parentheses are formatting and are stripped. A
 * number without its `+` is refused rather than guessed at: a bare ten digits
 * is not assumed to be North American.
 *
 * @internal
 */
export function normalizeE164(raw: string): string | undefined {
  if (raw.length > MAX_RAW_PHONE_CHARS) return;
  const phone = raw.replace(/[\s().-]/g, "");
  return E164_RE.test(phone) ? phone : undefined;
}

/**
 * `raw` as a location worth keeping, or `undefined`. Control characters become
 * spaces — the value is interpolated into third-party API requests — runs of
 * whitespace collapse, and an over-long one is DROPPED rather than truncated
 * into a different place.
 *
 * One rule for every writer, so an app's `sessionContext` cannot put into the
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
 * What a session's connection said about who it is. Every field is optional:
 * an absent one keeps what the session had (a resume that names no client
 * keeps the previous one).
 *
 * @internal
 */
export type SessionIdentity = {
  /** The device id (`?client=`). */
  clientId?: string | undefined;
  /** Where the client is — normalized; one the rule refuses is not recorded. */
  location?: string | undefined;
  /** The client's number — stored in E.164; one that is not is not recorded. */
  phone?: string | undefined;
  /** The carrier call — stored frozen, parameters too. */
  call?: SessionCall | undefined;
};

function recordLocation(sessionId: string, raw: string): void {
  const location = normalizeClientLocation(raw);
  if (location === undefined) return;
  const map = sessionLocationEntries();
  const prev = liveSessionEntry(map, sessionId);
  // The same location again keeps the cached coordinates; a different one drops them.
  const entry: SessionLocationEntry = {
    location,
    coords: prev?.location === location ? prev.coords : undefined,
    expiresAt: Date.now() + SESSION_IDENTITY_TTL_MS,
  };
  writeSessionEntry(map, sessionId, entry, MAX_SESSION_IDENTITIES);
}

/**
 * Record what a session's connection said about who it is, under `sessionId` —
 * the runtime's half, called where the session id is decided and before the
 * session is built (and by `sessionContext`'s `location`, after). See the
 * module doc for the normalization each field gets.
 *
 * @internal
 */
export function recordSessionIdentity(sessionId: string, identity: SessionIdentity): void {
  const expiresAt = Date.now() + SESSION_IDENTITY_TTL_MS;
  const { clientId, location, phone, call } = identity;
  if (clientId !== undefined) {
    writeSessionEntry(
      sessionClientEntries(),
      sessionId,
      { clientId, expiresAt },
      MAX_SESSION_IDENTITIES,
    );
  }
  if (location !== undefined) recordLocation(sessionId, location);
  const e164 = phone === undefined ? undefined : normalizeE164(phone);
  if (e164 !== undefined) {
    writeSessionEntry(
      sessionPhoneEntries(),
      sessionId,
      { phone: e164, expiresAt },
      MAX_SESSION_IDENTITIES,
    );
  }
  if (call !== undefined) {
    // Frozen, parameters too, so the object `sessionContext`, `onSessionEnd` and
    // every tool see is one value no reader can change under another.
    const frozen: SessionCall = Object.freeze({
      ...call,
      parameters: Object.freeze({ ...call.parameters }),
    });
    writeSessionEntry(
      sessionCallEntries(),
      sessionId,
      { call: frozen, expiresAt },
      MAX_SESSION_IDENTITIES,
    );
  }
}
