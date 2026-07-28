// Copyright 2025 the AAI authors. MIT license.

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { HonoEnv } from "./context.ts";
import { VALID_SLUG_RE } from "./schemas.ts";
import { hashApiKey, verifySlugOwner } from "./secrets.ts";
import type { BundleStore } from "./store-types.ts";

function requireBearerToken(req: Request): string {
  const header = req.headers.get("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    throw new HTTPException(401, {
      message: "Missing Authorization header (Bearer <API_KEY>)",
    });
  }
  return token;
}

export function validateSlug(slug: string): string {
  if (!VALID_SLUG_RE.test(slug)) {
    throw new HTTPException(400, { message: "Invalid slug" });
  }
  return slug;
}

export async function requireOwner(
  req: Request,
  opts: { slug: string; store: BundleStore; allowUnclaimed?: boolean },
): Promise<{ apiKey: string; keyHash: string }> {
  const apiKey = requireBearerToken(req);
  const result = await verifySlugOwner(apiKey, { slug: opts.slug, store: opts.store });
  if (result.status === "forbidden") {
    throw new HTTPException(403, { message: "Forbidden" });
  }
  if (result.status === "unclaimed") {
    // An `unclaimed` slug has no manifest — only the deploy path (which
    // claims it) may proceed. Data routes (kv/vector/secret) must reject it,
    // otherwise any authenticated caller could pre-seed state for a slug they
    // don't own and have the eventual owner silently inherit it.
    if (!opts.allowUnclaimed) {
      throw new HTTPException(404, { message: `Agent ${opts.slug} not found` });
    }
    // Deploy-claim path: compute the hash lazily, only once we know the
    // caller may proceed — verifySlugOwner no longer burns ~100ms of
    // fresh-salt PBKDF2 on every request for a nonexistent slug.
    return { apiKey, keyHash: await hashApiKey(apiKey) };
  }
  return { apiKey, keyHash: result.keyHash };
}

/** Authenticates the bearer token without checking slug ownership (e.g. new deploys). */
export async function requireAuth(req: Request): Promise<{ apiKey: string; keyHash: string }> {
  const apiKey = requireBearerToken(req);
  const keyHash = await hashApiKey(apiKey);
  return { apiKey, keyHash };
}

export const slugMw = createMiddleware<HonoEnv>(async (c, next) => {
  // biome-ignore lint/style/noNonNullAssertion: slug param guaranteed by route pattern
  c.set("slug", validateSlug(c.req.param("slug")!));
  await next();
});

/**
 * Ownership for the deploy route: an unclaimed slug is allowed through so a
 * first deploy can claim it.
 */
export const ownerMw = createMiddleware<HonoEnv>(async (c, next) => {
  const { apiKey, keyHash } = await requireOwner(c.req.raw, {
    slug: c.var.slug,
    store: c.env.store,
    allowUnclaimed: true,
  });
  c.set("apiKey", apiKey);
  c.set("keyHash", keyHash);
  await next();
});

/**
 * Ownership for data/secret routes: requires the slug to already exist and be
 * owned by the caller. Rejects unclaimed slugs (see requireOwner).
 */
export const existingOwnerMw = createMiddleware<HonoEnv>(async (c, next) => {
  const { apiKey, keyHash } = await requireOwner(c.req.raw, {
    slug: c.var.slug,
    store: c.env.store,
  });
  c.set("apiKey", apiKey);
  c.set("keyHash", keyHash);
  await next();
});

export const authMw = createMiddleware<HonoEnv>(async (c, next) => {
  const { apiKey, keyHash } = await requireAuth(c.req.raw);
  c.set("apiKey", apiKey);
  c.set("keyHash", keyHash);
  await next();
});
