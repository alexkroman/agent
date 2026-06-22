// Copyright 2025 the AAI authors. MIT license.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { AGENT_CSP } from "@alexkroman1/aai";
import { HTTPException } from "hono/http-exception";
import mime from "mime-types";
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

// Misses are NOT cached: during parallel build+test runs (turbo) the file may
// be written after the first read, and caching null would permanently shadow it.
const defaultClientCache = new Map<string, string>();

async function readDefaultClientFile(relPath: string): Promise<string | null> {
  const cached = defaultClientCache.get(relPath);
  if (cached !== undefined) return cached;
  const baseDir = getDefaultClientDir();
  const fullPath = path.join(baseDir, relPath);
  // Defense in depth: ensure the resolved path stays within baseDir. Use a
  // path.relative check rather than a raw prefix match so a sibling dir like
  // `default-client-evil` can't masquerade as being inside `default-client`.
  const rel = path.relative(baseDir, fullPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    const content = await readFile(fullPath, "utf-8");
    defaultClientCache.set(relPath, content);
    return content;
  } catch {
    return null;
  }
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
  const cspHeaders = { "Content-Security-Policy": AGENT_CSP };

  const page = await c.env.store.getClientFile(slug, "index.html");
  if (page) return c.html(page, 200, cspHeaders);

  const manifest = await c.env.store.getManifest(slug);
  if (!manifest) throw new HTTPException(404, { message: "HTML not found" });
  const html = await readDefaultClientFile("index.html");
  if (!html) throw new HTTPException(500, { message: "Default client not built" });
  return c.html(html, 200, cspHeaders);
}

export async function handleClientAsset(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  // biome-ignore lint/style/noNonNullAssertion: path param guaranteed by route
  const rawPath = c.req.param("path")!;
  const parsed = SafePathSchema.safeParse(rawPath);
  if (!parsed.success) throw new HTTPException(400, { message: "Invalid asset path" });

  const assetPath = parsed.data;
  const relPath = `assets/${assetPath}`;
  const body =
    (await c.env.store.getClientFile(slug, relPath)) ?? (await readDefaultClientFile(relPath));
  if (!body) throw new HTTPException(404, { message: "Asset not found" });

  return c.body(body, 200, {
    "Content-Type": mime.lookup(assetPath) || "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
}
