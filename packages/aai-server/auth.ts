// Copyright 2025 the AAI authors. MIT license.
import { timingSafeEqual } from "node:crypto";
import { LRUCache } from "lru-cache";
import { AUTH_HASH_CACHE_MAX } from "./constants.ts";
import type { BundleStore } from "./store-types.ts";

const textEncoder = new TextEncoder();

// Cache keyed by hash hex. We never store the raw API key in memory;
// instead we always re-hash and check if the result is in the cache.
const hashCache = new LRUCache<string, true>({ max: AUTH_HASH_CACHE_MAX });

export async function hashApiKey(apiKey: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", textEncoder.encode(apiKey));
  const hex = Buffer.from(hash).toString("hex");
  hashCache.set(hex, true);
  return hex;
}

/** Visible for testing — clears the internal hash cache. No-op in production. */
export function _clearHashCache(): void {
  if (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development") {
    hashCache.clear();
  }
}

/** Constant-time string comparison to prevent timing attacks on credential hashes. */
function timingSafeCompare(a: string, b: string): boolean {
  const bufA = textEncoder.encode(a);
  const bufB = textEncoder.encode(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export type OwnerResult =
  | { status: "unclaimed"; keyHash: string }
  | { status: "owned"; keyHash: string }
  | { status: "forbidden" };

export async function verifySlugOwner(
  apiKey: string,
  opts: { slug: string; store: BundleStore },
): Promise<OwnerResult> {
  const { slug, store } = opts;
  const keyHash = await hashApiKey(apiKey);
  const manifest = await store.getManifest(slug);

  if (!manifest) {
    return { status: "unclaimed", keyHash };
  }

  const isOwner = manifest.credential_hashes.some((stored) => timingSafeCompare(stored, keyHash));
  if (isOwner) {
    return { status: "owned", keyHash };
  }

  return { status: "forbidden" };
}
