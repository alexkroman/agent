// Copyright 2025 the AAI authors. MIT license.

import { isPrivateIp } from "@alexkroman1/aai/ssrf";
import { HTTPException } from "hono/http-exception";
import { verifySlugOwner } from "./auth.ts";
import type { BundleStore } from "./bundle-store.ts";

const VALID_SLUG_REGEXP = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/;

function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7) || null;
}

export function validateSlug(slug: string): string {
  if (!VALID_SLUG_REGEXP.test(slug)) {
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
