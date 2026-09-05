// Copyright 2026 the AAI authors. MIT license.
/**
 * The `/phone` front door: everything `createRuntimeServer` needs to answer a
 * carrier's media-stream upgrade, kept out of `server.ts` so the route costs
 * that file a handful of lines rather than a section.
 *
 * **Nothing here is mounted unless the agent asks for it**, which is the one
 * thing to know before reading the rest. `agent({ telephony: ["twilio"] })` is
 * the declaration; `RuntimeServerOptions.telephony` is the same statement from
 * an embedder that has no agent to read it off. Absent both, `/phone` refuses
 * every upgrade with a 404 naming the reason.
 *
 * It used to be on by DEFAULT for any voice agent, on the argument that it
 * widens nothing — it starts the same session, on the same agent, on the same
 * credentials, that `/websocket` already starts for anyone who can reach the
 * server. That is still true and is still not the question: this is the one
 * door a CARRIER dials, reached by a URL a phone number points at rather than
 * by the page a deployment hands a browser, and an agent with no phone number
 * had no way to know it was serving one. The allow-list makes the surface a
 * sentence in `agent.ts` instead of a line in the boot log.
 *
 * What the carrier's own webhook is authenticated with is a separate question
 * and belongs where the webhook lands — on the platform, see
 * `aai-server/phone-handler.ts`. A carrier does not sign the WebSocket
 * upgrade, so there is nothing for this end to verify.
 */

import type http from "node:http";
import type { Duplex } from "node:stream";
import type { TelephonyAccess } from "@alexkroman1/aai";
import { requestPath, requestQuery, TELEPHONY_CARRIERS } from "@alexkroman1/aai/internal";
import type { WebSocketServer } from "ws";
import type { Logger } from "../runtime-config.ts";
import type { SessionRuntime } from "../server.ts";
import { asSessionWebSocket, type SessionWebSocket } from "../ws-frames.ts";
import { type CarrierCodec, type CarrierName, carrierByName } from "./carriers.ts";
import { createTelephonyBridge } from "./telephony-bridge.ts";

/** Path `createRuntimeServer` serves carrier media streams on. */
export const TELEPHONY_PATH = "/phone";

/** Query parameter naming the carrier — see `carrierByName`. */
export const CARRIER_PARAM = "carrier";

/**
 * The carriers a declaration admits, in `TELEPHONY_CARRIERS` order.
 *
 * One resolution of the whole option, so the ROUTE and the boot line that
 * advertises it cannot disagree — `createAgentServer` prints what this returns
 * and `handleTelephonyUpgrade` admits exactly the same set. Empty means the
 * route is not served at all, which is what `false`, `[]` and an absent
 * declaration all say.
 *
 * A name the build ships no codec for is DROPPED rather than refused: the type
 * already rejects one in an `agent.ts`, and what reaches here at run time is a
 * stored config that may have been written by a newer SDK. Dropping it serves
 * the carriers this build understands; refusing the lot would take a working
 * Twilio number down over a Telnyx entry.
 *
 * @internal
 */
export function enabledCarriers(access: TelephonyAccess | undefined): readonly CarrierName[] {
  if (access === undefined || access === false) return [];
  // The SDK's list rather than `Object.keys(CARRIER_CODECS)`: the two are the
  // same set by the `satisfies` in `carriers.ts`, and this one is typed as the
  // names instead of as `string[]`, so the filter below needs no cast.
  if (access === true) return TELEPHONY_CARRIERS;
  const asked = new Set<string>(access);
  return TELEPHONY_CARRIERS.filter((name) => asked.has(name));
}

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
  options: { carrier: CarrierCodec; logger?: Logger },
): void {
  const bridge = createTelephonyBridge(carrierSocket, options);
  runtime.startSession(bridge, {
    logContext: { transport: "phone", carrier: options.carrier.name },
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
 * refusal is still this route's to answer. `createRuntimeServer` calls it before its
 * own `/websocket` routing.
 *
 * @internal
 */
export function handleTelephonyUpgrade(options: {
  req: http.IncomingMessage;
  socket: Duplex;
  head: Buffer;
  /** The server's own `WebSocketServer`, used to complete the handshake. */
  wss: WebSocketServer;
  runtime: SessionRuntime;
  logger: Logger;
  /** What the agent (or the embedder) declared — see {@link enabledCarriers}. */
  carriers: readonly CarrierName[];
}): boolean {
  const rawUrl = options.req.url;
  if (requestPath(rawUrl) !== TELEPHONY_PATH) return false;
  if (options.carriers.length === 0) {
    refuse(
      options.socket,
      "404 Not Found",
      options.logger,
      "this agent declares no telephony carriers — set `telephony` on the agent to serve one",
    );
    return true;
  }
  const requested = requestQuery(rawUrl).get(CARRIER_PARAM);
  const carrier = carrierByName(requested);
  if (carrier === null) {
    // Deliberately not a fallback to the default: serving one carrier's
    // framing to another produces a socket that connects and then exchanges
    // nothing in either direction, which is far harder to diagnose than a
    // refused upgrade naming the value.
    refuse(options.socket, "400 Bad Request", options.logger, `unknown carrier "${requested}"`);
    return true;
  }
  if (!options.carriers.some((name) => name === carrier.name)) {
    // 404 rather than 403: the agent does not serve this carrier's framing at
    // all, so there is no credential that would make the upgrade succeed and
    // nothing for the operator to fix at the carrier's end. Naming the carrier
    // is what turns it into a fixable line in `agent.ts` — an absent
    // `?carrier=` resolves to Twilio, so a Telnyx-only agent dialled by
    // hand-written TeXML lands here rather than on a socket that says nothing.
    refuse(
      options.socket,
      "404 Not Found",
      options.logger,
      `carrier "${carrier.name}" is not in this agent's \`telephony\` declaration`,
    );
    return true;
  }
  options.wss.handleUpgrade(options.req, options.socket, options.head, (ws) => {
    startTelephonySession(asSessionWebSocket(ws), options.runtime, {
      carrier,
      logger: options.logger,
    });
  });
  return true;
}
