// Copyright 2025 the AAI authors. MIT license.

import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";

export type AgentScope = { keyHash: string; slug: string };

const ScopePayloadSchema = z.object({
  sub: z.string().min(1),
  scope: z.string().min(1),
});
export type ScopeKey = CryptoKey;

export async function importScopeKey(secret: string): Promise<ScopeKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Default scope token lifetime: 1 hour. */
const SCOPE_TOKEN_LIFETIME_S = 3600;

export async function signScopeToken(key: ScopeKey, scope: AgentScope): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: scope.keyHash, scope: scope.slug })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + SCOPE_TOKEN_LIFETIME_S)
    .sign(key);
}

export async function verifyScopeToken(key: ScopeKey, token: string): Promise<AgentScope | null> {
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    const parsed = ScopePayloadSchema.safeParse(payload);
    if (!parsed.success) return null;
    return { keyHash: parsed.data.sub, slug: parsed.data.scope };
  } catch {
    return null;
  }
}
