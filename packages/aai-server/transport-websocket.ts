// Copyright 2025 the AAI authors. MIT license.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { AGENT_CSP } from "@alexkroman1/aai";
import { HTTPException } from "hono/http-exception";
import mime from "mime-types";
import type { AppContext } from "./context.ts";
import { SafePathSchema } from "./schemas.ts";

// Lazily resolve the default client directory from aai-ui
let _defaultClientDir: string | undefined;
function getDefaultClientDir(): string {
  if (!_defaultClientDir) {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@alexkroman1/aai-ui/package.json");
    _defaultClientDir = path.join(path.dirname(pkgPath), "dist", "default-client");
  }
  return _defaultClientDir;
}

// The default-client bundle ships with the server build and is immutable for
// the process lifetime, so memoize successful reads to avoid hitting the
// filesystem on every asset request. Misses are NOT cached: during parallel
// build+test runs (turbo) the file may be written after the first read, and
// caching null would permanently shadow it.
const defaultClientCache = new Map<string, string>();

async function readDefaultClientFile(relPath: string): Promise<string | null> {
  const cached = defaultClientCache.get(relPath);
  if (cached !== undefined) return cached;
  const baseDir = getDefaultClientDir();
  const fullPath = path.join(baseDir, relPath);
  // Prevent path traversal
  if (!fullPath.startsWith(baseDir)) return null;
  let content: string;
  try {
    content = await readFile(fullPath, "utf-8");
  } catch {
    return null;
  }
  defaultClientCache.set(relPath, content);
  return content;
}

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
  const page = await c.env.store.getClientFile(slug, "index.html");
  if (page) return c.html(page, 200, { "Content-Security-Policy": AGENT_CSP });

  // No custom client deployed — serve the default aai-ui
  const manifest = await c.env.store.getManifest(slug);
  if (!manifest) throw new HTTPException(404, { message: "HTML not found" });
  const html = await readDefaultClientFile("index.html");
  if (!html) throw new HTTPException(500, { message: "Default client not built" });
  return c.html(html, 200, { "Content-Security-Policy": AGENT_CSP });
}

export async function handleClientAsset(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  // biome-ignore lint/style/noNonNullAssertion: path param guaranteed by route
  const rawPath = c.req.param("path")!;
  const parsed = SafePathSchema.safeParse(rawPath);
  if (!parsed.success) throw new HTTPException(400, { message: "Invalid asset path" });

  const assetPath = parsed.data;

  const serveAsset = (body: string) => {
    const contentType = mime.lookup(assetPath) || "application/octet-stream";
    return c.body(body, 200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  };

  // Try deployed client assets first
  const content = await c.env.store.getClientFile(slug, `assets/${assetPath}`);
  if (content) return serveAsset(content);

  // Fall back to default client assets
  const defaultAsset = await readDefaultClientFile(`assets/${assetPath}`);
  if (defaultAsset) return serveAsset(defaultAsset);

  throw new HTTPException(404, { message: "Asset not found" });
}
