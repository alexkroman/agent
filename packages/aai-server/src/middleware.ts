// Copyright 2025 the AAI authors. MIT license.
import { HTTPException } from "hono/http-exception";
import { isPrivateIp } from "./_net.ts";
import { verifySlugOwner } from "./auth.ts";
import type { DeployStore } from "./bundle_store_tigris.ts";
import { type AgentScope, type ScopeKey, verifyScopeToken } from "./scope_token.ts";

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
  opts: { slug: string; store: DeployStore },
): Promise<string> {
  const apiKey = bearerToken(req);
  if (!apiKey) {
    throw new HTTPException(401, {
      message: "Missing Authorization header (Bearer <API_KEY>)",
    });
  }
  const result = await verifySlugOwner(apiKey, { slug: opts.slug, store: opts.store });
  if (result.status === "forbidden") {
    throw new HTTPException(403, {
      message: `Slug "${opts.slug}" is owned by another user.`,
    });
  }
  return result.keyHash;
}

export function requireUpgrade(req: Request): void {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new HTTPException(400, { message: "Expected WebSocket upgrade" });
  }
}

export function requireInternal(req: Request): void {
  // In workerd, use CF-Connecting-IP or Fly-Client-IP header
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("fly-client-ip") ?? "";
  if (!(ip && isPrivateIp(ip))) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
}

export async function requireScopeToken(req: Request, scopeKey: ScopeKey): Promise<AgentScope> {
  const token = bearerToken(req);
  if (!token) {
    throw new HTTPException(401, { message: "Missing Authorization header" });
  }
  const scope = await verifyScopeToken(scopeKey, token);
  if (!scope) {
    throw new HTTPException(403, { message: "Invalid or tampered scope token" });
  }
  return scope;
}
