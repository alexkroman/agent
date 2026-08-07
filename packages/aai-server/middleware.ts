// Copyright 2025 the AAI authors. MIT license.

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { parseBearer } from "./_bearer.ts";
import { TtlCache } from "./_ttl-cache.ts";
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
  const token = parseBearer(req.headers.get("Authorization"));
  if (!token) {
    throw new HTTPException(401, {
      message: "Missing Authorization header (Bearer <API_KEY>)",
    });
  }
  return token;
}

export type ResolvedBearer = { apiKey: string; userId?: string };

// The user-id → stored-API-key lookup rides EVERY JWT-authed request (each
// editor save, project GET, SSE subscribe), and each lookup is a Vault query
// — a Postgres round trip plus server-side decrypt. Cache it beside the
// token-verify cache with the same short TTL. Scoped per SecretStore (a
// WeakMap, so tests' independent memory stores can't see each other's
// entries), and only found keys are cached: a "no key yet" account is the
// onboarding path, where a stale negative would 401 the first request after
// the key is saved. Rotation is bounded by the TTL on other replicas and
// exact on the writing one (`invalidateUserApiKey` from the account route).
const USER_KEY_TTL_MS = 60_000;
const userKeyCaches = new WeakMap<SecretStore, TtlCache<string>>();

function userKeyCache(secrets: SecretStore): TtlCache<string> {
  let cache = userKeyCaches.get(secrets);
  if (!cache) {
    cache = new TtlCache<string>(USER_KEY_TTL_MS);
    userKeyCaches.set(secrets, cache);
  }
  return cache;
}

/** Drop a user's cached API key — call after storing a new one. */
export function invalidateUserApiKey(secrets: SecretStore, userId: string): void {
  userKeyCaches.get(secrets)?.delete(userId);
}

// Reverse lookup for RAW-key bearers: which studio user owns this key
// (`key-user:<sha256(key)>`, written by the account route and by the
// `aai login` approval)? It rides every CLI request,
// so it is cached like the user→key lookup above — including negatives ("")
// since most raw keys (evals, programmatic callers, pre-login CLIs) have no
// owner and would otherwise pay a Vault round trip per request. A stale
// negative costs at most TTL of key-derived scoping right after onboarding;
// the account route invalidates the writing replica exactly.
const keyOwnerCaches = new WeakMap<SecretStore, TtlCache<string>>();

function keyOwnerCache(secrets: SecretStore): TtlCache<string> {
  let cache = keyOwnerCaches.get(secrets);
  if (!cache) {
    cache = new TtlCache<string>(USER_KEY_TTL_MS);
    keyOwnerCaches.set(secrets, cache);
  }
  return cache;
}

/** Drop a key's cached owner — call after storing a new key mapping. */
export function invalidateApiKeyOwner(secrets: SecretStore, apiKey: string): void {
  keyOwnerCaches.get(secrets)?.delete(apiKeyOwnerSecretName(apiKey));
}

/** The studio user id that stored `apiKey` as their account key, if any. */
async function lookupApiKeyOwner(
  secrets: SecretStore,
  apiKey: string,
): Promise<string | undefined> {
  const cache = keyOwnerCache(secrets);
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
 * key keeps the legacy key-derived scope.
 */
export async function resolveBearer(
  req: Request,
  env: { auth?: StudioAuth | undefined; secrets: SecretStore },
): Promise<ResolvedBearer> {
  const token = requireBearerToken(req);
  if (!(env.auth && isJwtShaped(token))) {
    const userId = await lookupApiKeyOwner(env.secrets, token);
    return { apiKey: token, ...(userId ? { userId } : {}) };
  }
  const user = await env.auth.verifyAccessToken(token);
  if (!user) {
    throw new HTTPException(401, { message: "Invalid or expired session — sign in again" });
  }
  const cache = userKeyCache(env.secrets);
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
  },
): Promise<ResolvedBearer> {
  const resolved = await resolveBearer(req, { auth: opts.auth, secrets: opts.secrets });
  const result = await verifySlugOwner(resolved.apiKey, { slug: opts.slug, store: opts.store });
  if (result.status === "forbidden") {
    throw new HTTPException(403, { message: "Forbidden" });
  }
  if (result.status === "unclaimed") {
    // An `unclaimed` slug has no agent record — only the deploy path (which
    // claims it) may proceed. Data routes (secret/storage) must reject it,
    // otherwise any authenticated caller could pre-seed state for a slug they
    // don't own and have the eventual owner silently inherit it.
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
  });
  c.set("apiKey", apiKey);
  if (userId) c.set("userId", userId);
  await next();
});
