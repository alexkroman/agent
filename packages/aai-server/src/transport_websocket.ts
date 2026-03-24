// Copyright 2025 the AAI authors. MIT license.

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import mime from "mime-types";
import type { Env } from "./context.ts";
import { resolveSandbox } from "./sandbox.ts";

export const _internals = { resolveSandbox };

export async function handleAgentHealth(c: Context<Env>): Promise<Response> {
  const slug = c.get("slug");
  const manifest = await c.env.deployStore.getManifest(slug);
  if (!manifest) {
    throw new HTTPException(404, { message: `Not found: ${slug}` });
  }
  return c.json({ status: "ok", slug });
}

export async function handleAgentPage(c: Context<Env>): Promise<Response> {
  const slug = c.get("slug");
  const page = await c.env.assetStore.getClientFile(slug, "index.html");
  if (!page) throw new HTTPException(404, { message: "HTML not found" });
  return c.html(page);
}

export async function handleClientAsset(c: Context<Env>): Promise<Response> {
  const slug = c.get("slug");
  // biome-ignore lint/style/noNonNullAssertion: path param guaranteed by route
  const assetPath = c.req.param("path")!;
  const content = await c.env.assetStore.getClientFile(slug, `assets/${assetPath}`);
  if (!content) throw new HTTPException(404, { message: "Asset not found" });

  const contentType = mime.lookup(assetPath) || "application/octet-stream";

  return c.body(content, 200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
}
