// Copyright 2026 the AAI authors. MIT license.
/**
 * The session ticket one connection attempt presents — `VoiceSessionOptions.token`,
 * else the `sessionToken` a server's `client-config` issued.
 *
 * A browser cannot set headers on a WebSocket, so the ticket rides the
 * `Sec-WebSocket-Protocol` list as `aai.auth.<ticket>`, offered AFTER the plain
 * `aai.session` protocol: a browser fails any handshake whose response selects
 * none of its offers, and the server (`selectSessionProtocol` in
 * `@alexkroman1/aai-runtime/auth`) selects the plain one so the ticket is never
 * echoed back. A server older than tickets selects the first offer, which is
 * the plain one too, so offering a ticket never fails a handshake.
 *
 * A value that is not a valid subprotocol token (RFC 6455 §4.1 — an HTTP
 * token) would make `new WebSocket` throw, so it travels as `?token=` instead,
 * the server's fallback. A minted ticket is base64url with one dot, and so is a
 * JWT: neither takes that path.
 */

import { SESSION_AUTH_PROTOCOL_PREFIX, SESSION_PROTOCOL } from "@alexkroman1/aai/protocol";
import type { VoiceSessionOptions } from "./types.ts";

/** The shape of `VoiceSessionOptions.token`. */
export type SessionTokenOption = VoiceSessionOptions["token"];

/** What the getter is told about the attempt it serves: the session it resumes. */
export type SessionTokenAttempt = { readonly sessionId: string | undefined };

/** How one attempt carries its ticket: subprotocols, or the `?token=` fallback. */
export type TicketCarriage = {
  protocols?: string[];
  queryToken?: string;
};

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t === "" ? undefined : t;
}

/**
 * Ask the `token` option for THIS attempt's ticket. A getter that throws or
 * rejects yields none — the attempt still dials, and a server that requires a
 * ticket refuses it with a reason the session reports, rather than the attempt
 * failing before a socket exists (partysocket reports a provider failure as an
 * `error` with no `close`, which would leave the session on "connecting").
 */
export async function resolveSessionToken(
  option: SessionTokenOption,
  attempt: SessionTokenAttempt,
): Promise<string | undefined> {
  if (typeof option !== "function") return trimmed(option);
  try {
    return trimmed(await option(attempt));
  } catch (err) {
    console.warn("session-core: the `token` getter failed; dialing without a ticket", err);
    return undefined;
  }
}

/**
 * The same, for an injected `WebSocket` constructor: that path opens its socket
 * synchronously, so an asynchronous getter cannot be awaited there.
 */
export function resolveSessionTokenSync(
  option: SessionTokenOption,
  attempt: SessionTokenAttempt,
): string | undefined {
  if (typeof option !== "function") return trimmed(option);
  const value = option(attempt);
  if (typeof value !== "string" && value !== undefined) {
    throw new TypeError(
      "VoiceSessionOptions.token: an injected `WebSocket` opens synchronously, so its " +
        "`token` getter must return a string, not a Promise",
    );
  }
  return trimmed(value);
}

/** How `token` travels on one attempt; nothing at all when there is no ticket. */
export function ticketCarriage(token: string | undefined): TicketCarriage {
  if (token === undefined) return {};
  const protocol = `${SESSION_AUTH_PROTOCOL_PREFIX}${token}`;
  if (!HTTP_TOKEN.test(protocol)) return { queryToken: token };
  return { protocols: [SESSION_PROTOCOL, protocol] };
}
