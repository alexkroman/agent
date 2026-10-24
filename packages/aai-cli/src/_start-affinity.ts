// Copyright 2026 the AAI authors. MIT license.
/**
 * Which `aai start --workers` worker a request belongs to.
 *
 * A browser's session, its `/inbox` socket and its `/api` calls must all reach
 * ONE worker: the session lives in that worker's memory, the inbox's event feed
 * is fed from the session's process, and an `/api` route's `ctx.speech` speaks
 * into a session it can only see locally. So requests are routed by the thing
 * they share, the way LiveKit routes by room:
 *
 * 1. the CLIENT (`?client=`), which `aai-ui` sends on `/websocket`, `/inbox`
 *    and every route call, and which outlives any one session;
 * 2. else the SESSION — `?sessionId=` on a resume, or the `sid` a session
 *    ticket carries (readable without the secret: the payload is base64url
 *    JSON, the HMAC only authenticates it — `session-ticket.ts` in the runtime);
 * 3. else nothing, and the router deals the request round-robin.
 *
 * A key maps to a slot by hash, so routing needs no table. A worker mints fresh
 * session ids that hash to ITS OWN slot ({@link mintIdForSlot}), which is what
 * makes rule 2 land a resume where the session is.
 *
 * @module
 */

import { randomUUID } from "node:crypto";

/** The `Sec-WebSocket-Protocol` entry a session ticket rides in (`session-protocol.ts` in the SDK). */
const TICKET_PROTOCOL_PREFIX = "aai.auth.";

/** The routing key for a client id — namespaced, so a client and a session never collide. */
export function clientKey(clientId: string): string {
  return `client:${clientId}`;
}

/** The routing key for a session id. */
export function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

/**
 * FNV-1a (32-bit) of `key`, avalanched with MurmurHash3's finalizer, reduced to
 * `slots`. Stable across processes and restarts. The finalizer matters: FNV's
 * low bits mix poorly, so ids that differ only at the end (`phone-1`,
 * `phone-2`, …) would fall into a regular pattern modulo a small worker count.
 */
export function slotOf(key: string, slots: number): number {
  let hash = 0x81_1c_9d_c5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85_eb_ca_6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2_b2_ae_35);
  hash ^= hash >>> 16;
  return (hash >>> 0) % slots;
}

/**
 * A fresh session id that routes to `slot` — rejection sampling over random
 * UUIDs, ~`slots` tries on average. Still a full random UUID, so it is exactly
 * as unguessable as the default.
 */
export function mintIdForSlot(
  slot: number,
  slots: number,
  uuid: () => string = randomUUID,
): string {
  for (;;) {
    const id = uuid();
    if (slotOf(sessionKey(id), slots) === slot) return id;
  }
}

/** The `sid` a session ticket carries, or `undefined` for anything that is not one. */
export function ticketSessionId(ticket: string): string | undefined {
  const body = ticket.split(".")[0];
  if (!body) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const sid = (payload as { sid?: unknown } | null)?.sid;
    return typeof sid === "string" && sid.length > 0 ? sid : undefined;
  } catch {
    return undefined;
  }
}

/** The ticket a request presents: the auth subprotocol first, then `?token=` (the runtime's order). */
function presentedTicket(
  url: URL,
  protocolHeader: string | string[] | undefined,
): string | undefined {
  const header = Array.isArray(protocolHeader) ? protocolHeader.join(",") : protocolHeader;
  for (const entry of header?.split(",") ?? []) {
    const protocol = entry.trim();
    if (protocol.startsWith(TICKET_PROTOCOL_PREFIX))
      return protocol.slice(TICKET_PROTOCOL_PREFIX.length);
  }
  return url.searchParams.get("token") ?? undefined;
}

/**
 * The routing key of one request, or `undefined` when nothing ties it to a
 * worker. See the module doc for the order.
 */
export function affinityKey(
  rawUrl: string | undefined,
  headers: { "sec-websocket-protocol"?: string | string[] | undefined },
): string | undefined {
  const url = new URL(rawUrl ?? "/", "http://route.invalid");
  const client = url.searchParams.get("client")?.trim();
  if (client) return clientKey(client);
  const ticket = presentedTicket(url, headers["sec-websocket-protocol"]);
  const ticketSid = ticket ? ticketSessionId(ticket) : undefined;
  if (ticketSid) return sessionKey(ticketSid);
  const sessionId = url.searchParams.get("sessionId")?.trim();
  return sessionId ? sessionKey(sessionId) : undefined;
}
