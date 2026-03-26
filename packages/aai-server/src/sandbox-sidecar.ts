// Copyright 2025 the AAI authors. MIT license.
/**
 * Scoped store adapters and sidecar HTTP server for agent sandboxes.
 *
 * Each sandbox gets a per-sandbox sidecar server on loopback that provides
 * scoped KV and vector access. A per-sidecar bearer token (shared only with
 * the corresponding isolate via SIDECAR_TOKEN env var) authenticates every
 * request, preventing other host processes from accessing the sidecar.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Kv, KvEntry } from "@alexkroman1/aai/kv";
import type { VectorStore } from "@alexkroman1/aai/vector";
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
      await kvStore.set(scope, key, JSON.stringify(value), options?.expireIn);
    },
    async delete(keys: string | string[]) {
      const keyArray = Array.isArray(keys) ? keys : [keys];
      for (const key of keyArray) {
        await kvStore.delete(scope, key);
      }
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
      await vectorStore.delete(scope, Array.isArray(ids) ? ids : [ids]);
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
const SidecarKvDeleteSchema = z.object({
  key: z.union([z.string(), z.array(z.string())]),
});
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
  filter: z.string().optional(),
});
const SidecarVecDeleteSchema = z.object({ ids: z.union([z.string(), z.array(z.string())]) });

// ── Sidecar server (per-sandbox, loopback + bearer token auth) ──────────

function buildSidecarApp(
  kv: ReturnType<typeof scopedKv>,
  vector: ReturnType<typeof scopedVector> | undefined,
  token: string,
): Hono {
  const app = new Hono();

  // Authenticate every request with a constant-time comparison of the
  // per-sidecar bearer token. This prevents other processes on the host
  // from accessing another sandbox's KV/vector data.
  const expectedBuf = Buffer.from(token, "utf8");
  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const prefix = "Bearer ";
    if (!auth.startsWith(prefix)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const providedBuf = Buffer.from(auth.slice(prefix.length), "utf8");
    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

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
  app.post("/kv/delete", async (c) => {
    const { key } = SidecarKvDeleteSchema.parse(await c.req.json());
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

  app.onError((err, c) => {
    let status = 500;
    if (err.name === "ZodError") status = 400;
    else if (err instanceof HTTPException) status = err.status;
    return c.json(
      { error: err.message },
      status as import("hono/utils/http-status").ContentfulStatusCode,
    );
  });

  return app;
}

export async function startSidecarServer(
  kv: ReturnType<typeof scopedKv>,
  vector: ReturnType<typeof scopedVector> | undefined,
): Promise<{ url: string; token: string; close: () => void }> {
  const token = randomBytes(32).toString("hex");
  const app = buildSidecarApp(kv, vector, token);
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });

  await new Promise<void>((resolve, reject) => {
    server.on("listening", resolve);
    server.on("error", reject);
  });

  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    token,
    close: () => server.close(),
  };
}
