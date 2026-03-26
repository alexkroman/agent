// Copyright 2025 the AAI authors. MIT license.
import { timingSafeEqual } from "node:crypto";
import type { BundleStore } from "./bundle-store-tigris.ts";

const textEncoder = new TextEncoder();

export async function hashApiKey(apiKey: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", textEncoder.encode(apiKey));
  return Buffer.from(hash).toString("hex");
}

/**
 * Constant-time string comparison to prevent timing attacks on credential hashes.
 *
 * Note: the length check short-circuits before the constant-time comparison,
 * which technically leaks length information. This is an accepted tradeoff
 * because all inputs are SHA-256 hex digests (always 64 characters).
 */
export function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(textEncoder.encode(a), textEncoder.encode(b));
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
