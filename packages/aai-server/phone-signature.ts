// Copyright 2026 the AAI authors. MIT license.
/**
 * Webhook authenticity for `POST /:slug/phone`.
 *
 * The TwiML route is the one place in the telephony path where a signature
 * exists to check. A carrier does not sign the WebSocket upgrade that follows,
 * so the guest's `/phone` endpoint has nothing to verify — this is it.
 *
 * **Verification is enabled by the presence of the agent's own secret**, not
 * by a flag. An agent whose stored env holds `TWILIO_AUTH_TOKEN` (or
 * `TELNYX_PUBLIC_KEY`) gets every request checked and unsigned ones refused;
 * an agent that has set neither is left exactly as open as `/websocket` and
 * `/client-config` beside it, which is the posture every public agent route
 * already has. That is a deliberate choice between two defaults, and the
 * alternative is worse: refusing unsigned requests unconditionally would mean
 * a phone number that returns 403 until the operator finds a doc page, while
 * demanding the secret up front would put a credential in the way of trying
 * the feature at all.
 *
 * What the secret buys when it is set is real: without it, anyone who learns
 * a slug can drive sandbox boots and provider spend by POSTing to the
 * webhook. With it, only the carrier can.
 */

import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";

/** Secret names read from the agent's stored env, by carrier. */
export const TWILIO_AUTH_TOKEN_SECRET = "TWILIO_AUTH_TOKEN";
export const TELNYX_PUBLIC_KEY_SECRET = "TELNYX_PUBLIC_KEY";

/**
 * How far a Telnyx timestamp may be from now. Telnyx signs
 * `timestamp|body`, so without a freshness bound a captured request stays
 * valid forever — the signature is over a payload that never expires.
 */
const TELNYX_MAX_SKEW_SECONDS = 5 * 60;

export type WebhookVerdict =
  /** Signed and valid, or unverifiable because the agent set no secret. */
  | { ok: true }
  /** A secret is configured and the request did not satisfy it. */
  | { ok: false; reason: string };

/** Constant-time compare of two strings that may differ in length. */
function equals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf-8");
  const right = Buffer.from(b, "utf-8");
  // `timingSafeEqual` throws on a length mismatch, which would itself leak
  // length — compare a fixed-size digest of each instead.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Twilio's scheme: HMAC-SHA1 over the request URL with every POST parameter,
 * sorted by name, appended as `name + value`.
 *
 * The URL must be the one TWILIO built the request from, which behind a
 * TLS-terminating proxy is never the one the container sees — hence the
 * caller passing a `resolvePublicOrigin`-derived URL rather than
 * `c.req.url`.
 */
export function verifyTwilioSignature(opts: {
  authToken: string;
  url: string;
  params: URLSearchParams;
  signature: string | null;
}): WebhookVerdict {
  if (opts.signature === null) return { ok: false, reason: "missing X-Twilio-Signature" };
  let payload = opts.url;
  // `URLSearchParams.keys()` yields one entry per PAIR, so a repeated
  // parameter would otherwise be walked once per occurrence and its values
  // appended that many times over.
  for (const name of [...new Set(opts.params.keys())].sort()) {
    // A repeated parameter contributes every value, in wire order. Twilio's
    // own helper libraries read the body as an object and so cannot express
    // this case at all — it does not arise in their documented payloads, and
    // appending each value is the literal reading of "append each parameter
    // name and value".
    for (const value of opts.params.getAll(name)) payload += name + value;
  }
  const expected = createHmac("sha1", opts.authToken).update(payload, "utf-8").digest("base64");
  return equals(expected, opts.signature) ? { ok: true } : { ok: false, reason: "bad signature" };
}

/**
 * Telnyx's scheme: Ed25519 over `timestamp|body`, verified against the
 * account's public key.
 *
 * Unlike Twilio's, this one signs the RAW body — so the caller must hand over
 * the bytes it read, not a re-serialization of the parsed form.
 */
export function verifyTelnyxSignature(opts: {
  publicKey: string;
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  now?: number;
}): WebhookVerdict {
  if (opts.signature === null || opts.timestamp === null) {
    return { ok: false, reason: "missing telnyx-signature-ed25519 or telnyx-timestamp" };
  }
  const seconds = Number(opts.timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, reason: "malformed telnyx-timestamp" };
  const nowSeconds = (opts.now ?? Date.now()) / 1000;
  if (Math.abs(nowSeconds - seconds) > TELNYX_MAX_SKEW_SECONDS) {
    return { ok: false, reason: "stale telnyx-timestamp" };
  }
  try {
    const key = createPublicKey({
      // Node has no "raw Ed25519 public key" import, so the 32 key bytes are
      // wrapped in the fixed 12-byte SPKI prefix for Ed25519 (RFC 8410).
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(opts.publicKey, "base64"),
      ]),
      format: "der",
      type: "spki",
    });
    const signed = Buffer.from(`${opts.timestamp}|${opts.rawBody}`, "utf-8");
    const valid = verify(null, signed, key, Buffer.from(opts.signature, "base64"));
    return valid ? { ok: true } : { ok: false, reason: "bad signature" };
  } catch (err) {
    // A malformed key or signature is a rejection, not a 500 — both are
    // attacker-supplied or operator-typo'd, and neither is our failure.
    return { ok: false, reason: `signature check failed: ${String(err)}` };
  }
}

/**
 * Verify a webhook against whichever secret the agent has configured.
 *
 * Returns `{ ok: true }` when no secret is set — see the module doc for why
 * that is the default, and what setting one buys.
 */
export function verifyPhoneWebhook(opts: {
  carrier: string;
  env: Record<string, string> | null;
  url: string;
  rawBody: string;
  headers: Headers;
}): WebhookVerdict {
  const authToken = opts.env?.[TWILIO_AUTH_TOKEN_SECRET];
  if (opts.carrier === "twilio" && authToken) {
    return verifyTwilioSignature({
      authToken,
      url: opts.url,
      params: new URLSearchParams(opts.rawBody),
      signature: opts.headers.get("x-twilio-signature"),
    });
  }
  const publicKey = opts.env?.[TELNYX_PUBLIC_KEY_SECRET];
  if (opts.carrier === "telnyx" && publicKey) {
    return verifyTelnyxSignature({
      publicKey,
      rawBody: opts.rawBody,
      signature: opts.headers.get("telnyx-signature-ed25519"),
      timestamp: opts.headers.get("telnyx-timestamp"),
    });
  }
  return { ok: true };
}
