// Copyright 2026 the AAI authors. MIT license.
/**
 * Browser-session auth for the studio: Supabase Auth (GoTrue) in
 * production, a no-dependency dev implementation locally.
 *
 * The studio's browser client signs in with GitHub OAuth (Supabase's
 * `signInWithOAuth`) and sends the resulting access token as its bearer. The
 * platform resolves that token to a Supabase user, then looks up the user's
 * stored AssemblyAI API key (`user-key:<uid>` in the SecretStore) so
 * everything downstream — the gateway LLM, deploys, ownership hashes — keeps
 * running on the real key.
 *
 * **Two verifications, and the split is deliberate.** Supabase's guidance is
 * to "prefer `getClaims` over `getUser`, which always sends a request to the
 * Auth server for each JWT": on a project using asymmetric JWT signing keys,
 * `getClaims` verifies the signature LOCALLY (WebCrypto) against a cached
 * JWKS, so the hot path costs no network at all. Every request rides that
 * path ({@link StudioAuth.verifyAccessToken}).
 *
 * What a local verification cannot see is REVOCATION — a signed-out session
 * or a deleted user stays cryptographically valid until `exp`. So the three
 * account routes, where that matters (they hand out and rotate the account's
 * AssemblyAI key), ask the Auth server itself:
 * {@link StudioAuth.verifyAccessTokenFresh}, uncached.
 *
 * Adopting `getClaims` is safe on either kind of project: on a symmetric
 * (HS256) one it falls back to a server call by itself, which is exactly the
 * behaviour this replaced. That is also why the hot path keeps its short TTL
 * cache — on such a project it is what stops a per-request round trip.
 *
 * Raw API-key bearers are untouched: the `aai` CLI (and the in-guest
 * `aai deploy` Publish runs) authenticate with the key itself, and a key
 * never contains dots, so the JWT shape test cleanly splits the two.
 *
 * Local dev (`createDevAuth`, selected by the same `isLocalDev` policy that
 * picks the in-memory stores — production can never resolve it) accepts
 * self-describing `dev.<base64url({id,email})>.dev` tokens the login screen
 * mints client-side, so `pnpm dev:aai-server` needs no Supabase project, no
 * GitHub OAuth app, and no Docker while exercising the same middleware, key
 * onboarding, and scoping as real sessions.
 */

import { hash } from "node:crypto";
import { GoTrueClient, isAuthRetryableFetchError } from "@supabase/auth-js";
import { TtlCache } from "./_ttl-cache.ts";

/** SecretStore name for one studio user's AssemblyAI API key. */
export function userApiKeySecretName(userId: string): string {
  return `user-key:${userId}`;
}

/**
 * SecretStore name for the REVERSE mapping: a raw API key (hashed — a
 * listing of stored names must never show a live credential) to the studio
 * user id that owns it. This is what lets a raw-key caller — the `aai` CLI
 * after `aai login` — land in the same `user:<uid>` studio scope as the
 * browser, instead of the disjoint key-derived scope, so both sides see one
 * project list.
 *
 * TWO routes write it, and both are load-bearing: `PUT /studio/account/key`
 * (key onboarding and rotation) and `POST /studio/cli-link/approve` (which
 * backfills it, so an account whose key was stored before this mapping
 * existed is healed by its next `aai login` rather than staying invisibly
 * key-scoped — see the comment there).
 *
 * A rotated key leaves its old mapping behind on purpose: the old key still
 * belongs to the same account, so resolving it to the same user is correct,
 * and deleting it would only matter if an AssemblyAI key could migrate
 * between accounts (it can't). If two users store the SAME key (a shared
 * team key), the last writer wins the mapping — their browser scopes stay
 * separate either way.
 */
export function apiKeyOwnerSecretName(apiKey: string): string {
  return `key-user:${hash("sha256", apiKey)}`;
}

/**
 * SecretStore name for an approved `aai login` link grant. Keyed by the
 * HASH of the CLI-minted code, so a listing of stored names never shows a
 * code that could still be exchanged.
 */
export function cliLinkSecretName(code: string): string {
  return `cli-link:${hash("sha256", code)}`;
}

export type StudioAuthUser = { id: string; email?: string };

/**
 * What `GET /studio/auth` tells the login screen to render: the Supabase
 * GitHub-OAuth flow, or the local-dev email box that mints its own token.
 */
export type StudioAuthClientConfig =
  | { mode: "supabase"; supabaseUrl: string; supabasePublishableKey: string }
  | { mode: "dev" };

export type StudioAuth = {
  clientConfig: StudioAuthClientConfig;
  /**
   * Resolve a session access token to its user; null when invalid/expired.
   *
   * The hot path — every studio request. Verifies the token's SIGNATURE
   * (locally, on an asymmetric-key project), which is authoritative about who
   * issued the token and when it expires, and blind to whether the session
   * has since been revoked. Bounded by the token's own lifetime and the cache
   * TTL below; use {@link verifyAccessTokenFresh} where that matters.
   */
  verifyAccessToken(token: string): Promise<StudioAuthUser | null>;
  /**
   * The same answer, from the Auth SERVER — so a signed-out session, a
   * deleted user, or a revoked token is seen immediately rather than at
   * `exp`. Uncached, and therefore a network round trip per call: reserve it
   * for routes where acting on a stale identity is a real cost, not for
   * request-path authentication.
   */
  verifyAccessTokenFresh(token: string): Promise<StudioAuthUser | null>;
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
  supabasePublishableKey: string;
  /** Test seam — never set outside tests. */
  fetchFn?: typeof globalThis.fetch;
}): StudioAuth {
  const base = opts.supabaseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchFn ?? globalThis.fetch;
  // Null (invalid token) is cached too: a rejected token that keeps arriving
  // must not re-verify on every request. The positive TTL is short enough
  // that a revoked session dies within a minute even on the local path.
  const cache = new TtlCache<StudioAuthUser | null>(VERIFY_TTL_MS, VERIFY_MAX);

  // Session management is all OFF: this client never holds a session, it
  // verifies tokens other people hold. Left on, `persistSession` would reach
  // for browser storage and `autoRefreshToken` would start a timer for a
  // session that does not exist.
  //
  // `storageKey` is set because auth-js caches the fetched JWKS in a
  // PROCESS-GLOBAL map keyed by it (`GLOBAL_JWKS[storageKey]`) — not by URL.
  // That cache is what makes local verification free, and sharing one entry
  // between clients pointed at different projects would verify one project's
  // tokens against another's signing keys. Deriving it from the URL makes the
  // cache key the thing it is actually caching.
  const gotrue = new GoTrueClient({
    url: `${base}/auth/v1`,
    headers: { apikey: opts.supabasePublishableKey },
    storageKey: `aai-studio-auth-${base}`,
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
    fetch: doFetch,
  });

  /** JWT claims → the user shape, or null when the claims name no subject. */
  const userFromClaims = (claims: { sub?: unknown; email?: unknown }): StudioAuthUser | null =>
    typeof claims.sub === "string" && claims.sub.length > 0
      ? {
          id: claims.sub,
          ...(typeof claims.email === "string" && claims.email ? { email: claims.email } : {}),
        }
      : null;

  const verifyFresh = async (token: string): Promise<StudioAuthUser | null> => {
    const res = await doFetch(`${base}/auth/v1/user`, {
      headers: { apikey: opts.supabasePublishableKey, Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) {
      // Supabase being down is a 5xx to the caller, not a silent sign-out:
      // fail closed but distinguishably from "your session expired".
      throw new Error(`Supabase auth verification failed (HTTP ${res.status})`);
    }
    const body = (await res.json().catch(() => null)) as {
      id?: unknown;
      email?: unknown;
    } | null;
    if (!body || typeof body.id !== "string" || body.id.length === 0) return null;
    return {
      id: body.id,
      ...(typeof body.email === "string" && body.email ? { email: body.email } : {}),
    };
  };

  return {
    // The publishable key is public by design (it ships in every Supabase browser app).
    clientConfig: {
      mode: "supabase",
      supabaseUrl: base,
      supabasePublishableKey: opts.supabasePublishableKey,
    },

    async verifyAccessToken(token) {
      const cacheKey = hash("sha256", token);
      const cached = cache.get(cacheKey);
      if (cached !== undefined) return cached;

      const { data, error } = await gotrue.getClaims(token);
      if (error) {
        // A malformed/expired/wrongly-signed token and an unreachable Supabase
        // are opposite answers — the first is "sign in again", the second must
        // not sign anyone out. Only the retryable-fetch class is the latter,
        // and it is the one case that must NOT be cached as a rejection.
        if (isAuthRetryableFetchError(error)) {
          throw new Error(`Supabase auth verification failed: ${error.message}`, { cause: error });
        }
        cache.set(cacheKey, null);
        return null;
      }
      const user = data ? userFromClaims(data.claims) : null;
      cache.set(cacheKey, user);
      return user;
    },

    verifyAccessTokenFresh: verifyFresh,
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
  // Both verifications are the same parse: a dev token carries its own
  // identity and there is no Auth server behind it to ask for a fresher
  // answer. The distinction only means something against real Supabase.
  const verify = (token: string): Promise<StudioAuthUser | null> =>
    Promise.resolve(parseDevToken(token));
  return {
    clientConfig: { mode: "dev" },
    verifyAccessToken: verify,
    verifyAccessTokenFresh: verify,
  };
}

/**
 * Build the auth binding from `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY`, falling
 * back to dev auth in local dev. Undefined (no auth configured outside local
 * dev) leaves raw-key bearers working and the studio login unconfigured.
 */
export function createStudioAuthFromEnv(
  env: NodeJS.ProcessEnv,
  opts: { localDev: boolean },
): StudioAuth | undefined {
  const { SUPABASE_URL: supabaseUrl, SUPABASE_PUBLISHABLE_KEY: supabasePublishableKey } = env;
  if (supabaseUrl && supabasePublishableKey)
    return createSupabaseAuth({ supabaseUrl, supabasePublishableKey });
  if (opts.localDev) {
    // Dev auth is NO auth — any caller can mint `dev.<base64url({id})>.dev`
    // for any user id. `isLocalDev` keys off a *storage* variable
    // (SUPABASE_STORAGE_BUCKET), so a deploy that configures other platform
    // backing but forgets that one var would otherwise serve dev auth
    // against real stores, letting any internet caller read any user's
    // stored key. A production marker alongside "local dev" is a
    // misconfiguration: fail boot loudly unless local dev is EXPLICIT
    // (AAI_LOCAL_DEV=1 is user intent, e.g. pointing dev at a real
    // database on purpose).
    const markers = ["SUPABASE_DB_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL"] as const;
    const present = markers.filter((k) => env[k]);
    if (present.length > 0 && env.AAI_LOCAL_DEV !== "1") {
      throw new Error(
        `Refusing no-auth dev tokens: ${present.join(", ")} configured but Supabase auth is not ` +
          "(SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY). Set both, or set AAI_LOCAL_DEV=1 for local dev.",
      );
    }
    return createDevAuth();
  }
}
