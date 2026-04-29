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
  opts: { slug: string; store: BundleStore },
): Promise<{ apiKey: string; keyHash: string }> {
  const apiKey = requireBearerToken(req);
  const result = await verifySlugOwner(apiKey, { slug: opts.slug, store: opts.store });
  if (result.status === "forbidden") {
    throw new HTTPException(403, { message: "Forbidden" });
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

export const ownerMw = createMiddleware<HonoEnv>(async (c, next) => {
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
