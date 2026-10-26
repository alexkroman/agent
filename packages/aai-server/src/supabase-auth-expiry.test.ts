// Copyright 2026 the AAI authors. MIT license.
/**
 * A session token whose verification STRADDLES its own `exp` must not be
 * cached forever.
 *
 * `getClaims` checks `exp` BEFORE the async signature step (JWKS fetch /
 * `getUser`). If that step finishes after `exp`, `cacheTtlFor` computes
 * `max(0, exp*1000 - now)` = 0, and `lru-cache` reads a per-entry `ttl: 0` as
 * "no TTL", so the verified identity was served from cache indefinitely —
 * `TtlCache.set` now stores nothing for a lifetime of zero.
 */
import { afterEach, expect, test, vi } from "vitest";
import { createSupabaseAuth } from "./supabase-auth.ts";

afterEach(() => {
  vi.useRealTimers();
});

test("a token verified across its own exp is not accepted forever", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = "kid-ttl0";
  const url = "https://adv-ttl-zero.supabase.co";

  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  const nowSec = Math.floor(start / 1000);
  const exp = nowSec + 1;

  const seg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const input = `${seg({ alg: "ES256", typ: "JWT", kid })}.${seg({
    iss: `${url}/auth/v1`,
    aud: "authenticated",
    role: "authenticated",
    sub: "victim-uid",
    iat: nowSec,
    exp,
  })}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    new TextEncoder().encode(input),
  );
  const token = `${input}.${Buffer.from(sig).toString("base64url")}`;

  const fetchFn = vi.fn(async (req: string | URL | Request) => {
    if (String(req).includes(".well-known/jwks.json")) {
      // The verification's network step completes just after the token expires.
      vi.setSystemTime(exp * 1000 + 1);
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid, alg: "ES256", use: "sig" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 401 });
  });
  const auth = createSupabaseAuth({
    supabaseUrl: url,
    supabasePublishableKey: "sb_publishable_test",
    fetchFn,
  });

  // First verification passed exp validation before the clock crossed exp.
  await auth.verifyAccessToken(token);

  // One day later, the token is long expired. It must not verify.
  vi.setSystemTime(exp * 1000 + 24 * 60 * 60 * 1000);
  expect(await auth.verifyAccessToken(token)).toBeNull();
});
