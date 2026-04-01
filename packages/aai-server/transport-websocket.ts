// Copyright 2025 the AAI authors. MIT license.

import { AGENT_CSP } from "@alexkroman1/aai/host";
import { HTTPException } from "hono/http-exception";
import mime from "mime-types";
import type { AppContext } from "./context.ts";
import { resolveSandbox } from "./sandbox.ts";
import { SafePathSchema } from "./schemas.ts";

/** @internal Not part of the public API. Exposed for testing only. */
export const _internals = { resolveSandbox };

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
  if (!page) throw new HTTPException(404, { message: "HTML not found" });
  return c.html(page, 200, { "Content-Security-Policy": AGENT_CSP });
}

export async function handleClientAsset(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  // biome-ignore lint/style/noNonNullAssertion: path param guaranteed by route
  const rawPath = c.req.param("path")!;
  const parsed = SafePathSchema.safeParse(rawPath);
  if (!parsed.success) throw new HTTPException(400, { message: "Invalid asset path" });

  const assetPath = parsed.data;
  const content = await c.env.store.getClientFile(slug, `assets/${assetPath}`);
  if (!content) throw new HTTPException(404, { message: "Asset not found" });

  const contentType = mime.lookup(assetPath) || "application/octet-stream";

  return c.body(content, 200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
}
