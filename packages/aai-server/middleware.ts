// Copyright 2025 the AAI authors. MIT license.

import { omitUndefined } from "@alexkroman1/aai";
import { parseBearer } from "@alexkroman1/aai-runtime/internal";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { bearerFailureMessage } from "./_bearer.ts";
import { TtlCache } from "./_ttl-cache.ts";
import type { ApiKeyVerifier } from "./api-key-verify.ts";
import type { HonoEnv } from "./context.ts";
import { RESERVED_SLUGS, VALID_SLUG_RE } from "./schemas.ts";
import type { SecretStore } from "./secret-store.ts";
import { verifySlugOwner } from "./secrets.ts";
import type { BundleStore } from "./store-types.ts";
import {
  apiKeyOwnerSecretName,
  isJwtShaped,
  type StudioAuth,
  type StudioAuthUser,
  userApiKeySecretName,
} from "./supabase-auth.ts";

function requireBearerToken(req: Request): string {
  const header = req.headers.get("Authorization");
  const token = parseBearer(header);
  if (!token) {
    // MISSING and MALFORMED are different failures and used to share one
    // sentence, so a present, well-formed header was answered "Missing
    // Authorization header" — see `bearerFailureMessage`.
    throw new HTTPException(401, { message: bearerFailureMessage(header) });
  }
  return token;
}

export type ResolvedBearer = { apiKey: string; userId?: string };

/**
 * A per-`SecretStore` TTL cache, created on first use.
 *
 * A WeakMap so tests' independent memory stores cannot see each other's
 * entries, and so a discarded store's cache goes with it. Both Vault lookups
 * below wanted exactly this and had written it out twice, byte for byte apart
 * from the variable names — which is how the two would have drifted on TTL or
 * on the WeakMap's own semantics without anything pointing at the divergence.
 */
function secretScopedCache(ttlMs: number): {
  for(secrets: SecretStore): TtlCache<string>;
  drop(secrets: SecretStore, key: string): void;
} {
  const caches = new WeakMap<SecretStore, TtlCache<string>>();
  return {
    for(secrets) {
      let cache = caches.get(secrets);
      if (!cache) {
        cache = new TtlCache<string>(ttlMs);
        caches.set(secrets, cache);
      }
      return cache;
    },
    // Never CREATES a cache: an invalidation for a store nothing has read from
    // has nothing to drop, and materializing one there would leak an entry per
    // store that only ever wrote.
    drop(secrets, key) {
      caches.get(secrets)?.delete(key);
    },
  };
}

// The user-id → stored-API-key lookup rides EVERY JWT-authed request (each
// editor save, project GET, SSE subscribe), and each lookup is a Vault query
// — a Postgres round trip plus server-side decrypt. Cache it beside the
// token-verify cache with the same short TTL. Only found keys are cached: a
// "no key yet" account is the onboarding path, where a stale negative would
// 401 the first request after the key is saved. Rotation is bounded by the TTL
// on other replicas and exact on the writing one (`invalidateUserApiKey` from
// the account route).
const USER_KEY_TTL_MS = 60_000;
const userKeyCaches = secretScopedCache(USER_KEY_TTL_MS);

/** Drop a user's cached API key — call after storing a new one. */
export function invalidateUserApiKey(secrets: SecretStore, userId: string): void {
  userKeyCaches.drop(secrets, userId);
}

// Reverse lookup for RAW-key bearers: which studio user owns this key
// (`key-user:<sha256(key)>`, written by the account route and by the
// `aai login` approval)? It rides every CLI request,
// so it is cached like the user→key lookup above — including negatives ("")
// since most raw keys (evals, programmatic callers, pre-login CLIs) have no
// owner and would otherwise pay a Vault round trip per request. A stale
// negative costs at most TTL of key-derived scoping right after onboarding;
// the account route invalidates the writing replica exactly.
const keyOwnerCaches = secretScopedCache(USER_KEY_TTL_MS);

/** Drop a key's cached owner — call after storing a new key mapping. */
export function invalidateApiKeyOwner(secrets: SecretStore, apiKey: string): void {
  keyOwnerCaches.drop(secrets, apiKeyOwnerSecretName(apiKey));
}

/** The studio user id that stored `apiKey` as their account key, if any. */
async function lookupApiKeyOwner(
  secrets: SecretStore,
  apiKey: string,
): Promise<string | undefined> {
  const cache = keyOwnerCaches.for(secrets);
  // Cache keys are the hashed secret name — never the raw credential.
  const name = apiKeyOwnerSecretName(apiKey);
  let owner = cache.get(name);
  if (owner === undefined) {
    owner = (await secrets.get(name)) ?? "";
    cache.set(name, owner);
  }
  return owner === "" ? undefined : owner;
}

/**
 * Reject a raw bearer that AssemblyAI does not recognize.
 *
 * This is the platform's ONLY absolute authentication check. Everything after
 * it is relative — `verifySlugOwner` asks whether a bearer matches a hash on
 * one agent's row, which is a real authorization check and says nothing about
 * whether the bearer is a credential at all. Without this, the routes in
 * front of ownership (deploy, which CLAIMS an unclaimed slug; the studio's
 * project-create and session-broker, which key their scope off the bearer)
 * were reachable with an arbitrary string.
 *
 * An unreachable verifier is a 503, never a pass: see the module note in
 * api-key-verify.ts for why "fail open so an AssemblyAI outage can't take us
 * with it" reopens the hole for the duration of any outage that can be
 * provoked or waited for.
 */
async function assertVerifiedApiKey(
  token: string,
  verifier: ApiKeyVerifier | undefined,
): Promise<void> {
  if (!verifier) return;
  let valid: boolean;
  try {
    valid = await verifier(token);
  } catch (err) {
    throw new HTTPException(503, {
      message: "Could not verify the API key right now — retry shortly",
      cause: err,
    });
  }
  if (!valid) {
    throw new HTTPException(401, { message: "Invalid API key" });
  }
}

/**
 * Resolve the request's bearer to a platform API key.
 *
 * Two bearer forms arrive on the same routes: raw API keys (the `aai` CLI,
 * and the in-guest `aai deploy` Publish runs) pass through unchanged, while
 * JWT-shaped bearers — Supabase sessions from the browser studio — are
 * verified against Supabase and mapped to the user's stored AssemblyAI key
 * (`user-key:<uid>`), so every downstream consumer (ownership hashes, the
 * gateway LLM, deploy env seeding) sees the real key either way.
 *
 * Raw keys additionally resolve a `userId` when some account owns the key
 * (the `key-user:` reverse mapping) — that is what puts a
 * linked CLI in the same studio scope as the browser session. An unmapped
 * key keeps its own key-derived scope.
 */
export async function resolveBearer(
  req: Request,
  env: {
    auth?: StudioAuth | undefined;
    secrets: SecretStore;
    keyVerifier?: ApiKeyVerifier | undefined;
  },
): Promise<ResolvedBearer> {
  const token = requireBearerToken(req);
  if (!(env.auth && isJwtShaped(token))) {
    await assertVerifiedApiKey(token, env.keyVerifier);
    const userId = await lookupApiKeyOwner(env.secrets, token);
    return { apiKey: token, ...omitUndefined({ userId }) };
  }
  const user = await env.auth.verifyAccessToken(token);
  if (!user) {
    throw new HTTPException(401, { message: "Invalid or expired session — sign in again" });
  }
  const cache = userKeyCaches.for(env.secrets);
  let apiKey = cache.get(user.id);
  if (apiKey === undefined) {
    const stored = await env.secrets.get(userApiKeySecretName(user.id));
    if (!stored) {
      throw new HTTPException(401, {
        message: "No AssemblyAI API key on file for this account — add one in the studio",
      });
    }
    apiKey = stored;
    cache.set(user.id, stored);
  }
  return { apiKey, userId: user.id };
}

/**
 * Authenticate a browser session WITHOUT requiring a stored API key — the
 * account routes are how the key gets set in the first place, so they can't
 * demand one. Raw API-key bearers are rejected: an account is a
 * browser-session concept, and a key has no user to attach one to.
 */
export async function requireStudioUser(
  req: Request,
  env: { auth?: StudioAuth | undefined },
): Promise<StudioAuthUser> {
  if (!env.auth) {
    throw new HTTPException(401, { message: "Browser login is not configured on this server" });
  }
  const token = requireBearerToken(req);
  if (!isJwtShaped(token)) {
    throw new HTTPException(401, { message: "Account routes require a browser session" });
  }
  // The FRESH verification, unlike the request path's: these routes read and
  // rotate the account's AssemblyAI key and grant a CLI one exchange for it,
  // so a session the user has since signed out of must not still spend it.
  // A signature check cannot see that — a revoked token stays valid until
  // `exp` — and three low-traffic routes can afford the round trip.
  const user = await env.auth.verifyAccessTokenFresh(token);
  if (!user) {
    throw new HTTPException(401, { message: "Invalid or expired session — sign in again" });
  }
  return user;
}

export function validateSlug(slug: string): string {
  if (!VALID_SLUG_RE.test(slug)) {
    throw new HTTPException(400, { message: "Invalid slug" });
  }
  // Reserved names shadow platform routes (e.g. /studio). No agent can ever
  // exist there, so report the same 404 an unknown agent would get.
  if (RESERVED_SLUGS.has(slug)) {
    throw new HTTPException(404, { message: `Not found: ${slug}` });
  }
  return slug;
}

export async function requireOwner(
  req: Request,
  opts: {
    slug: string;
    store: BundleStore;
    secrets: SecretStore;
    auth?: StudioAuth | undefined;
    keyVerifier?: ApiKeyVerifier | undefined;
  },
): Promise<ResolvedBearer> {
  const resolved = await resolveBearer(req, {
    auth: opts.auth,
    secrets: opts.secrets,
    keyVerifier: opts.keyVerifier,
  });
  const result = await verifySlugOwner(resolved.apiKey, { slug: opts.slug, store: opts.store });
  // `forbidden` (the slug is claimed by someone else) and `unclaimed` (no agent
  // record) both answer the SAME 404. A distinct 403 would tell any
  // authenticated caller which slugs are claimed — an existence oracle over the
  // whole namespace — and the data routes have nothing an owner-only 403 buys a
  // legitimate caller: their own slug resolves `owned`. `unclaimed` must reject
  // for its own reason too (only the deploy path may claim a slug; otherwise a
  // caller could pre-seed state a later owner silently inherits), so the two
  // collapse into one indistinguishable answer.
  if (result.status !== "owned") {
    throw new HTTPException(404, { message: `Agent ${opts.slug} not found` });
  }
  return resolved;
}

export const slugMw = createMiddleware<HonoEnv>(async (c, next) => {
  // biome-ignore lint/style/noNonNullAssertion: slug param guaranteed by route pattern
  c.set("slug", validateSlug(c.req.param("slug")!));
  await next();
});

/**
 * Ownership for data/secret routes: requires the slug to already exist and be
 * owned by the caller. Rejects unclaimed slugs (see requireOwner).
 */
export const existingOwnerMw = createMiddleware<HonoEnv>(async (c, next) => {
  const { apiKey, userId } = await requireOwner(c.req.raw, {
    slug: c.var.slug,
    store: c.env.store,
    secrets: c.env.secrets,
    auth: c.env.auth,
    keyVerifier: c.env.keyVerifier,
  });
  c.set("apiKey", apiKey);
  if (userId) c.set("userId", userId);
  await next();
});

/**
 * Authenticates the bearer token without checking slug ownership
 * (`POST /deploy`, where the slug may not exist yet); the deploy core
 * resolves ownership itself under the slug lock.
 */
export const authMw = createMiddleware<HonoEnv>(async (c, next) => {
  const { apiKey, userId } = await resolveBearer(c.req.raw, {
    auth: c.env.auth,
    secrets: c.env.secrets,
    keyVerifier: c.env.keyVerifier,
  });
  c.set("apiKey", apiKey);
  if (userId) c.set("userId", userId);
  await next();
});
