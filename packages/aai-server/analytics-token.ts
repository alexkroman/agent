// Copyright 2026 the AAI authors. MIT license.
/**
 * The credential a deployed agent's guest presents when it ships analytics.
 *
 * A guest sandbox holds no account credential — that is the platform's
 * standing rule, and analytics must not be the exception that breaks it. What
 * it needs is narrower than a credential anyway: permission to append rows
 * *for its own slug*, and nothing else.
 *
 * So the token is a keyed hash of the slug, minted by the spawner and
 * verified by recomputation:
 *
 *     token = HMAC-SHA256(platform secret, "analytics:v1:<slug>")
 *
 * Three properties follow, and each one is why this is not a random token in
 * a table:
 *
 * - **Stateless verification.** The ingest route runs on whichever replica
 *   the request lands on, which is almost never the one that spawned the
 *   sandbox. A random per-sandbox token would need a lookup on the hot path
 *   (the highest-write path the platform has) against a row the spawner may
 *   not have committed yet.
 * - **It authorizes exactly one slug.** The slug is INSIDE the hash, so a
 *   token stolen from one tenant's guest cannot write rows attributed to
 *   another. The route reads the slug from the body and verifies the token
 *   against THAT slug — never the other way round.
 * - **It is not an account credential.** Holding it lets you append analytics
 *   for one slug. It cannot read them back (the read paths authenticate the
 *   caller's own API key and check slug ownership), cannot deploy, and cannot
 *   reach anything else.
 *
 * The cost of statelessness is that the token does not expire with the
 * sandbox: it is valid for as long as the platform secret is. That is
 * acceptable for an append-only, single-slug, unreadable capability whose
 * worst case is a tenant writing junk analytics about their own agent — and
 * rotating `ANALYTICS_INGEST_SECRET` invalidates every outstanding one.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Version prefix, so a future change to the derivation is not ambiguous. */
const TOKEN_PREFIX = "analytics:v1:";

/** Mint the ingest token for one slug. */
export function mintAnalyticsToken(secret: string, slug: string): string {
  return createHmac("sha256", secret).update(`${TOKEN_PREFIX}${slug}`).digest("hex");
}

/**
 * Constant-time check that `token` is the one this slug should carry.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak
 * length — so the comparison is over fixed-width buffers of the hex digests
 * and a wrong-length token fails the cheap check first.
 */
export function verifyAnalyticsToken(secret: string, slug: string, token: string): boolean {
  const expected = mintAnalyticsToken(secret, slug);
  if (token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token, "utf-8"), Buffer.from(expected, "utf-8"));
}
