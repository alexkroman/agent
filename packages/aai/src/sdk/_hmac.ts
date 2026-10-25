// Copyright 2026 the AAI authors. MIT license.
/**
 * HMAC-SHA256 over Web Crypto, once — the MAC a call brief is signed with
 * (`call-brief.ts`, hex) and a Standard Webhooks signature is checked against
 * (`standard-webhook.ts`, base64). Each caller encodes the bytes its wire
 * format wants; the key import and the sign are the part that was copied.
 *
 * Web Crypto rather than `node:crypto`, so it runs in the agent bundle, a
 * browser or a guest alike. Internal (`_`-prefixed).
 *
 * @module _hmac
 */

/** The HMAC-SHA256 of `text` under `key`, as raw bytes. */
export async function hmacSha256(key: Uint8Array, text: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(text)));
}
