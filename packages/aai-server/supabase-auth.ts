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
 * `createDevAuth` accepts self-describing `dev.<base64url({id,email})>.dev`
 * tokens the login screen mints client-side, so a server with NO Supabase at all
 * still exercises the same middleware, key onboarding, and scoping as real
 * sessions. It is reachable only on a run that has no platform database and
 * declares `AAI_LOCAL_DEV=1`; the moment platform state is in Supabase, identity
 * is too (see {@link createStudioAuthFromEnv}). The local stack runs GoTrue, so
 * "local" no longer implies "no real auth" — `supabase/README.md` carries the
 * GitHub OAuth app the local callback needs.
 */

import { hash } from "node:crypto";
import { GoTrueClient, isAuthRetryableFetchError } from "@supabase/auth-js";
import { hasPlatformDb, isLocalDev } from "./_boot.ts";
import { TtlCache } from "./_ttl-cache.ts";
import { isUnavailableStatus, PlatformServiceUnavailableError } from "./platform-service-errors.ts";

/**
 * The `service` every unavailability from this module carries, so a log line
 * says which dependency was down without the reader parsing the message.
 */
const AUTH_SERVICE = "supabase-auth";

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

/**
 * `{ id, email? }` from an untrusted body, or null when it names no subject.
 *
 * Three sites read the same two fields out of three different shapes — JWT
 * claims (`sub`), the Auth server's user JSON (`id`), and a dev token's payload
 * — and each had written both guards plus the optional-email spread by hand.
 * The rules are the contract, not an incidental: an empty subject is NOT an
 * identity, and an empty email is absent rather than `""`.
 */
function studioUser(id: unknown, email: unknown): StudioAuthUser | null {
  if (typeof id !== "string" || id.length === 0) return null;
  return { id, ...(typeof email === "string" && email ? { email } : {}) };
}

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

  /**
   * How long a verified token may be SERVED from cache: the flat TTL, capped
   * at the token's own expiry.
   *
   * `getClaims` validates `exp` and rejects an expired token — but only on a
   * cache miss, so a flat TTL means a token cached one second before it
   * expires stays accepted for the rest of the minute. Capping here is what
   * makes this path's bound the token's lifetime OR the TTL, rather than
   * their sum.
   *
   * Claims with no readable `exp` fall back to the flat TTL: a token that
   * never expires is Supabase's business, not this cache's.
   */
  const cacheTtlFor = (claims: { exp?: unknown }): number => {
    if (typeof claims.exp !== "number") return VERIFY_TTL_MS;
    return Math.max(0, Math.min(VERIFY_TTL_MS, claims.exp * 1000 - Date.now()));
  };

  const verifyFresh = async (token: string): Promise<StudioAuthUser | null> => {
    const res = await doFetch(`${base}/auth/v1/user`, {
      headers: { apikey: opts.supabasePublishableKey, Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) {
      // Supabase being down is a 5xx to the caller, not a silent sign-out:
      // fail closed but distinguishably from "your session expired".
      //
      // And 503 rather than 500 when the status says "not now", because it is
      // GoTrue that is unavailable and not us. Production answered
      // `500 Internal server error` on `/studio/account` while GoTrue returned
      // 500 for want of a database connection — so the one route that reports
      // who you are told a signed-in user the platform was broken, beside
      // sibling routes correctly answering 503 for the same root cause. A 4xx
      // stays a 500 deliberately: it will fail identically on retry.
      const message = `Supabase auth verification failed (HTTP ${res.status})`;
      throw isUnavailableStatus(res.status)
        ? new PlatformServiceUnavailableError(AUTH_SERVICE, message)
        : new Error(message);
    }
    const body = (await res.json().catch(() => null)) as {
      id?: unknown;
      email?: unknown;
    } | null;
    return body ? studioUser(body.id, body.email) : null;
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
          // gotrue-js's own name for "the request never completed", so no
          // guessing is needed — and the same answer as the 5xx above.
          throw new PlatformServiceUnavailableError(
            AUTH_SERVICE,
            `Supabase auth verification failed: ${error.message}`,
            { cause: error },
          );
        }
        cache.set(cacheKey, null);
        return null;
      }
      const user = data ? studioUser(data.claims.sub, data.claims.email) : null;
      // A REJECTION keeps the flat TTL — there is no `exp` to read from a
      // token that did not verify, and re-verifying a bad token every minute
      // is the behaviour that was wanted anyway.
      cache.set(cacheKey, user, data ? { ttlMs: cacheTtlFor(data.claims) } : undefined);
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
    return studioUser(body.id, body.email);
  } catch {
    return null;
  }
}

/**
 * Local-dev auth: trusts self-describing dev tokens. NO authentication at
 * all — anyone who can reach the (loopback-bound) dev server can claim any
 * identity. Only `buildServiceConfig` may construct it, and only on a run with
 * no platform database whatsoever, so there is nothing durable behind the
 * identity it hands out.
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
 * Build the auth binding from `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY`,
 * falling back to dev auth ONLY on a run with no platform database at all.
 * Undefined (no auth configured, no platform database, no local-dev
 * declaration) leaves raw-key bearers working and the studio login
 * unconfigured.
 *
 * **A platform database refuses dev tokens outright, with no escape hatch.**
 * Dev auth is NO auth — any caller can mint `dev.<base64url({id})>.dev` for any
 * user id — and `user-key:<uid>` is where every account's AssemblyAI key lives,
 * so serving it against real stores lets any caller who can reach the port read
 * any user's key. That used to be reachable deliberately, via `AAI_LOCAL_DEV=1`,
 * on the reasoning that pointing a dev server at a real database is user intent.
 * It is — and the tier that intent selects now includes real Supabase Auth,
 * which is the whole point of the local stack running GoTrue. So the escape is
 * gone: if state is in Supabase, identity is too.
 */
export function createStudioAuthFromEnv(env: NodeJS.ProcessEnv): StudioAuth | undefined {
  const { SUPABASE_URL: supabaseUrl, SUPABASE_PUBLISHABLE_KEY: supabasePublishableKey } = env;
  if (supabaseUrl && supabasePublishableKey)
    return createSupabaseAuth({ supabaseUrl, supabasePublishableKey });
  if (hasPlatformDb(env)) {
    throw new Error(
      "SUPABASE_DB_URL is set but Supabase auth is not (SUPABASE_URL + " +
        "SUPABASE_PUBLISHABLE_KEY). Refusing to serve no-auth dev tokens against real stores: " +
        "any caller could then claim any user id and read that account's stored AssemblyAI key. " +
        "Set both — `pnpm dev:aai-server` resolves them from the local stack — or unset " +
        "SUPABASE_DB_URL to run entirely on memory stores.",
    );
  }
  if (isLocalDev(env)) return createDevAuth();
}
