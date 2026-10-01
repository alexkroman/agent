// Copyright 2026 the AAI authors. MIT license.
/**
 * The `/phone` front door: everything `createServerForRuntime` needs to answer a
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
import type { SessionCall } from "@alexkroman1/aai";
import { requestPath, requestQuery, TELEPHONY_CARRIERS } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import pTimeout from "p-timeout";
import type { WebSocketServer } from "ws";
import { consoleLogger, type Logger } from "../runtime-config.ts";
import type { SessionRuntime } from "../server/index.ts";
import { asSessionWebSocket, type SessionWebSocket } from "../session/index.ts";
import { type CarrierCodec, type CarrierName, carrierByName } from "./carriers.ts";
import { type CarrierStart, createTelephonyBridge } from "./telephony-bridge.ts";

/** Path `createServerForRuntime` serves carrier media streams on. */
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
export function enabledCarriers(
  access: boolean | readonly CarrierName[] | undefined,
): readonly CarrierName[] {
  if (access === undefined || access === false) return [];
  // The SDK's list rather than `Object.keys(CARRIER_CODECS)`: the two are the
  // same set by the `satisfies` in `carriers.ts`. A declaration is a list of
  // plain names (`CarrierName` is `string`), so this filter IS the validation.
  if (access === true) return TELEPHONY_CARRIERS;
  const asked = new Set<string>(access);
  return TELEPHONY_CARRIERS.filter((name) => asked.has(name));
}

/**
 * How long a carrier's stream may stay open without its `start` frame before
 * it is closed.
 *
 * Twilio sends `connected` and then `start` in the same breath as the upgrade,
 * and Telnyx sends `start` first; a live call's arrives in milliseconds. 5 s is
 * far past that and short enough that a socket which will never send one — a
 * stranger's, a proxy's health check — does not hold a session slot. A stream
 * with no `start` has no stream id to echo either, so it could never have been
 * heard: closing it loses nothing.
 */
export const TELEPHONY_START_TIMEOUT_MS = 5000;

/** Close code for a stream that never sent its `start` frame. */
const WS_CLOSE_POLICY_VIOLATION = 1008;

/** What the wait for `start` resolves to when the deadline passes first. */
const TIMED_OUT: unique symbol = Symbol("carrier start timed out");

/** The `call` a session is started with, from the carrier's `start` frame. */
function callOf(carrier: CarrierCodec, start: CarrierStart): SessionCall {
  return {
    carrier: carrier.name,
    parameters: start.parameters ?? {},
    ...omitUndefined({ callId: start.callId ?? undefined }),
  };
}

/**
 * Start a session over a carrier's media-stream socket, once the carrier has
 * said which call it is.
 *
 * **The session waits for the carrier's `start` frame**, bounded by
 * {@link TELEPHONY_START_TIMEOUT_MS}. The frame is where the call's identity is
 * — Twilio's `callSid` and `customParameters`, Telnyx's `call_control_id` — and
 * the app's `sessionContext` is asked inside `session.start()`, which begins
 * the moment `runtime.startSession` is called. Started on the upgrade, as this
 * used to be, the hook ran before the frame had arrived and could never see
 * the call it was deciding about. So the bridge is built first (it buffers what
 * it decodes until the runtime attaches, the `audio_ready` included), the
 * `start` is awaited, and only then is the session started with it as `call`.
 * A stream that closes first starts nothing; one that never sends `start` is
 * closed with a 1008.
 *
 * No other session option is set — the defaults are already the right ones for
 * a phone call, and the one that would be tempting to change is `audioLeadMs`,
 * which must stay PACED (see the module doc in `telephony-bridge.ts`).
 *
 * @public
 */
export function startTelephonySession(
  carrierSocket: SessionWebSocket,
  runtime: SessionRuntime,
  options: { carrier: CarrierCodec; logger?: Logger; startTimeoutMs?: number },
): void {
  const { carrier, startTimeoutMs = TELEPHONY_START_TIMEOUT_MS } = options;
  const log = options.logger ?? consoleLogger;
  const { promise: started, resolve: settle } = Promise.withResolvers<CarrierStart | null>();
  const bridge = createTelephonyBridge(carrierSocket, {
    carrier,
    logger: log,
    onStart: (start) => settle(start),
  });
  // A hang-up before `start` is the caller's to make; nothing is started for it.
  carrierSocket.addEventListener("close", () => settle(null));
  void pTimeout(started, {
    milliseconds: startTimeoutMs,
    fallback: (): typeof TIMED_OUT => TIMED_OUT,
  }).then((start) => {
    if (start === null) {
      log.info("telephony: carrier closed the stream before it started", {
        carrier: carrier.name,
      });
      return;
    }
    if (start === TIMED_OUT) {
      log.warn("telephony: no start frame from the carrier; closing the stream", {
        carrier: carrier.name,
        timeoutMs: startTimeoutMs,
      });
      try {
        carrierSocket.close?.(WS_CLOSE_POLICY_VIOLATION, "no start frame");
      } catch (err) {
        log.debug("telephony: close failed", { error: String(err) });
      }
      return;
    }
    runtime.startSession(bridge, {
      logContext: { transport: "phone", carrier: carrier.name },
      call: callOf(carrier, start),
    });
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
 * refusal is still this route's to answer. `createServerForRuntime` calls it before its
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
