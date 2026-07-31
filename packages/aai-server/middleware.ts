// Copyright 2025 the AAI authors. MIT license.

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { parseBearer } from "./_bearer.ts";
import type { HonoEnv } from "./context.ts";
import { RESERVED_SLUGS, VALID_SLUG_RE } from "./schemas.ts";
import { verifySlugOwner } from "./secrets.ts";
import type { BundleStore } from "./store-types.ts";

function requireBearerToken(req: Request): string {
  const token = parseBearer(req.headers.get("Authorization"));
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
  // Reserved names shadow platform routes (e.g. /studio). No agent can ever
  // exist there, so report the same 404 an unknown agent would get.
  if (RESERVED_SLUGS.has(slug)) {
    throw new HTTPException(404, { message: `Not found: ${slug}` });
  }
  return slug;
}

export async function requireOwner(
  req: Request,
  opts: { slug: string; store: BundleStore },
): Promise<{ apiKey: string }> {
  const apiKey = requireBearerToken(req);
  const result = await verifySlugOwner(apiKey, { slug: opts.slug, store: opts.store });
  if (result.status === "forbidden") {
    throw new HTTPException(403, { message: "Forbidden" });
  }
  if (result.status === "unclaimed") {
    // An `unclaimed` slug has no manifest — only the deploy path (which
    // claims it) may proceed. Data routes (vector/secret/storage) must reject it,
    // otherwise any authenticated caller could pre-seed state for a slug they
    // don't own and have the eventual owner silently inherit it.
    throw new HTTPException(404, { message: `Agent ${opts.slug} not found` });
  }
  return { apiKey };
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
  const { apiKey } = await requireOwner(c.req.raw, {
    slug: c.var.slug,
    store: c.env.store,
  });
  c.set("apiKey", apiKey);
  await next();
});

/**
 * Authenticates the bearer token without checking slug ownership
 * (`POST /deploy`, where the slug may not exist yet). Deliberately computes
 * no keyHash: a fresh-salt `hashApiKey` is an uncacheable argon2 derivation
 * on every request, so the deploy core resolves ownership through the
 * cacheable verify path and hashes only when the slug is genuinely
 * unclaimed (mirroring `requireOwner`'s lazy hash for `/:slug` routes).
 */
export const authMw = createMiddleware<HonoEnv>(async (c, next) => {
  c.set("apiKey", requireBearerToken(c.req.raw));
  await next();
});
