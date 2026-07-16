// Copyright 2025 the AAI authors. MIT license.
/**
 * Guest → host RPC surface for sandboxed agents.
 *
 * The Deno guest has no network or filesystem access; every KV, Vector, and
 * fetch operation is proxied to the host over the sandbox's NDJSON channel.
 * This module owns that surface: the Zod schemas that validate untrusted
 * guest params, and the handler registration wired onto a connection before
 * it starts listening (see `configureSandbox` in sandbox-vm.ts).
 */

import type { Kv } from "@alexkroman1/aai";
import type { Vector } from "@alexkroman1/aai/runtime";
import { z } from "zod";
import type { NdjsonConnection } from "./ndjson-transport.ts";
import { createFetchHandler, type FetchRequest } from "./sandbox-fetch.ts";

// ── KV param schemas for guest → host validation ────────────────────────────

/**
 * Safe KV key: non-empty, no path traversal. The agent prefix
 * (`agents/${slug}/kv`) uses `/` as the namespace separator, so we reject `/`,
 * `\`, `..`, and null bytes. `:` is allowed — it's a common Redis-style
 * delimiter for hierarchical keys (e.g. `incident:INC-0001`) and isn't used
 * by the prefix scheme.
 */
const SafeKvKeySchema = z
  .string()
  .min(1)
  .refine((k) => !k.includes("\0"), "Key must not contain null bytes")
  .refine((k) => !k.includes("/"), "Key must not contain /")
  .refine((k) => !k.includes("\\"), "Key must not contain \\")
  .refine((k) => !k.includes(".."), "Key must not contain ..");

const KvGetParamsSchema = z.object({ key: SafeKvKeySchema });
const KvSetParamsSchema = z.object({
  key: SafeKvKeySchema,
  // No size refine here: every resolved Kv (platform default and BYO alike)
  // goes through `createUnstorageKv`, whose `set` already enforces
  // MAX_VALUE_SIZE — re-stringifying up to 64 KB per call just to measure it
  // would duplicate that check.
  value: z.unknown(),
  expireIn: z.number().int().positive().optional(),
});
const KvDelParamsSchema = z.object({ key: SafeKvKeySchema });

// ── Vector param schemas for guest → host validation ────────────────────────

const VectorUpsertParamsSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const VectorQueryParamsSchema = z.object({
  text: z.string().min(1),
  topK: z.number().int().positive().max(100).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
});
const VectorDeleteParamsSchema = z.object({
  ids: z.union([z.string().min(1), z.array(z.string().min(1)).max(1000)]),
});

// ── Handler registration ─────────────────────────────────────────────────────

export type GuestRpcOptions = {
  /** Resolved Kv instance (enables kv/* RPC handlers when set). */
  kv?: Kv | undefined;
  /** Resolved Vector instance (enables vector/* RPC handlers when set). */
  vector?: Vector | undefined;
  allowedHosts?: string[] | undefined;
};

/**
 * Register the host-side KV/Vector/fetch RPC handlers for one guest
 * connection. Must run BEFORE `conn.listen()` so no incoming guest messages
 * are dropped.
 */
export function registerGuestRpcHandlers(conn: NdjsonConnection, opts: GuestRpcOptions): void {
  // Host serves guest KV requests (params validated with Zod).
  if (opts.kv) {
    const kv = opts.kv;
    conn.onRequest("kv/get", async (raw: unknown) => {
      const p = KvGetParamsSchema.parse(raw);
      return await kv.get(p.key);
    });
    conn.onRequest("kv/set", async (raw: unknown) => {
      const p = KvSetParamsSchema.parse(raw);
      if (p.expireIn !== undefined) {
        await kv.set(p.key, p.value, { expireIn: p.expireIn });
      } else {
        await kv.set(p.key, p.value);
      }
    });
    conn.onRequest("kv/del", async (raw: unknown) => {
      const p = KvDelParamsSchema.parse(raw);
      await kv.delete(p.key);
    });
  }

  // Host serves guest Vector requests (params validated with Zod)
  if (opts.vector) {
    const vector = opts.vector;
    conn.onRequest("vector/upsert", async (raw: unknown) => {
      const p = VectorUpsertParamsSchema.parse(raw);
      await vector.upsert(p.id, p.text, p.metadata);
    });
    conn.onRequest("vector/query", async (raw: unknown) => {
      const p = VectorQueryParamsSchema.parse(raw);
      return await vector.query(p.text, {
        ...(p.topK !== undefined ? { topK: p.topK } : {}),
        ...(p.filter !== undefined ? { filter: p.filter } : {}),
      });
    });
    conn.onRequest("vector/delete", async (raw: unknown) => {
      const p = VectorDeleteParamsSchema.parse(raw);
      await vector.delete(p.ids);
    });
  }

  // Host serves guest fetch requests (validated against allowedHosts + SSRF)
  if (opts.allowedHosts && opts.allowedHosts.length > 0) {
    const handleFetch = createFetchHandler({ allowedHosts: opts.allowedHosts });
    let fetchId = 0;
    conn.onRequest("fetch/request", (raw: unknown) => {
      const req = raw as FetchRequest;
      const id = String(++fetchId);
      // Emit response messages as notifications in the background
      void handleFetch(req, id, (msg) => conn.sendNotification(msg.type, msg));
      // Return id immediately so guest can start collecting notifications
      return { id };
    });
  }
}
