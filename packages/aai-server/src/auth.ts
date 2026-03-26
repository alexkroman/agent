// Copyright 2025 the AAI authors. MIT license.
import { timingSafeEqual } from "node:crypto";
import type { BundleStore } from "./bundle-store-tigris.ts";

const textEncoder = new TextEncoder();

const CACHE_MAX = 100;
const hashCache = new Map<string, string>();

export async function hashApiKey(apiKey: string): Promise<string> {
  const cached = hashCache.get(apiKey);
  if (cached !== undefined) {
    return cached;
  }
  const hash = await crypto.subtle.digest("SHA-256", textEncoder.encode(apiKey));
  const hex = Buffer.from(hash).toString("hex");
  if (hashCache.size >= CACHE_MAX) {
    // Evict oldest entry (first inserted)
    const first = hashCache.keys().next().value;
    if (first !== undefined) hashCache.delete(first);
  }
  hashCache.set(apiKey, hex);
  return hex;
}

/** Visible for testing — clears the internal hash cache. */
export function _clearHashCache(): void {
  hashCache.clear();
}

/** Constant-time string comparison to prevent timing attacks on credential hashes. */
function timingSafeCompare(a: string, b: string): boolean {
  const bufA = textEncoder.encode(a);
  const bufB = textEncoder.encode(b);
  // When lengths differ, compare bufA against itself so timing doesn't leak
  // the length mismatch — timingSafeEqual requires equal-length buffers.
  const match =
    bufA.length === bufB.length ? timingSafeEqual(bufA, bufB) : !timingSafeEqual(bufA, bufA);
  return match;
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
