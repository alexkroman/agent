// Copyright 2026 the AAI authors. MIT license.
/**
 * Browser-session auth for the studio: Supabase Auth (GoTrue) in
 * production, a no-dependency dev implementation locally.
 *
 * The studio's browser client signs in with a Supabase magic link and sends
 * the resulting access token as its bearer. The platform resolves that token
 * to a Supabase user by asking Supabase itself (`GET /auth/v1/user` — no JWT
 * secret or JWKS handling to maintain, and it works for both HS256 and
 * asymmetric-key projects), then looks up the user's stored AssemblyAI API
 * key (`user-key:<uid>` in the SecretStore) so everything downstream — the
 * gateway LLM, deploys, ownership hashes — keeps running on the real key.
 *
 * Raw API-key bearers are untouched: the `aai` CLI (and the in-guest
 * `aai deploy` Publish runs) authenticate with the key itself, and a key
 * never contains dots, so the JWT shape test cleanly splits the two.
 *
 * Local dev (`createDevAuth`, selected by the same `isLocalDev` policy that
 * picks the in-memory stores — production can never resolve it) accepts
 * self-describing `dev.<base64url({id,email})>.dev` tokens the login screen
 * mints client-side, so `pnpm dev:aai-server` needs no Supabase project, no
 * SMTP, and no Docker while exercising the same middleware, key onboarding,
 * and scoping as real sessions.
 */

import { hash } from "node:crypto";
import { TtlCache } from "./_ttl-cache.ts";

/** SecretStore name for one studio user's AssemblyAI API key. */
export function userApiKeySecretName(userId: string): string {
  return `user-key:${userId}`;
}

export type StudioAuthUser = { id: string; email?: string };

/**
 * What `GET /studio/auth` tells the login screen to render: a Supabase
 * magic-link flow, or the local-dev email box that mints its own token.
 */
export type StudioAuthClientConfig =
  | { mode: "supabase"; supabaseUrl: string; supabaseAnonKey: string }
  | { mode: "dev" };

export type StudioAuth = {
  clientConfig: StudioAuthClientConfig;
  /** Resolve a session access token to its user; null when invalid/expired. */
  verifyAccessToken(token: string): Promise<StudioAuthUser | null>;
};

// A JWT is three dot-separated base64url segments; platform API keys never
// contain dots. This is only a dispatch test — the verification boundary is
// the auth backend's answer, never the shape. Dev tokens are deliberately
// JWT-shaped so one test routes both.
const JWT_SHAPE_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/** True when a bearer token is a session token (JWT-shaped), not an API key. */
export function isJwtShaped(token: string): boolean {
  return JWT_SHAPE_RE.test(token);
}

const VERIFY_TTL_MS = 60_000;
const VERIFY_MAX = 10_000;

export function createSupabaseAuth(opts: {
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** Test seam — never set outside tests. */
  fetchFn?: typeof globalThis.fetch;
}): StudioAuth {
  const base = opts.supabaseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchFn ?? globalThis.fetch;
  // Null (invalid token) is cached too: a rejected token that keeps arriving
  // must not hammer Supabase on every request. The positive TTL is short
  // enough that a revoked session dies within a minute.
  const cache = new TtlCache<StudioAuthUser | null>(VERIFY_TTL_MS, VERIFY_MAX);

  return {
    // The anon key is public by design (it ships in every Supabase browser app).
    clientConfig: { mode: "supabase", supabaseUrl: base, supabaseAnonKey: opts.supabaseAnonKey },

    async verifyAccessToken(token) {
      const cacheKey = hash("sha256", token);
      const cached = cache.get(cacheKey);
      if (cached !== undefined) return cached;

      const res = await doFetch(`${base}/auth/v1/user`, {
        headers: { apikey: opts.supabaseAnonKey, Authorization: `Bearer ${token}` },
      });
      if (res.status === 401 || res.status === 403) {
        cache.set(cacheKey, null);
        return null;
      }
      if (!res.ok) {
        // Supabase being down is a 5xx to the caller, not a silent sign-out:
        // fail closed but distinguishably from "your session expired".
        throw new Error(`Supabase auth verification failed (HTTP ${res.status})`);
      }
      const body = (await res.json().catch(() => null)) as {
        id?: unknown;
        email?: unknown;
      } | null;
      if (!body || typeof body.id !== "string" || body.id.length === 0) {
        cache.set(cacheKey, null);
        return null;
      }
      const user: StudioAuthUser = {
        id: body.id,
        ...(typeof body.email === "string" && body.email ? { email: body.email } : {}),
      };
      cache.set(cacheKey, user);
      return user;
    },
  };
}

// Dev tokens: `dev.<base64url(JSON {id,email})>.dev`. The fixed first/last
// segments make them impossible to confuse with a real JWT on sight, while
// still matching the JWT shape test that routes session bearers.
const DEV_TOKEN_SEGMENT = "dev";

/** Client-side counterpart lives in the studio login screen (dev mode). */
export function parseDevToken(token: string): StudioAuthUser | null {
  const [head, payload, tail] = token.split(".");
  if (head !== DEV_TOKEN_SEGMENT || tail !== DEV_TOKEN_SEGMENT || !payload) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      id?: unknown;
      email?: unknown;
    };
    if (typeof body.id !== "string" || body.id.length === 0) return null;
    return {
      id: body.id,
      ...(typeof body.email === "string" && body.email ? { email: body.email } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Local-dev auth: trusts self-describing dev tokens. NO authentication at
 * all — anyone who can reach the (loopback-bound) dev server can claim any
 * identity. Only `buildServiceConfig` may construct it, under the same
 * `isLocalDev` policy that selects the in-memory stores, so production can
 * never resolve it.
 */
export function createDevAuth(): StudioAuth {
  return {
    clientConfig: { mode: "dev" },
    verifyAccessToken: (token) => Promise.resolve(parseDevToken(token)),
  };
}

/**
 * Build the auth binding from `SUPABASE_URL` + `SUPABASE_ANON_KEY`, falling
 * back to dev auth in local dev. Undefined (no auth configured outside local
 * dev) leaves raw-key bearers working and the studio login unconfigured.
 */
export function createStudioAuthFromEnv(
  env: NodeJS.ProcessEnv,
  opts: { localDev: boolean },
): StudioAuth | undefined {
  const { SUPABASE_URL: supabaseUrl, SUPABASE_ANON_KEY: supabaseAnonKey } = env;
  if (supabaseUrl && supabaseAnonKey) return createSupabaseAuth({ supabaseUrl, supabaseAnonKey });
  if (opts.localDev) return createDevAuth();
}
