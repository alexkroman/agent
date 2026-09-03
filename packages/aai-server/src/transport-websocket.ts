// Copyright 2025 the AAI authors. MIT license.

import { AGENT_CSP, isTextAssetPath } from "@alexkroman1/aai/internal";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";
import { HTTPException } from "hono/http-exception";
import mime from "mime-types";
import { createCachedDirReader } from "./_static-files.ts";
import type { AppContext } from "./context.ts";
import { SafePathSchema } from "./schemas.ts";

// Cached, containment-checked reads over aai-ui's built default client.
// Cached Buffers are served as bytes — no per-request UTF-8 round trip.
//
// `defaultClientDir` is aai-ui's own export rather than a third copy of the
// three-line `require.resolve` dance: it resolves through that package's
// manifest the same way, and turns a missing install into a message naming
// @alexkroman1/aai-ui instead of a MODULE_NOT_FOUND for a path nobody wrote.
// The memo the local copy carried is `createCachedDirReader`'s already.
const readDefaultClient = createCachedDirReader(defaultClientDir);

export async function handleAgentHealth(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  const record = await c.env.store.getAgent(slug);
  if (!record) {
    throw new HTTPException(404, { message: `Not found: ${slug}` });
  }
  return c.json({ status: "ok", slug });
}

/**
 * The agent shell must never outlive the deploy it names — the same rule the
 * studio shell follows (`aai-studio-server/studio-static.ts`), reached by a
 * different route.
 *
 * `index.html` references content-hashed assets, and `getClientFile` resolves
 * a path through the agents row's `client_files` map. A redeploy REPLACES that
 * map, so the previous build's asset paths stop resolving and 404 — the blobs
 * themselves survive (they are content-addressed and orphans are kept), but
 * nothing maps a name to them anymore. A browser holding a cached shell is
 * therefore pinned to a build whose entry script is gone: a white page, with
 * no JS running to recover from it and no stale-build reload on this surface
 * to force one.
 *
 * It carried NO cache headers at all, which is weaker than it sounds: with no
 * `Cache-Control` and no validator, a heuristically caching intermediary is
 * free to reuse it. `no-store` says it outright, and costs one small
 * revalidation-free fetch per navigation. The hashed assets under it stay
 * `immutable` — that pairing is the point.
 */
const SHELL_CACHE_CONTROL = "no-store";

export async function handleAgentPage(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  const pageHeaders = {
    "Content-Security-Policy": AGENT_CSP,
    "Cache-Control": SHELL_CACHE_CONTROL,
  };

  const page = await c.env.store.getClientFile(slug, "index.html");
  if (page) return c.html(page, 200, pageHeaders);

  const record = await c.env.store.getAgent(slug);
  if (!record) throw new HTTPException(404, { message: "HTML not found" });
  const html = await readDefaultClient("index.html");
  if (!html) throw new HTTPException(500, { message: "Default client not built" });
  return c.body(new Uint8Array(html), 200, {
    ...pageHeaders,
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
