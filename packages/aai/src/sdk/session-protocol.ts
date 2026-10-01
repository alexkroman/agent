// Copyright 2026 the AAI authors. MIT license.
/**
 * The `Sec-WebSocket-Protocol` values a session upgrade offers — the two ends
 * of `WS /websocket` read them from here so the browser client
 * (`@alexkroman1/aai-ui`) and the server's ticket check
 * (`@alexkroman1/aai-runtime/auth`) cannot spell them differently.
 *
 * A browser cannot set headers on a WebSocket, so a session ticket rides the
 * subprotocol list as `aai.auth.<ticket>`, out of the URL and so out of access
 * logs. A browser that OFFERS protocols fails the handshake unless the server
 * SELECTS one of them, and selecting the ticket would echo it back in the
 * response — so a client offers {@link SESSION_PROTOCOL} first, and the server
 * selects that.
 *
 * Zod-free and Node-free: a leaf the browser bundle can import by value.
 */

/**
 * The plain session subprotocol a client offers beside its ticket, and the one
 * a server selects. A server older than tickets picks the first offer, which is
 * this, so offering a ticket never fails a handshake against one.
 */
export const SESSION_PROTOCOL = "aai.session";

/** `Sec-WebSocket-Protocol` entry prefix a session ticket travels under. */
export const SESSION_AUTH_PROTOCOL_PREFIX = "aai.auth.";
