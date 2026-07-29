// Copyright 2025 the AAI authors. MIT license.
/**
 * Serves the studio's React client — the `aai-studio-client` workspace
 * package's Vite build output (`pnpm --filter aai-studio-client build`),
 * resolved the same way the default agent client resolves from aai-ui
 * (see transport-websocket.ts).
 *
 * `GET /` returns the app shell; hashed assets are served under
 * `/studio-assets/` (a reserved slug, so no agent route can shadow them).
 * When the client has not been built (fresh checkout unit tests, partial
 * self-hosted setups) a minimal fallback page explains how to build it.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { HTTPException } from "hono/http-exception";
import mime from "mime-types";
import { createCachedDirReader } from "../_static-files.ts";
import type { AppContext } from "../context.ts";
import { SafePathSchema } from "../schemas.ts";

/**
 * All assets are same-origin; scripts are external files (no inline JS).
 * `frame-src 'self'` lets the studio preview deployed agents in an iframe;
 * `font-src 'self'` serves the self-hosted brand fonts.
 */
const STUDIO_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; img-src 'self' data:; frame-src 'self'; font-src 'self'; " +
  "base-uri 'none'; form-action 'none'";

const FALLBACK_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>AssemblyAI App Builder</title></head>
<body style="font-family:sans-serif;max-width:40rem;margin:4rem auto;line-height:1.5">
<h1>AssemblyAI App Builder</h1>
<p>The App Builder client has not been built on this server.</p>
<p>Run <code>pnpm --filter aai-studio-client build</code> and restart, then
reload this page to use the browser coding agent.</p>
</body></html>`;

let _clientDir: string | undefined;
/** The aai-studio-client package's Vite build output. */
function clientDir(): string {
  if (!_clientDir) {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("aai-studio-client/package.json");
    _clientDir = path.join(path.dirname(pkgPath), "dist");
  }
  return _clientDir;
}

// Cached, containment-checked reads over the studio client build.
const readClientFile = createCachedDirReader(clientDir);

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
