// Copyright 2025 the AAI authors. MIT license.

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { hashApiKey, verifySlugOwner } from "./auth.ts";
import type { Env } from "./context.ts";
import { VALID_SLUG_RE } from "./schemas.ts";
import { isPrivateIp } from "./ssrf.ts";
import type { BundleStore } from "./store-types.ts";

function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7) || null;
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
): Promise<string> {
  const apiKey = bearerToken(req);
  if (!apiKey) {
    throw new HTTPException(401, {
      message: "Missing Authorization header (Bearer <API_KEY>)",
    });
  }
  const result = await verifySlugOwner(apiKey, { slug: opts.slug, store: opts.store });
  if (result.status === "forbidden") {
    // Generic message to avoid confirming slug existence to unauthorized users
    throw new HTTPException(403, {
      message: "Forbidden",
    });
  }
  return result.keyHash;
}

/**
 * Authenticate the request without checking slug ownership.
 * Used for routes where the slug may not exist yet (e.g. new deploys).
 */
export async function requireAuth(req: Request): Promise<string> {
  const apiKey = bearerToken(req);
  if (!apiKey) {
    throw new HTTPException(401, {
      message: "Missing Authorization header (Bearer <API_KEY>)",
    });
  }
  return hashApiKey(apiKey);
}

export function requireUpgrade(req: Request): void {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new HTTPException(400, { message: "Expected WebSocket upgrade" });
  }
}

/**
 * Require that the request originates from a private/internal IP.
 *
 * Checks proxy-set headers (CF-Connecting-IP, Fly-Client-IP) first, then
 * falls back to the TCP socket remote address. The proxy headers are only
 * trustworthy when running behind Cloudflare or Fly.io — in other
 * environments, the socket address provides the ground truth.
 */
export function requireInternal(req: Request): void {
  const proxyIp = req.headers.get("cf-connecting-ip") ?? req.headers.get("fly-client-ip");
  // Prefer socket remote address when available (not spoofable).
  // @ts-expect-error -- Node/Bun Request extensions may carry socket info
  const socketIp: string | undefined = req.socket?.remoteAddress;
  const ip = socketIp ?? proxyIp ?? "";
  if (!(ip && isPrivateIp(ip))) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
}

/** Sets `c.var.slug` from the `:slug` route param. */
export const slugMw = createMiddleware<Env>(async (c, next) => {
  // biome-ignore lint/style/noNonNullAssertion: slug param guaranteed by route pattern
  c.set("slug", validateSlug(c.req.param("slug")!));
  await next();
});

/** Verifies the Bearer token owns the slug and sets `c.var.keyHash`. */
export const ownerMw = createMiddleware<Env>(async (c, next) => {
  const keyHash = await requireOwner(c.req.raw, {
    slug: c.var.slug,
    store: c.env.store,
  });
  c.set("keyHash", keyHash);
  await next();
});

/**
 * Authenticates the Bearer token without checking slug ownership.
 * Used for routes where the slug may not exist yet (new deploys).
 * Sets `c.var.keyHash`.
 */
export const authMw = createMiddleware<Env>(async (c, next) => {
  c.set("keyHash", await requireAuth(c.req.raw));
  await next();
});
