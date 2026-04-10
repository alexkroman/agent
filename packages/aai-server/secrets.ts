// Copyright 2025 the AAI authors. MIT license.
// Uses Web Crypto API for credential hashing, authentication, and AES-256-GCM + HKDF encryption.

import { timingSafeEqual } from "node:crypto";
import { LRUCache } from "lru-cache";
import { z } from "zod";
import { fromBase64Url, toBase64Url } from "./base64url.ts";
import { AUTH_HASH_CACHE_MAX } from "./constants.ts";
import type { BundleStore } from "./store-types.ts";

// ─── Hashing & Authentication ───────────────────────────────────────────────

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
export function timingSafeCompare(a: string, b: string): boolean {
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

// ─── Credential Encryption ───────────────────────────────────────────────────

const EnvSchema = z.record(z.string(), z.string());

const enc = new TextEncoder();
const dec = new TextDecoder();

export type CredentialKey = CryptoKey;

export async function deriveCredentialKey(secret: string): Promise<CredentialKey> {
  const rawKey = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("aai-credentials"),
      info: enc.encode("env-encryption"),
    },
    rawKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptEnv(
  key: CredentialKey,
  opts: { env: Record<string, string>; slug: string },
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = enc.encode(JSON.stringify(opts.env));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(opts.slug) },
    key,
    plaintext,
  );
  // Prepend IV to ciphertext
  const result = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.byteLength);
  return toBase64Url(result);
}

export async function decryptEnv(
  key: CredentialKey,
  opts: { encrypted: string; slug: string },
): Promise<Record<string, string>> {
  const data = fromBase64Url(opts.encrypted);
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(opts.slug) },
    key,
    ciphertext,
  );
  return EnvSchema.parse(JSON.parse(dec.decode(plaintext)));
}
