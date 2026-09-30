// Copyright 2026 the AAI authors. MIT license.
/**
 * Verifying a signed webhook delivery the way the Standard Webhooks spec
 * (https://www.standardwebhooks.com) signs it — the scheme Svix, Composio,
 * Resend, Clerk and others send: three headers, `webhook-id`,
 * `webhook-timestamp` and `webhook-signature`, the last a space-separated list
 * of `v1,<base64 HMAC-SHA256>` over `${id}.${timestamp}.${rawBody}`.
 *
 * Every route that received one had written the same forty lines, and the
 * parts that get dropped in a private copy are exactly the security ones: the
 * replay window, the constant-time compare, the several signatures a sender
 * attaches while it rotates a secret, and signing the RAW body rather than a
 * re-serialization of the parsed one.
 *
 * ## The secret
 *
 * A `whsec_`-prefixed secret is the spec's form: the rest is base64 and the
 * key is its DECODED bytes. Some senders (Composio among them) sign with the
 * secret's own UTF-8 bytes instead, whatever it looks like — so a `whsec_`
 * secret is checked both ways, and any other secret as its UTF-8 bytes. Both
 * keys come from the one secret the author configured; accepting either
 * widens nothing an attacker can reach.
 *
 * Web Crypto only (`crypto.subtle`), so it runs in the agent bundle, a browser
 * or a guest alike.
 *
 * @module
 */

import { type RouteHandler, type RouteRequest, routeResponse } from "./agent-routes.ts";

/** Oldest (and furthest-future) delivery accepted, in seconds: older is a replay. */
const DEFAULT_TOLERANCE_S = 300;

/** The spec's secret prefix. */
const WHSEC_PREFIX = "whsec_";

/**
 * What {@link verifyStandardWebhook} takes beside the request and secret.
 *
 * @public
 */
export interface StandardWebhookOptions {
  /**
   * How far `webhook-timestamp` may be from now, in seconds, before the
   * delivery is refused as a replay. Default 300 (five minutes), the spec's.
   */
  toleranceS?: number;
  /** For TESTS: "now", in seconds since the epoch. */
  nowS?: number;
}

function base64ToBytes(text: string): Uint8Array | undefined {
  try {
    const bin = atob(text);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Compare two strings without an early exit, so timing does not leak the prefix matched. */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}

async function sign(key: Uint8Array, payload: string): Promise<string> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(payload));
  return bytesToBase64(new Uint8Array(mac));
}

/** The keys one secret stands for — see the module doc. */
function keysOf(secret: string): Uint8Array[] {
  const raw = new TextEncoder().encode(secret);
  if (!secret.startsWith(WHSEC_PREFIX)) return [raw];
  const decoded = base64ToBytes(secret.slice(WHSEC_PREFIX.length));
  return decoded && decoded.length > 0 ? [decoded, raw] : [raw];
}

/**
 * Whether a route request is a genuine Standard Webhooks delivery signed with
 * `secret`: its `webhook-signature` carries a `v1` HMAC-SHA256 of
 * `${webhook-id}.${webhook-timestamp}.${rawBody}`, and the timestamp is within
 * `toleranceS` of now. Any of several space-separated signatures may match (a
 * secret rotation). Compared in constant time; never throws.
 *
 * `false` for a missing header, an empty secret, a request with no `rawBody`,
 * or a stale timestamp.
 *
 * @example
 * ```ts
 * import { routeResponse, type RouteHandler, verifyStandardWebhook } from "@alexkroman1/aai";
 *
 * export const onEvent: RouteHandler = async (req, { env }) => {
 *   if (!(await verifyStandardWebhook(req, env.WEBHOOK_SECRET ?? ""))) {
 *     return routeResponse(401, { error: "bad signature" });
 *   }
 *   return { ok: true };
 * };
 * ```
 *
 * @public
 */
export async function verifyStandardWebhook(
  req: Pick<RouteRequest, "headers" | "rawBody">,
  secret: string,
  options: StandardWebhookOptions = {},
): Promise<boolean> {
  const id = req.headers["webhook-id"];
  const timestamp = req.headers["webhook-timestamp"];
  const header = req.headers["webhook-signature"];
  if (!(id && timestamp && header && secret) || req.rawBody === undefined) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  const nowS = options.nowS ?? Date.now() / 1000;
  const tolerance = options.toleranceS ?? DEFAULT_TOLERANCE_S;
  if (Math.abs(nowS - Number(timestamp)) > tolerance) return false;
  const offered = header
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1,"))
    .map((part) => part.slice(3));
  if (offered.length === 0) return false;
  const payload = `${id}.${timestamp}.${req.rawBody}`;
  try {
    for (const key of keysOf(secret)) {
      const expected = await sign(key, payload);
      // Every offered signature is compared, not just until the first match.
      let match = false;
      for (const sig of offered) match = timingSafeEqual(sig, expected) || match;
      if (match) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * What {@link webhookRoute} takes.
 *
 * @public
 */
export interface WebhookRouteOptions {
  /** The agent-env variable holding the signing secret, e.g. `"COMPOSIO_WEBHOOK_SECRET"`. */
  secretEnv: string;
  /** As {@link StandardWebhookOptions.toleranceS}. */
  toleranceS?: number;
}

/**
 * A route handler that runs `handler` only for a delivery
 * {@link verifyStandardWebhook} accepts under the secret in `env[secretEnv]`.
 * A bad or missing signature answers `401 { error }`; an unset secret answers
 * `500` naming the variable, and the handler never runs.
 *
 * @example
 * ```ts
 * import { agent, webhookRoute } from "@alexkroman1/aai";
 *
 * export default agent({
 *   name: "Kitchen speaker",
 *   routes: {
 *     "POST /composio/webhook": webhookRoute({ secretEnv: "COMPOSIO_WEBHOOK_SECRET" }, (req) => {
 *       return { received: req.headers["webhook-id"] };
 *     }),
 *   },
 * });
 * ```
 *
 * @public
 */
export function webhookRoute(options: WebhookRouteOptions, handler: RouteHandler): RouteHandler {
  return async (req, ctx) => {
    const secret = ctx.env[options.secretEnv]?.trim();
    if (!secret) {
      return routeResponse(500, { error: `${options.secretEnv} is not set` });
    }
    const verified = await verifyStandardWebhook(
      req,
      secret,
      options.toleranceS === undefined ? {} : { toleranceS: options.toleranceS },
    );
    if (!verified) return routeResponse(401, { error: "Invalid webhook signature" });
    return await handler(req, ctx);
  };
}
