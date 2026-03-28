// Copyright 2025 the AAI authors. MIT license.
/**
 * Sidecar HTTP server for agent sandboxes.
 *
 * Each sandbox gets a per-sandbox sidecar server on loopback that provides
 * KV access — the isolate calls it without authentication.
 * KV instance is pre-scoped at construction time.
 */

import type { Kv } from "@alexkroman1/aai/kv";
import { ssrfSafeFetch } from "@alexkroman1/aai/ssrf";
import { getServerPort } from "@alexkroman1/aai/utils";
import { serve } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

// ── Sidecar request schemas (per-endpoint, loopback only) ───────────────

const SidecarKvGetSchema = z.object({ key: z.string() });
const SidecarKvSetSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  options: z.object({ expireIn: z.number().optional() }).optional(),
});
const SidecarKvDelSchema = z.object({ key: z.string() });
const SidecarKvListSchema = z.object({
  prefix: z.string(),
  limit: z.number().optional(),
  reverse: z.boolean().optional(),
});
const SidecarKvKeysSchema = z.object({ pattern: z.string().optional() });
const SidecarFetchSchema = z.object({
  url: z.string().url(),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().nullish(),
});

/** Per-fetch timeout — matches the built-in tool timeout in builtin-tools.ts. */
const FETCH_PROXY_TIMEOUT_MS = 15_000;

/** Maximum response body size (1 MB) to prevent the sidecar from buffering huge responses. */
const MAX_RESPONSE_BODY_BYTES = 1_048_576;

/** Timeout for sidecar server to start listening (ms). */
const SIDECAR_STARTUP_TIMEOUT_MS = 10_000;

// ── Sidecar server (per-sandbox, loopback, no auth) ─────────────────────

function buildSidecarApp(kv: Kv): Hono {
  const app = new Hono();

  app.post("/kv/get", zValidator("json", SidecarKvGetSchema), async (c) => {
    const { key } = c.req.valid("json");
    return c.json((await kv.get(key)) ?? null);
  });
  app.post("/kv/set", zValidator("json", SidecarKvSetSchema), async (c) => {
    const { key, value, options } = c.req.valid("json");
    await kv.set(
      key,
      value,
      options?.expireIn != null ? { expireIn: options.expireIn } : undefined,
    );
    return c.json(null);
  });
  app.post("/kv/del", zValidator("json", SidecarKvDelSchema), async (c) => {
    const { key } = c.req.valid("json");
    await kv.delete(key);
    return c.json(null);
  });
  app.post("/kv/list", zValidator("json", SidecarKvListSchema), async (c) => {
    const { prefix, limit, reverse } = c.req.valid("json");
    return c.json(
      await kv.list(prefix, {
        ...(limit != null && { limit }),
        ...(reverse != null && { reverse }),
      }),
    );
  });
  app.post("/kv/keys", zValidator("json", SidecarKvKeysSchema), async (c) => {
    const { pattern } = c.req.valid("json");
    return c.json(await kv.keys(pattern));
  });
  // ── Fetch proxy (SSRF-safe) ──────────────────────────────────────────
  app.post("/fetch", zValidator("json", SidecarFetchSchema), async (c) => {
    const { url, method, headers, body } = c.req.valid("json");
    const resp = await ssrfSafeFetch(
      url,
      {
        method: method ?? "GET",
        ...(headers && { headers }),
        ...(body != null && { body }),
        signal: AbortSignal.timeout(FETCH_PROXY_TIMEOUT_MS),
      },
      globalThis.fetch,
    );
    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    // Read body as an ArrayBuffer so we can enforce a size limit and
    // base64-encode binary responses faithfully.
    const buf = await resp.arrayBuffer();
    const bodyBytes = new Uint8Array(buf);
    const truncated = bodyBytes.length > MAX_RESPONSE_BODY_BYTES;
    const slice = truncated ? bodyBytes.slice(0, MAX_RESPONSE_BODY_BYTES) : bodyBytes;
    return c.json({
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
      body: Buffer.from(slice).toString("base64"),
      truncated,
    });
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    const status = err.name === "ZodError" ? 400 : 500;
    return c.json({ error: err.message }, status as 400 | 500);
  });

  return app;
}

export async function startSidecarServer(kv: Kv): Promise<{ url: string; close: () => void }> {
  const app = buildSidecarApp(kv);
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Sidecar server failed to start within ${SIDECAR_STARTUP_TIMEOUT_MS}ms`));
    }, SIDECAR_STARTUP_TIMEOUT_MS);
    server.on("listening", () => {
      clearTimeout(timeout);
      resolve();
    });
    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  const port = getServerPort(server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  };
}
