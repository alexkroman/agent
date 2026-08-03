// Copyright 2025 the AAI authors. MIT license.

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { parseBearer } from "./_bearer.ts";
import type { HonoEnv } from "./context.ts";
import { RESERVED_SLUGS, VALID_SLUG_RE } from "./schemas.ts";
import type { SecretStore } from "./secret-store.ts";
import { verifySlugOwner } from "./secrets.ts";
import type { BundleStore } from "./store-types.ts";
import {
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

/**
 * Resolve the request's bearer to a platform API key.
 *
 * Two bearer forms arrive on the same routes: raw API keys (the `aai` CLI,
 * and the in-guest `aai deploy` Publish runs) pass through unchanged, while
 * JWT-shaped bearers — Supabase sessions from the browser studio — are
 * verified against Supabase and mapped to the user's stored AssemblyAI key
 * (`user-key:<uid>`), so every downstream consumer (ownership hashes, the
 * gateway LLM, deploy env seeding) sees the real key either way.
 */
export async function resolveBearer(
  req: Request,
  env: { auth?: StudioAuth | undefined; secrets: SecretStore },
): Promise<ResolvedBearer> {
  const token = requireBearerToken(req);
  if (!(env.auth && isJwtShaped(token))) return { apiKey: token };
  const user = await env.auth.verifyAccessToken(token);
  if (!user) {
    throw new HTTPException(401, { message: "Invalid or expired session — sign in again" });
  }
  const apiKey = await env.secrets.get(userApiKeySecretName(user.id));
  if (!apiKey) {
    throw new HTTPException(401, {
      message: "No AssemblyAI API key on file for this account — add one in the studio",
    });
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
  const user = await env.auth.verifyAccessToken(token);
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
