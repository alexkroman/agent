// Copyright 2025 the AAI authors. MIT license.
// Uses Web Crypto API (available in workerd) for AES-256-GCM + HKDF.

import { z } from "zod";
import { fromBase64Url, toBase64Url } from "./base64url.ts";

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
