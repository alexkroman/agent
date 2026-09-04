// Copyright 2026 the AAI authors. MIT license.
/**
 * The `/phone` front door: everything `createServer` needs to answer a
 * carrier's media-stream upgrade, kept out of `server.ts` so the route costs
 * that file a handful of lines rather than a section.
 *
 * **Exposure is identical to `/websocket`, which is why this is on by
 * default.** `createServer`'s other two defaults are fail-closed (loopback
 * bind, opt-in host mode) because each WIDENS what an unauthenticated caller
 * can do — expose the whole server, or supply the agent definition. This
 * route widens nothing: it starts the same session, on the same agent, on the
 * same credentials, that `/websocket` already starts for anyone who can reach
 * the server. Turning it off (`telephony: false`) is available for an
 * operator who wants the surface gone, not because leaving it on is a
 * different security posture from the endpoint beside it.
 *
 * What the carrier's own webhook is authenticated with is a separate question
 * and belongs where the webhook lands — on the platform, see
 * `aai-server/phone-handler.ts`. A carrier does not sign the WebSocket
 * upgrade, so there is nothing for this end to verify.
 */

import type http from "node:http";
import type { Duplex } from "node:stream";
import { requestPath, requestQuery } from "@alexkroman1/aai/host-internal";
import type { WebSocketServer } from "ws";
import type { Logger } from "../runtime-config.ts";
import type { SessionRuntime } from "../server.ts";
import { asSessionWebSocket, type SessionWebSocket } from "../ws-frames.ts";
import { type CarrierCodec, carrierByName } from "./carriers.ts";
import { createTelephonyBridge } from "./telephony-bridge.ts";

/** Path `createServer` serves carrier media streams on. */
export const TELEPHONY_PATH = "/phone";

/** Query parameter naming the carrier — see `carrierByName`. */
export const CARRIER_PARAM = "carrier";

/**
 * Start a session over a carrier's media-stream socket.
 *
 * The whole of the telephony integration at the session layer: wrap the
 * socket, hand it to the runtime, done. No session option is set — the
 * defaults are already the right ones for a phone call, and the one that
 * would be tempting to change is `audioLeadMs`, which must stay PACED (see
 * the module doc in `telephony-bridge.ts`).
 *
 * @public
 */
export function startTelephonySession(
  carrierSocket: SessionWebSocket,
  runtime: SessionRuntime,
  opts: { carrier: CarrierCodec; logger?: Logger },
): void {
  const bridge = createTelephonyBridge(carrierSocket, opts);
  runtime.startSession(bridge, {
    logContext: { transport: "phone", carrier: opts.carrier.name },
  });
}

/**
 * Refuse a `/phone` upgrade with a real HTTP status.
 *
 * A bare `socket.destroy()` — what this server does for every other unmatched
 * upgrade — reaches a carrier as a connection that failed for no stated
 * reason, and the operator sees it as a dead call in a dashboard we do not
 * control. A status line costs nothing and shows up in Twilio's debugger
 * verbatim.
 */
function refuse(socket: Duplex, status: string, log: Logger, reason: string): void {
  log.warn(`telephony: refusing /phone upgrade — ${reason}`);
  try {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  } catch {
    socket.destroy();
  }
}

/**
 * Claim a `/phone` upgrade, or refuse it.
 *
 * Returns true when the path was `/phone` — claimed either way, since a
 * refusal is still this route's to answer. `createServer` calls it before its
 * own `/websocket` routing.
 *
 * @internal
 */
export function handleTelephonyUpgrade(opts: {
  req: http.IncomingMessage;
  socket: Duplex;
  head: Buffer;
  /** The server's own `WebSocketServer`, used to complete the handshake. */
  wss: WebSocketServer;
  runtime: SessionRuntime;
  logger: Logger;
  enabled: boolean;
}): boolean {
  const rawUrl = opts.req.url;
  if (requestPath(rawUrl) !== TELEPHONY_PATH) return false;
  if (!opts.enabled) {
    refuse(opts.socket, "404 Not Found", opts.logger, "telephony is disabled on this server");
    return true;
  }
  const requested = requestQuery(rawUrl).get(CARRIER_PARAM);
  const carrier = carrierByName(requested);
  if (carrier === null) {
    // Deliberately not a fallback to the default: serving one carrier's
    // framing to another produces a socket that connects and then exchanges
    // nothing in either direction, which is far harder to diagnose than a
    // refused upgrade naming the value.
    refuse(opts.socket, "400 Bad Request", opts.logger, `unknown carrier "${requested}"`);
    return true;
  }
  opts.wss.handleUpgrade(opts.req, opts.socket, opts.head, (ws) => {
    startTelephonySession(asSessionWebSocket(ws), opts.runtime, { carrier, logger: opts.logger });
  });
  return true;
}
