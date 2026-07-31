// Copyright 2025 the AAI authors. MIT license.
// Credential hashing (argon2id). Agent env records live in Supabase Vault
// via `secret-store.ts` — there is no encryption layer here, and no legacy
// hash or decrypt formats: nothing predating the current scheme was ever
// deployed.

import { hash } from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { TtlCache } from "./_ttl-cache.ts";
import type { BundleStore } from "./store-types.ts";

// ─── Hashing & Authentication ───────────────────────────────────────────────

// Argon2id parameters for new hashes (OWASP recommendation: 19 MiB memory,
// 2 iterations, 1 lane). The parameters are embedded in the PHC string, so
// changing them never invalidates stored hashes.
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

// Credential verification is deliberately expensive (argon2 by design).
// Authenticated routes run it on every request, so
// repeated (apiKey, storedHash) pairs get cached here. Both inputs together
// uniquely determine the boolean result (the storedHash embeds its own salt
// + parameters), making the cache safe. Entries are keyed by
// SHA-256(apiKey) rather than the plaintext key — SHA-256 is only a cache
// key (argon2 stays the verification boundary), but not retaining
// plaintext keys is what lets the cap be generous: at ~200 bytes per entry,
// 10k active pairs is ~2 MB, so multi-tenant traffic doesn't fall off an
// expensive-derivation latency cliff once the tenant count passes the cap.
const VERIFY_CACHE_MAX = 10_000;
const VERIFY_CACHE_TTL_MS = 5 * 60 * 1000;

const verifyCache = new TtlCache<boolean>(VERIFY_CACHE_TTL_MS, VERIFY_CACHE_MAX);

/** Test-only: clear the credential verification cache. */
export function _clearVerifyCache(): void {
  verifyCache.clear();
}

/**
 * Hash an API key with argon2id for storage.
 * Returns a self-describing PHC string: `$argon2id$v=19$m=...,t=...,p=...$<salt>$<hash>`.
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  return argon2Hash(apiKey, ARGON2_OPTIONS);
}

/**
 * Verify a candidate API key against a stored argon2 PHC string
 * (constant-time verify inside `@node-rs/argon2`; malformed strings
 * verify false).
 */
export async function verifyApiKeyHash(apiKey: string, storedHash: string): Promise<boolean> {
  // The fixed-length hex digest doubles as a concatenation-safe prefix — no
  // (apiKey, storedHash) pair can collide with another by concatenation.
  const cacheKey = `${hash("sha256", apiKey)}:${storedHash}`;
  const cached = verifyCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = await argon2Verify(storedHash, apiKey).catch(() => false);
  verifyCache.set(cacheKey, result);
  return result;
}

export type OwnerResult =
  | { status: "unclaimed" }
  | { status: "owned"; keyHash: string }
  | { status: "forbidden" };

export async function verifySlugOwner(
  apiKey: string,
  opts: { slug: string; store: BundleStore },
): Promise<OwnerResult> {
  const { slug, store } = opts;
  const manifest = await store.getManifest(slug);

  if (!manifest) {
    // No keyHash here: hashing burns real CPU (argon2) with a fresh
    // salt (uncacheable), and most callers reject unclaimed slugs with a 404
    // anyway. The deploy-claim path computes the hash lazily (see
    // requireOwner in middleware.ts).
    return { status: "unclaimed" };
  }

  // Verify against all stored hashes concurrently — each cache miss costs
  // an expensive key derivation that runs off the main thread.
  const matches = await Promise.all(
    manifest.credential_hashes.map(async (stored) =>
      (await verifyApiKeyHash(apiKey, stored)) ? stored : null,
    ),
  );
  const matched = matches.find((stored) => stored !== null);
  if (matched !== undefined) {
    // Return the matched stored hash — avoids a redundant expensive rehash.
    return { status: "owned", keyHash: matched };
  }

  return { status: "forbidden" };
}
