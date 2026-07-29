// Copyright 2025 the AAI authors. MIT license.
// Credential hashing (argon2 for new hashes, PBKDF2 legacy verify) and
// envelope encryption (iron-webcrypto for new writes, HKDF + AES-256-GCM
// legacy decrypt). Both stored formats are self-describing, so records
// written by older servers keep working — never delete a legacy read path.

import { timingSafeEqual } from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { defaults as ironDefaults, seal as ironSeal, unseal as ironUnseal } from "iron-webcrypto";
import { TtlCache } from "./_ttl-cache.ts";
import { fromBase64Url, toBase64Url } from "./base64url.ts";
import { MAX_ENV_SIZE } from "./constants.ts";
import { EnvSchema } from "./schemas.ts";
import type { BundleStore } from "./store-types.ts";

// ─── Hashing & Authentication ───────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

// Legacy PBKDF2 parameters — verify-only. New hashes are argon2id.
const PBKDF2_HASH = "SHA-256";

// Argon2id parameters for new hashes (OWASP recommendation: 19 MiB memory,
// 2 iterations, 1 lane). The parameters are embedded in the PHC string, so
// changing them never invalidates stored hashes.
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

// Credential verification is deliberately expensive (argon2 by design,
// legacy PBKDF2 ~100ms). Authenticated routes run it on every request, so
// repeated (apiKey, storedHash) pairs get cached here. Both inputs together
// uniquely determine the boolean result (the storedHash embeds its own salt
// + parameters), making the cache safe.
const VERIFY_CACHE_MAX = 256;
const VERIFY_CACHE_TTL_MS = 5 * 60 * 1000;

const verifyCache = new TtlCache<boolean>(VERIFY_CACHE_TTL_MS, VERIFY_CACHE_MAX);

/** Test-only: clear the credential verification cache. */
export function _clearVerifyCache(): void {
  verifyCache.clear();
}

/**
 * Hash an API key with argon2id for storage.
 * Returns a self-describing PHC string: `$argon2id$v=19$m=...,t=...,p=...$<salt>$<hash>`.
 * Legacy `pbkdf2:...` hashes remain verifiable via `verifyApiKeyHash`.
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  return argon2Hash(apiKey, ARGON2_OPTIONS);
}

/**
 * Legacy verify path for hashes stored as
 * `pbkdf2:<iterations>:<base64url-salt>:<base64url-hash>`. Production has
 * credential hashes in this format — keep it working forever.
 */
async function verifyPbkdf2Hash(apiKey: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;

  // biome-ignore lint/style/noNonNullAssertion: length check above guarantees these exist
  const iterations = Number(parts[1]!);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;

  // biome-ignore lint/style/noNonNullAssertion: length check above guarantees these exist
  const salt = new Uint8Array(fromBase64Url(parts[2]!));
  // biome-ignore lint/style/noNonNullAssertion: length check above guarantees these exist
  const expected = new Uint8Array(fromBase64Url(parts[3]!));

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

  return timingSafeEqual(derived, expected);
}

/**
 * Verify a candidate API key against a stored hash string. Dispatches on
 * the stored format: `pbkdf2:...` strings take the legacy PBKDF2 path;
 * everything else is treated as an argon2 PHC string (constant-time
 * verify inside `@node-rs/argon2`; malformed strings verify false).
 */
export async function verifyApiKeyHash(apiKey: string, storedHash: string): Promise<boolean> {
  // Length-prefix the apiKey so no (apiKey, storedHash) pair can collide
  // with another by concatenation.
  const cacheKey = `${apiKey.length}:${apiKey}:${storedHash}`;
  const cached = verifyCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = storedHash.startsWith("pbkdf2:")
    ? await verifyPbkdf2Hash(apiKey, storedHash)
    : await argon2Verify(storedHash, apiKey).catch(() => false);
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
    // No keyHash here: hashing burns real CPU (argon2/PBKDF2) with a fresh
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

// ─── Credential Encryption ───────────────────────────────────────────────────

/** Legacy envelope: HKDF + AES-256-GCM, decrypt-only. */
const ENV_VERSION_LEGACY = 0x01;
/** Current envelope: iron-webcrypto sealed string. */
const ENV_VERSION_IRON = 0x02;
const ENV_SALT_BYTES = 16;
const ENV_IV_BYTES = 12;

export type MasterKey = CryptoKey;

/**
 * Import a master secret as HKDF key material.
 * Called once at server startup; the returned key is passed to
 * `encryptEnv` / `decryptEnv` for per-call key derivation.
 */
export async function importMasterKey(secret: string): Promise<MasterKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
    "deriveKey",
    "deriveBits",
  ]);
}

/**
 * Derive a per-encryption AES-256-GCM key from the master key,
 * a random salt, and the agent slug (legacy v1 envelopes only).
 */
async function deriveEnvKey(
  masterKey: MasterKey,
  salt: Uint8Array<ArrayBuffer>,
  slug: string,
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: enc.encode(slug),
    },
    masterKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Derive the iron seal/unseal password for one agent. Iron has no AAD
 * parameter, so the slug binding the legacy format got from AES-GCM AAD is
 * carried by mixing the slug into the password instead: HKDF-SHA256 over
 * the master key with the slug in `info` yields a per-slug high-entropy
 * password, so a blob sealed for one slug fails integrity for any other.
 * Iron then applies its own random salt/IV/HMAC framing on top.
 */
async function deriveIronPassword(masterKey: MasterKey, slug: string): Promise<string> {
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: enc.encode(`aai-env-iron:${slug}`),
    },
    masterKey,
    256,
  );
  return toBase64Url(new Uint8Array(bits));
}

/**
 * Encrypt an env record with iron-webcrypto. Produces:
 * `version (0x02) || utf8(iron sealed string)` encoded as base64url.
 * Iron handles salt, IV, integrity (HMAC), and framing; the slug is bound
 * via the derived password (see `deriveIronPassword`).
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

  const password = await deriveIronPassword(masterKey, opts.slug);
  const sealed = await ironSeal(opts.env, password, ironDefaults);

  const sealedBytes = enc.encode(sealed);
  const result = new Uint8Array(1 + sealedBytes.byteLength);
  result[0] = ENV_VERSION_IRON;
  result.set(sealedBytes, 1);
  return toBase64Url(result);
}

/**
 * Decrypt a legacy v1 env blob:
 * `version (0x01) || salt (16) || IV (12) || AES-256-GCM ciphertext`,
 * with the slug as AES-GCM additional authenticated data. Production has
 * blobs in this format — keep this path working forever.
 */
async function decryptEnvLegacy(
  masterKey: MasterKey,
  data: Uint8Array,
  slug: string,
): Promise<Record<string, string>> {
  const salt = new Uint8Array(data.slice(1, 1 + ENV_SALT_BYTES));
  const iv = new Uint8Array(data.slice(1 + ENV_SALT_BYTES, 1 + ENV_SALT_BYTES + ENV_IV_BYTES));
  const ciphertext = new Uint8Array(data.slice(1 + ENV_SALT_BYTES + ENV_IV_BYTES));

  const key = await deriveEnvKey(masterKey, salt, slug);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(slug) },
    key,
    ciphertext,
  );
  return EnvSchema.parse(JSON.parse(dec.decode(plaintext)));
}

/**
 * Decrypt an env blob. Reads the version byte and dispatches accordingly.
 */
export async function decryptEnv(
  masterKey: MasterKey,
  opts: { encrypted: string; slug: string },
): Promise<Record<string, string>> {
  const data = fromBase64Url(opts.encrypted);

  const version = data[0];
  if (version === ENV_VERSION_LEGACY) {
    return decryptEnvLegacy(masterKey, data, opts.slug);
  }
  if (version === ENV_VERSION_IRON) {
    const password = await deriveIronPassword(masterKey, opts.slug);
    const sealed = dec.decode(data.slice(1));
    const unsealed = await ironUnseal(sealed, password, ironDefaults);
    return EnvSchema.parse(unsealed);
  }
  throw new Error(`Unknown env encryption version: ${version}`);
}
