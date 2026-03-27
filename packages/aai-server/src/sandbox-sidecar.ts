// Copyright 2025 the AAI authors. MIT license.
/**
 * Scoped store adapters and sidecar HTTP server for agent sandboxes.
 *
 * Each sandbox gets a per-sandbox sidecar server on loopback that provides
 * scoped KV and vector access — the isolate calls it without authentication.
 */

import type { Kv, KvEntry } from "@alexkroman1/aai/kv";
import { ssrfSafeFetch } from "@alexkroman1/aai/ssrf";
import { getServerPort } from "@alexkroman1/aai/utils";
import { type VectorStore, validateVectorFilter } from "@alexkroman1/aai/vector";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { KvStore } from "./kv.ts";
import type { AgentScope } from "./scope-token.ts";
import type { ServerVectorStore } from "./vector.ts";

// ── Scoped store adapters ────────────────────────────────────────────────

export function scopedKv(kvStore: KvStore, scope: AgentScope) {
  return {
    async get(key: string) {
      const raw = await kvStore.get(scope, key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
    async set(key: string, value: unknown, options?: { expireIn?: number }) {
      const ttlSeconds = options?.expireIn != null ? Math.ceil(options.expireIn / 1000) : undefined;
      await kvStore.set(scope, key, JSON.stringify(value), ttlSeconds);
    },
    async delete(keys: string | string[]) {
      const keyArray = Array.isArray(keys) ? keys : [keys];
      for (const key of keyArray) await kvStore.del(scope, key);
    },
    async list<T = unknown>(
      prefix: string,
      options?: { limit?: number; reverse?: boolean },
    ): Promise<KvEntry<T>[]> {
      return (await kvStore.list(scope, prefix, options ?? {})) as KvEntry<T>[];
    },
    async keys(pattern?: string) {
      return await kvStore.keys(scope, pattern);
    },
  };
}

// Compile-time checks: scoped adapters must satisfy the SDK interfaces.
// If Kv or VectorStore gain a method, these lines will error until implemented.
// biome-ignore lint/suspicious/noUnusedExpressions: compile-time type check
null as unknown as ReturnType<typeof scopedKv> satisfies Kv;
// biome-ignore lint/suspicious/noUnusedExpressions: compile-time type check
null as unknown as ReturnType<typeof scopedVector> satisfies VectorStore;

export function scopedVector(vectorStore: ServerVectorStore, scope: AgentScope) {
  return {
    async upsert(id: string, data: string, metadata?: Record<string, unknown>) {
      await vectorStore.upsert(scope, id, data, metadata);
    },
    async query(text: string, options?: { topK?: number; filter?: string }) {
      return await vectorStore.query(scope, text, options?.topK, options?.filter);
    },
    async delete(ids: string | string[]) {
      await vectorStore.remove(scope, Array.isArray(ids) ? ids : [ids]);
    },
  };
}

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
const SidecarVecUpsertSchema = z.object({
  id: z.string(),
  data: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const SidecarVecQuerySchema = z.object({
  text: z.string(),
  topK: z.number().optional(),
  filter: z
    .string()
    .transform((f) => validateVectorFilter(f))
    .optional(),
});
const SidecarVecDeleteSchema = z.object({ ids: z.union([z.string(), z.array(z.string())]) });
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

function buildSidecarApp(
  kv: ReturnType<typeof scopedKv>,
  vector: ReturnType<typeof scopedVector> | undefined,
): Hono {
  const app = new Hono();

  const requireVec = () => {
    if (!vector) throw new HTTPException(503, { message: "Vector store not configured" });
    return vector;
  };

  app.post("/kv/get", async (c) => {
    const { key } = SidecarKvGetSchema.parse(await c.req.json());
    return c.json((await kv.get(key)) ?? null);
  });
  app.post("/kv/set", async (c) => {
    const { key, value, options } = SidecarKvSetSchema.parse(await c.req.json());
    await kv.set(
      key,
      value,
      options?.expireIn != null ? { expireIn: options.expireIn } : undefined,
    );
    return c.json(null);
  });
  app.post("/kv/del", async (c) => {
    const { key } = SidecarKvDelSchema.parse(await c.req.json());
    await kv.delete(key);
    return c.json(null);
  });
  app.post("/kv/list", async (c) => {
    const { prefix, limit, reverse } = SidecarKvListSchema.parse(await c.req.json());
    return c.json(
      await kv.list(prefix, {
        ...(limit != null && { limit }),
        ...(reverse != null && { reverse }),
      }),
    );
  });
  app.post("/kv/keys", async (c) => {
    const { pattern } = SidecarKvKeysSchema.parse(await c.req.json());
    return c.json(await kv.keys(pattern));
  });
  app.post("/vec/upsert", async (c) => {
    const { id, data, metadata } = SidecarVecUpsertSchema.parse(await c.req.json());
    await requireVec().upsert(id, data, metadata);
    return c.json(null);
  });
  app.post("/vec/query", async (c) => {
    const { text, topK, filter } = SidecarVecQuerySchema.parse(await c.req.json());
    return c.json(
      await requireVec().query(text, {
        ...(topK != null && { topK }),
        ...(filter != null && { filter }),
      }),
    );
  });
  app.post("/vec/delete", async (c) => {
    const { ids } = SidecarVecDeleteSchema.parse(await c.req.json());
    await requireVec().delete(ids);
    return c.json(null);
  });

  // ── Fetch proxy (SSRF-safe) ──────────────────────────────────────────
  app.post("/fetch", async (c) => {
    const { url, method, headers, body } = SidecarFetchSchema.parse(await c.req.json());
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

export async function startSidecarServer(
  kv: ReturnType<typeof scopedKv>,
  vector: ReturnType<typeof scopedVector> | undefined,
): Promise<{ url: string; close: () => void }> {
  const app = buildSidecarApp(kv, vector);
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
