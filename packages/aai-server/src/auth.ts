// Copyright 2025 the AAI authors. MIT license.
import { timingSafeEqual } from "node:crypto";
import type { BundleStore } from "./bundle-store-tigris.ts";

export async function hashApiKey(apiKey: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time string comparison to prevent timing attacks on credential hashes. */
function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  return timingSafeEqual(enc.encode(a), enc.encode(b));
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
