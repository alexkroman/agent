// Copyright 2026 the AAI authors. MIT license.

/**
 * Token from an `Authorization: Bearer <token>` header value.
 *
 * Returns `""` when the header is absent or not a Bearer credential — callers
 * decide what an empty token means (401, host-mode refusal, …). A plain
 * helper rather than `hono/bearer-auth` on purpose: the same parse serves
 * raw-`Request` auth (middleware.ts), hono middleware (studio-routes.ts), and
 * the WebSocket upgrade path (ws-host-mode.ts), and the hono middleware would
 * change the response shape (WWW-Authenticate, body) existing clients and
 * tests rely on.
 */
export function parseBearer(header: string | null | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}
