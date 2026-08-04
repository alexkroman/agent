// Copyright 2026 the AAI authors. MIT license.
// Credential digests for slug ownership. Agent env records live in Supabase
// Vault via `secret-store.ts` — there is no encryption layer here, and no
// legacy hash or decrypt formats: nothing predating the current scheme was
// ever deployed.
//
// SHA-256, not a password hash. Platform API keys are high-entropy,
// machine-issued secrets — the slow-salted-hash stack this replaced
// (argon2id PHC strings, a TTL verify cache keyed by SHA-256(key), and
// lazy-hash choreography on every route to dodge the ~100ms derivations)
// defended against feasible brute force of LOW-entropy secrets, a threat
// API keys don't have. A plain digest is preimage-resistant where it
// counts, deterministic (so no cache is needed at all), fast, and
// dependency-free. Browser sessions never reach this file: middleware
// resolves them to the user's stored key first (see supabase-auth.ts).

import { hash, timingSafeEqual } from "node:crypto";
import type { BundleStore } from "./store-types.ts";

const DIGEST_PREFIX = "sha256:";

/** Digest an API key for ownership storage: `sha256:<hex>`. */
export function hashApiKey(apiKey: string): string {
  return DIGEST_PREFIX + hash("sha256", apiKey);
}

/** True when `apiKey` digests to `storedHash` (constant-time compare). */
export function verifyApiKeyHash(apiKey: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashApiKey(apiKey));
  const stored = Buffer.from(storedHash);
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

export type OwnerResult = { status: "unclaimed" | "owned" | "forbidden" };

/** The first stored hash `apiKey` matches, or null when none do. */
export function matchAnyHash(apiKey: string, hashes: string[]): string | null {
  return hashes.find((stored) => verifyApiKeyHash(apiKey, stored)) ?? null;
}

export async function verifySlugOwner(
  apiKey: string,
  opts: { slug: string; store: BundleStore },
): Promise<OwnerResult> {
  const { slug, store } = opts;
  const record = await store.getAgent(slug);

  // No agent record: only the deploy path (which claims the slug) may
  // proceed; data routes translate this to a 404 (see requireOwner in
  // middleware.ts).
  if (!record) return { status: "unclaimed" };

  const matched = matchAnyHash(apiKey, record.credential_hashes);
  return { status: matched !== null ? "owned" : "forbidden" };
}
