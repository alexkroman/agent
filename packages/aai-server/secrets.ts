// Copyright 2025 the AAI authors. MIT license.
// Uses Web Crypto API for PBKDF2 credential hashing and AES-256-GCM + HKDF envelope encryption.

import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { fromBase64Url, toBase64Url } from "./base64url.ts";
import { MAX_ENV_SIZE } from "./constants.ts";
import type { BundleStore } from "./store-types.ts";

// ─── Hashing & Authentication ───────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH = "SHA-256";
const HASH_SALT_BYTES = 16;
const HASH_OUTPUT_BYTES = 32;

// PBKDF2 verification takes ~100ms per call. Authenticated routes run it on
// every request, so repeated (apiKey, storedHash) pairs get cached here.
// Both inputs together uniquely determine the boolean result (the storedHash
// embeds its own salt + parameters), making the cache safe.
const VERIFY_CACHE_MAX = 256;
const VERIFY_CACHE_TTL_MS = 5 * 60 * 1000;

type VerifyCacheEntry = { result: boolean; expires: number };
const verifyCache = new Map<string, VerifyCacheEntry>();

function verifyCacheGet(key: string): boolean | undefined {
  const entry = verifyCache.get(key);
  if (!entry) return;
  if (entry.expires < Date.now()) {
    verifyCache.delete(key);
    return;
  }
  // Refresh LRU position
  verifyCache.delete(key);
  verifyCache.set(key, entry);
  return entry.result;
}

function verifyCacheSet(key: string, result: boolean): void {
  if (verifyCache.size >= VERIFY_CACHE_MAX) {
    const oldest = verifyCache.keys().next().value;
    if (oldest !== undefined) verifyCache.delete(oldest);
  }
  verifyCache.set(key, { result, expires: Date.now() + VERIFY_CACHE_TTL_MS });
}

/** Test-only: clear the PBKDF2 verification cache. */
export function _clearVerifyCache(): void {
  verifyCache.clear();
}

/**
 * Hash an API key with PBKDF2-SHA-256 for storage.
 * Returns a self-describing string: `pbkdf2:600000:<base64url-salt>:<base64url-hash>`
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(HASH_SALT_BYTES));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(apiKey), "PBKDF2", false, [
    "deriveBits",
  ]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: PBKDF2_HASH, salt, iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    HASH_OUTPUT_BYTES * 8,
  );
  return `pbkdf2:${PBKDF2_ITERATIONS}:${toBase64Url(salt)}:${toBase64Url(new Uint8Array(derived))}`;
}

/**
 * Verify a candidate API key against a stored PBKDF2 hash string.
 * Parses the stored format, re-derives with the embedded salt, and
 * compares with timing-safe equality.
 */
export async function verifyApiKeyHash(apiKey: string, storedHash: string): Promise<boolean> {
  // Length-prefix the apiKey so no (apiKey, storedHash) pair can collide
  // with another by concatenation.
  const cacheKey = `${apiKey.length}:${apiKey}:${storedHash}`;
  const cached = verifyCacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const parts = storedHash.split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const [, iterStr, saltStr, hashStr] = parts as [string, string, string, string];

  const iterations = Number(iterStr);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;

  const salt = new Uint8Array(fromBase64Url(saltStr));
  const expected = fromBase64Url(hashStr);

  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(apiKey), "PBKDF2", false, [
    "deriveBits",
  ]);
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: PBKDF2_HASH, salt, iterations },
      keyMaterial,
      expected.byteLength * 8,
    ),
  );

  if (derived.byteLength !== expected.byteLength) return false;
  const result = timingSafeEqual(derived, expected);
  verifyCacheSet(cacheKey, result);
  return result;
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
  const manifest = await store.getManifest(slug);

  if (!manifest) {
    const keyHash = await hashApiKey(apiKey);
    return { status: "unclaimed", keyHash };
  }

  for (const stored of manifest.credential_hashes) {
    if (await verifyApiKeyHash(apiKey, stored)) {
      // Return the matched stored hash — avoids a redundant ~100ms PBKDF2 call.
      return { status: "owned", keyHash: stored };
    }
  }

  return { status: "forbidden" };
}

// ─── Credential Encryption ───────────────────────────────────────────────────

const EnvSchema = z.record(z.string(), z.string());

const ENV_VERSION = 0x01;
const ENV_SALT_BYTES = 16;
const ENV_IV_BYTES = 12;

// Byte layout of an encrypted env blob: version(1) || salt || IV || ciphertext.
// Encode and decode both reference these offsets so the layout has one source
// of truth.
const ENV_SALT_OFFSET = 1;
const ENV_IV_OFFSET = ENV_SALT_OFFSET + ENV_SALT_BYTES;
const ENV_CIPHERTEXT_OFFSET = ENV_IV_OFFSET + ENV_IV_BYTES;

export type MasterKey = CryptoKey;

/**
 * Import a master secret as HKDF key material.
 * Called once at server startup; the returned key is passed to
 * `encryptEnv` / `decryptEnv` for per-call key derivation.
 */
export async function importMasterKey(secret: string): Promise<MasterKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
}

/**
 * Derive a per-encryption AES-256-GCM key from the master key,
 * a random salt, and the agent slug.
 */
async function deriveEnvKey(
  masterKey: MasterKey,
  salt: Uint8Array<ArrayBuffer>,
  slugBytes: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: slugBytes,
    },
    masterKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt an env record. Produces:
 * `version (1) || salt (16) || IV (12) || AES-256-GCM ciphertext`
 * encoded as base64url.
 *
 * Throws if the serialized env exceeds MAX_ENV_SIZE (64 KB).
 */
export async function encryptEnv(
  masterKey: MasterKey,
  opts: { env: Record<string, string>; slug: string },
): Promise<string> {
  const plaintext = enc.encode(JSON.stringify(opts.env));
  if (plaintext.byteLength > MAX_ENV_SIZE) {
    throw new Error(
      `Env blob size (${plaintext.byteLength} bytes) exceeds maximum (${MAX_ENV_SIZE} bytes)`,
    );
  }

  const slugBytes = enc.encode(opts.slug);
  const salt = crypto.getRandomValues(new Uint8Array(ENV_SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(ENV_IV_BYTES));
  const key = await deriveEnvKey(masterKey, salt, slugBytes);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: slugBytes },
    key,
    plaintext,
  );

  // version || salt || IV || ciphertext
  const result = new Uint8Array(ENV_CIPHERTEXT_OFFSET + ciphertext.byteLength);
  result[0] = ENV_VERSION;
  result.set(salt, ENV_SALT_OFFSET);
  result.set(iv, ENV_IV_OFFSET);
  result.set(new Uint8Array(ciphertext), ENV_CIPHERTEXT_OFFSET);
  return toBase64Url(result);
}

/**
 * Decrypt an env blob. Only version `0x01` is supported; any other version
 * byte is rejected.
 */
export async function decryptEnv(
  masterKey: MasterKey,
  opts: { encrypted: string; slug: string },
): Promise<Record<string, string>> {
  const data = fromBase64Url(opts.encrypted);

  const version = data[0];
  if (version !== ENV_VERSION) {
    throw new Error(`Unknown env encryption version: ${version}`);
  }

  const salt = new Uint8Array(data.slice(ENV_SALT_OFFSET, ENV_IV_OFFSET));
  const iv = new Uint8Array(data.slice(ENV_IV_OFFSET, ENV_CIPHERTEXT_OFFSET));
  const ciphertext = new Uint8Array(data.slice(ENV_CIPHERTEXT_OFFSET));

  const slugBytes = enc.encode(opts.slug);
  const key = await deriveEnvKey(masterKey, salt, slugBytes);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: slugBytes },
    key,
    ciphertext,
  );
  return EnvSchema.parse(JSON.parse(dec.decode(plaintext)));
}
