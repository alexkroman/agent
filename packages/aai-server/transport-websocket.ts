// Copyright 2025 the AAI authors. MIT license.

import { createRequire } from "node:module";
import path from "node:path";
import { AGENT_CSP, isTextAssetPath } from "@alexkroman1/aai";
import { HTTPException } from "hono/http-exception";
import mime from "mime-types";
import { createCachedDirReader } from "./_static-files.ts";
import type { AppContext } from "./context.ts";
import { SafePathSchema } from "./schemas.ts";

let _defaultClientDir: string | undefined;
function getDefaultClientDir(): string {
  if (!_defaultClientDir) {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@alexkroman1/aai-ui/package.json");
    _defaultClientDir = path.join(path.dirname(pkgPath), "dist", "default-client");
  }
  return _defaultClientDir;
}

// Cached, containment-checked reads over aai-ui's built default client.
// Cached Buffers are served as bytes — no per-request UTF-8 round trip.
const readDefaultClient = createCachedDirReader(getDefaultClientDir);

export async function handleAgentHealth(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  const manifest = await c.env.store.getManifest(slug);
  if (!manifest) {
    throw new HTTPException(404, { message: `Not found: ${slug}` });
  }
  return c.json({ status: "ok", slug });
}

export async function handleAgentPage(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  const cspHeaders = { "Content-Security-Policy": AGENT_CSP };

  const page = await c.env.store.getClientFile(slug, "index.html");
  if (page) return c.html(page, 200, cspHeaders);

  const manifest = await c.env.store.getManifest(slug);
  if (!manifest) throw new HTTPException(404, { message: "HTML not found" });
  const html = await readDefaultClient("index.html");
  if (!html) throw new HTTPException(500, { message: "Default client not built" });
  return c.body(new Uint8Array(html), 200, {
    ...cspHeaders,
    "Content-Type": "text/html; charset=UTF-8",
  });
}

/**
 * `GET /:slug/favicon.ico` — the icon the default client's page links
 * relatively (`./favicon.ico`). A custom client that shipped its own
 * favicon wins; otherwise the one bundled with aai-ui's default client
 * is served (it ships in `dist/default-client` via the Vite public dir).
 */
export async function handleAgentFavicon(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  const headers = {
    "Content-Type": "image/x-icon",
    "Cache-Control": "public, max-age=86400",
  };

  // Stored deployed favicons are binary, so the bundler base64-encoded them
  // (isTextAssetPath — same contract as handleClientAsset).
  const stored = await c.env.store.getClientFile(slug, "favicon.ico");
  if (stored !== null) return c.body(Buffer.from(stored, "base64"), 200, headers);

  const fallback = await readDefaultClient("favicon.ico");
  if (!fallback) throw new HTTPException(404, { message: "Favicon not found" });
  return c.body(new Uint8Array(fallback), 200, headers);
}

export async function handleClientAsset(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  // biome-ignore lint/style/noNonNullAssertion: path param guaranteed by route
  const rawPath = c.req.param("path")!;
  const parsed = SafePathSchema.safeParse(rawPath);
  if (!parsed.success) throw new HTTPException(400, { message: "Invalid asset path" });

  const assetPath = parsed.data;
  const relPath = `assets/${assetPath}`;
  const headers = {
    "Content-Type": mime.lookup(assetPath) || "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
  };

  // User-deployed assets: binary files are stored base64-encoded (the bundler
  // uses the same isTextAssetPath heuristic); decode them back to bytes.
  const stored = await c.env.store.getClientFile(slug, relPath);
  if (stored !== null) {
    const body = isTextAssetPath(assetPath) ? stored : Buffer.from(stored, "base64");
    return c.body(body, 200, headers);
  }

  // Default client assets served straight from the cached Buffers (the
  // shipped client is JS/CSS/HTML only).
  const fallback = await readDefaultClient(relPath);
  if (!fallback) throw new HTTPException(404, { message: "Asset not found" });
  return c.body(new Uint8Array(fallback), 200, headers);
}
