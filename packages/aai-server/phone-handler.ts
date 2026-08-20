// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /:slug/phone` — the call-answering webhook.
 *
 * A carrier points a phone number here; this answers with the markup that
 * tells it to open a bidirectional media stream against the agent's sandbox.
 * From there the carrier talks to the guest's `/phone` endpoint directly and
 * the platform is out of the path, exactly as it is for browser sessions.
 *
 * **Why this route exists at all, rather than pointing the carrier at
 * `/:slug/websocket`.** That endpoint answers a plain upgrade with a 302 to
 * the live sandbox (see `orchestrator-ws.ts`), and carriers do not follow
 * WebSocket handshake redirects — the call would connect to nothing. TwiML is
 * an indirection the carrier *does* follow, so the redirect problem does not
 * need solving: the markup carries the resolved sandbox URL, and the sandbox
 * a call lands on is always the current one.
 *
 * **Cold start is answered with markup, not with a held request.** A carrier
 * times out a webhook in ~15 seconds, which is under a cold sandbox's boot
 * budget, so waiting for the boot inside the request is not available. A
 * still-booting agent gets a short `<Pause>` and a `<Redirect>` back here
 * instead — the boot continues server-side and the next attempt joins the
 * same readiness promise (see `BROKER_READY_TIMEOUT_MS`). A browser client
 * gets this for free by re-brokering; a phone call has no such loop, so the
 * loop is written into the response.
 *
 * The markup is TwiML, and Telnyx's TeXML accepts the same verbs — `Connect`,
 * `Stream`, `Pause`, `Redirect`, `Say`, `Hangup` — so one document shape
 * serves both carriers.
 */

import { HTTPException } from "hono/http-exception";
import type { AppContext } from "./context.ts";
import { GUEST_ROUTES, guestWsUrl } from "./guest-routes.ts";
import { createLogger } from "./logger.ts";
import { verifyPhoneWebhook } from "./phone-signature.ts";
import { resolvePublicOrigin } from "./public-origin.ts";
import { brokerSessionUrl } from "./sandbox-broker.ts";
import type { ResolveSandboxOpts } from "./sandbox-resolve.ts";
import type { BundleStore } from "./store-types.ts";

const log = createLogger("phone");

/** Carriers this route can emit a stream URL for — the SDK's codec names. */
const SUPPORTED_CARRIERS = new Set(["twilio", "telnyx"]);

/**
 * This route's own path under `/:slug`.
 *
 * Spelled separately from `GUEST_ROUTES.phone` despite being the same string:
 * one is the platform webhook a carrier POSTs to, the other is the guest
 * endpoint the carrier then dials, and only the second is part of the
 * host↔guest contract.
 */
export const PHONE_ROUTE = "/phone";

/**
 * Readiness budget for one attempt.
 *
 * Well under the ~15s a carrier allows a webhook, so a still-booting sandbox
 * produces a retry document rather than a timed-out request the carrier
 * reports as a failed call.
 */
export const PHONE_READY_TIMEOUT_MS = 8000;

/** Seconds of silence before a retry attempt. */
const RETRY_PAUSE_SECONDS = 2;

/**
 * How many times a call may bounce through the retry document.
 *
 * Six attempts at ~10s each (`PHONE_READY_TIMEOUT_MS` + the pause) is ~60s of
 * boot budget — comfortably more than a cold Modal sandbox needs, and bounded
 * so a permanently broken agent hangs up instead of looping until the caller
 * does.
 */
const MAX_ATTEMPTS = 6;

/** What a caller hears when the agent cannot be reached. */
const UNAVAILABLE_MESSAGE = "Sorry, this agent is not available right now. Please try again later.";
const NOT_FOUND_MESSAGE = "Sorry, that agent could not be found.";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function twiml(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`, {
    // `text/xml` rather than `application/xml`: it is what both carriers'
    // own examples return, and TeXML has been seen to be fussy about it.
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

/** Hand the carrier the sandbox's media-stream endpoint. */
function connectDocument(streamUrl: string): Response {
  return twiml(`<Connect><Stream url="${escapeXml(streamUrl)}" /></Connect>`);
}

/** Wait a beat and come back — the sandbox is still booting. */
function retryDocument(webhookUrl: string): Response {
  return twiml(
    `<Pause length="${RETRY_PAUSE_SECONDS}" />` +
      `<Redirect method="POST">${escapeXml(webhookUrl)}</Redirect>`,
  );
}

/** Say why, then hang up. */
function hangUpDocument(message: string): Response {
  return twiml(`<Say>${escapeXml(message)}</Say><Hangup />`);
}

/** Options the phone route needs beyond the broker's own. */
export type PhoneHandlerOptions = {
  /** Reads the agent's stored env, for the webhook-signing secret. */
  store: BundleStore;
};

/**
 * Build the `POST /:slug/phone` handler.
 *
 * @internal
 */
export function createPhoneHandler(
  opts: PhoneHandlerOptions,
): (c: AppContext, broker: ResolveSandboxOpts) => Promise<Response> {
  return async (c, broker) => {
    const slug = c.var.slug;
    const requested = c.req.query("carrier") ?? "twilio";
    if (!SUPPORTED_CARRIERS.has(requested)) {
      // A 400 rather than a spoken hang-up: this is a mistake in the phone
      // number's webhook URL, and it should surface in the carrier's own
      // debugger rather than as a call that answers and immediately ends.
      throw new HTTPException(400, { message: `Unsupported carrier: ${requested}` });
    }

    // Read the body ONCE, as text. Twilio signs the URL plus the parsed form
    // and Telnyx signs the raw bytes, so a re-serialization would break one
    // scheme or the other.
    const rawBody = c.req.method === "POST" ? await c.req.text() : "";
    const origin = resolvePublicOrigin(c.req.raw);
    const webhookPath = `/${slug}${PHONE_ROUTE}`;
    const verdict = verifyPhoneWebhook({
      carrier: requested,
      env: await opts.store.getEnv(slug),
      // The URL the carrier signed — the full request URL as it saw it,
      // which behind Modal's TLS termination is never `c.req.url`.
      url: `${origin}${c.req.path}${new URL(c.req.url).search}`,
      rawBody,
      headers: c.req.raw.headers,
    });
    if (!verdict.ok) {
      log.debug("Rejecting an unsigned phone webhook", { slug, carrier: requested, ...verdict });
      throw new HTTPException(403, { message: "Invalid webhook signature" });
    }

    const attempt = Number(c.req.query("attempt") ?? "0");
    const brokered = await brokerSessionUrl(slug, {
      ...broker,
      readyTimeoutMs: PHONE_READY_TIMEOUT_MS,
    });

    if (brokered.ok) {
      return connectDocument(
        `${guestWsUrl(brokered.guestOrigin, GUEST_ROUTES.phone)}?carrier=${requested}`,
      );
    }
    // An unknown slug will never become known by waiting.
    if (brokered.status === 404) return hangUpDocument(NOT_FOUND_MESSAGE);
    if (!(Number.isFinite(attempt) && attempt < MAX_ATTEMPTS - 1)) {
      log.debug("Giving up on a booting sandbox for a phone call", { slug, attempt });
      return hangUpDocument(UNAVAILABLE_MESSAGE);
    }
    const next = new URL(`${origin}${webhookPath}`);
    next.searchParams.set("carrier", requested);
    next.searchParams.set("attempt", String(Math.max(0, attempt) + 1));
    return retryDocument(next.toString());
  };
}
