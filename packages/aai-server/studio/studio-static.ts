// Copyright 2025 the AAI authors. MIT license.
/**
 * Serves the studio's React client (Vite build output in
 * `dist/studio-client`, built by `pnpm --filter aai-server build`).
 *
 * `GET /` returns the app shell; hashed assets are served under
 * `/studio-assets/` (a reserved slug, so no agent route can shadow them).
 * When the client has not been built (fresh checkout unit tests, partial
 * self-hosted setups) a minimal fallback page explains how to build it.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { HTTPException } from "hono/http-exception";
import mime from "mime-types";
import type { AppContext } from "../context.ts";
import { SafePathSchema } from "../schemas.ts";

/**
 * All assets are same-origin; scripts are external files (no inline JS).
 * `frame-src 'self'` lets the studio preview deployed agents in an iframe;
 * `font-src 'self'` serves the self-hosted brand fonts.
 */
export const STUDIO_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; img-src 'self' data:; frame-src 'self'; font-src 'self'; " +
  "base-uri 'none'; form-action 'none'";

const FALLBACK_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>AssemblyAI Studio</title></head>
<body style="font-family:sans-serif;max-width:40rem;margin:4rem auto;line-height:1.5">
<h1>AssemblyAI Studio</h1>
<p>The studio client has not been built on this server.</p>
<p>Run <code>pnpm --filter aai-server build</code> and restart, then reload
this page to use the browser coding agent.</p>
</body></html>`;

/**
 * Both the dev source layout (`studio/`) and the bundled layout (`dist/`)
 * sit directly under the package root, so one relative path serves both.
 */
function clientDir(): string {
  return path.resolve(import.meta.dirname, "..", "dist", "studio-client");
}

// Content cache. Misses are NOT cached (same reasoning as the default-client
// cache in transport-websocket.ts: the build may land after the first read).
const fileCache = new Map<string, Buffer>();

async function readClientFile(relPath: string): Promise<Buffer | null> {
  const cached = fileCache.get(relPath);
  if (cached !== undefined) return cached;
  const baseDir = clientDir();
  const fullPath = path.join(baseDir, relPath);
  if (!fullPath.startsWith(baseDir)) return null;
  try {
    const content = await readFile(fullPath);
    fileCache.set(relPath, content);
    return content;
  } catch {
    return null;
  }
}

/** `GET /` — the studio app shell (or the not-built fallback). */
export async function handleStudioPage(c: AppContext): Promise<Response> {
  const headers = { "Content-Security-Policy": STUDIO_CSP };
  const html = await readClientFile("index.html");
  return c.html(html ? html.toString("utf-8") : FALLBACK_HTML, 200, headers);
}

/** `GET /studio-assets/:path{.+}` — hashed Vite build assets. */
export async function handleStudioClientAsset(c: AppContext): Promise<Response> {
  const rawPath = c.req.param("path") ?? "";
  const parsed = SafePathSchema.safeParse(rawPath);
  if (!parsed.success) throw new HTTPException(400, { message: "Invalid asset path" });
  const content = await readClientFile(parsed.data);
  if (!content) throw new HTTPException(404, { message: "Asset not found" });
  return c.body(new Uint8Array(content), 200, {
    "Content-Type": mime.lookup(parsed.data) || "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
}
