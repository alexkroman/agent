// Copyright 2025 the AAI authors. MIT license.
// Uses Web Crypto API (available in workerd) for HMAC-SHA256 JWT.

import { fromBase64Url, toBase64Url } from "./_base64url.ts";

const enc = new TextEncoder();

export type AgentScope = { keyHash: string; slug: string };
export type ScopeKey = CryptoKey;

function base64url(bytes: Uint8Array): string {
  return toBase64Url(bytes);
}

function base64urlEncode(s: string): string {
  return base64url(enc.encode(s));
}

export async function importScopeKey(secret: string): Promise<ScopeKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signScopeToken(key: ScopeKey, scope: AgentScope): Promise<string> {
  const header = base64urlEncode(JSON.stringify({ alg: "HS256" }));
  const payload = base64urlEncode(JSON.stringify({ sub: scope.keyHash, scope: scope.slug }));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

export async function verifyScopeToken(key: ScopeKey, token: string): Promise<AgentScope | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts;
    if (!(header && payload && sig)) return null;

    const signingInput = `${header}.${payload}`;
    const signature = new Uint8Array(fromBase64Url(sig));
    const valid = await crypto.subtle.verify("HMAC", key, signature, enc.encode(signingInput));
    if (!valid) return null;

    const decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    const sub = decoded.sub;
    const scope = decoded.scope;
    if (typeof sub !== "string" || typeof scope !== "string" || !sub || !scope) {
      return null;
    }
    return { keyHash: sub, slug: scope };
  } catch {
    return null;
  }
}
