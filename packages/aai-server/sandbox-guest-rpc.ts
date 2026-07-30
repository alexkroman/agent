// Copyright 2025 the AAI authors. MIT license.
/**
 * Guest → host RPC surface for sandboxed agents.
 *
 * The Deno guest has no network or filesystem access; every db, Vector, and
 * fetch operation is proxied to the host over the sandbox's NDJSON channel.
 * This module owns that surface: the Zod schemas that validate untrusted
 * guest params, and the handler registration wired onto a connection before
 * it starts listening (see `configureSandbox` in sandbox-vm.ts).
 */

import type { Db } from "@alexkroman1/aai";
import { errorMessage } from "@alexkroman1/aai";
import {
  VectorDeleteSchema,
  VectorQuerySchema,
  VectorUpsertSchema,
} from "@alexkroman1/aai/protocol";
import type { HostGenerateFn, Vector } from "@alexkroman1/aai/runtime";
import { z } from "zod";
import type { NdjsonConnection } from "./ndjson-transport.ts";
import { DbQueryParamsSchema } from "./rpc-schemas.ts";
import { createFetchHandler, type FetchRequest } from "./sandbox-fetch.ts";

// ── Vector param schemas for guest → host validation ────────────────────────

// Derived from the wire schemas rather than restated: the RPC params are those
// shapes minus the `op` discriminator (the method name carries it here). Keeps
// the `topK` and `ids` caps in exactly one place.
const VectorUpsertParamsSchema = VectorUpsertSchema.omit({ op: true });
const VectorQueryParamsSchema = VectorQuerySchema.omit({ op: true });
const VectorDeleteParamsSchema = VectorDeleteSchema.omit({ op: true });

// ── Fetch param schema for guest → host validation ──────────────────────────

/**
 * The GUEST generates the fetch id and registers its pending-fetch entry
 * before sending the RPC. Early host-side rejections (disallowed host, body
 * too large, invalid URL, concurrency cap) emit `fetch/response-error`
 * notifications synchronously — with a host-generated id those could reach
 * the guest before the `{ id }` RPC response, be dropped, and stall the
 * fetch until the tool timeout. Ids only need to be unique per sandbox
 * connection, so any non-empty guest-chosen string is fine.
 */
const FetchRequestParamsSchema = z.object({
  id: z.string().min(1),
  url: z.string(),
  method: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().nullable(),
});

// ── Generate param schema for guest → host validation ───────────────────────

/**
 * Params for the llm/generate RPC — the wire form of the SDK's
 * `GenerateOptions` (sdk/generate.ts). The descriptor is validated for shape
 * only; `resolveLlm` (inside the host generate fn) is the authority on known
 * kinds, and credentials resolve from the agent's own env, so a guest naming
 * a provider can never reach beyond keys the tenant already holds. `schema`
 * must be plain JSON Schema — a Zod schema doesn't survive NDJSON and is
 * rejected guest-side with guidance (see guest/harness-rpc.ts).
 */
const GenerateParamsSchema = z.object({
  prompt: z.string().min(1).max(200_000),
  system: z.string().max(100_000).optional(),
  llm: z.object({ kind: z.string().min(1), options: z.record(z.string(), z.unknown()) }).optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
  temperature: z.number().finite().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

// ── Handler registration ─────────────────────────────────────────────────────

export type GuestRpcOptions = {
  /** App database handle (enables the db/query RPC handler when set). */
  db?: Db | undefined;
  /** Resolved Vector instance (enables vector/* RPC handlers when set). */
  vector?: Vector | undefined;
  /** Host generate fn (enables the llm/generate RPC handler when set). */
  generate?: HostGenerateFn | undefined;
  allowedHosts?: string[] | undefined;
};

/**
 * Register the host-side db/Vector/fetch RPC handlers for one guest
 * connection. Must run BEFORE `conn.listen()` so no incoming guest messages
 * are dropped.
 */
export function registerGuestRpcHandlers(conn: NdjsonConnection, opts: GuestRpcOptions): void {
  // Host serves guest ctx.db queries against the app's provisioned database
  // (params validated with Zod). JSON-serializability of row values is the
  // caller's problem — non-serializable values fail the NDJSON write. The
  // row cap (MAX_DB_RESULT_ROWS) is enforced inside `createPostgresDb`,
  // which this db handle comes from (openAppDb) — not re-checked here.
  if (opts.db) {
    const db = opts.db;
    conn.onRequest("db/query", async (raw: unknown) => {
      const p = DbQueryParamsSchema.parse(raw);
      return await db.query(p.sql, p.params);
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

  // Host serves guest ctx.generate requests — one-shot LLM calls on the
  // agent's own providers/credentials (params validated with Zod).
  if (opts.generate) {
    const generate = opts.generate;
    conn.onRequest("llm/generate", async (raw: unknown) => {
      const p = GenerateParamsSchema.parse(raw);
      return await generate({
        prompt: p.prompt,
        ...(p.system !== undefined ? { system: p.system } : {}),
        ...(p.llm !== undefined ? { llm: p.llm } : {}),
        ...(p.schema !== undefined ? { schema: p.schema } : {}),
        ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
        ...(p.maxOutputTokens !== undefined ? { maxOutputTokens: p.maxOutputTokens } : {}),
      });
    });
  }

  // Host serves guest fetch requests (validated against allowedHosts + SSRF)
  if (opts.allowedHosts && opts.allowedHosts.length > 0) {
    const handleFetch = createFetchHandler({ allowedHosts: opts.allowedHosts });
    conn.onRequest("fetch/request", (raw: unknown) => {
      const p = FetchRequestParamsSchema.parse(raw);
      const req: FetchRequest = { url: p.url, method: p.method, headers: p.headers, body: p.body };
      // Emit response messages as notifications in the background. The guest
      // already listens for this id (see FetchRequestParamsSchema), so even
      // synchronous early rejections are never dropped.
      void handleFetch(req, p.id, (msg) => conn.sendNotification(msg.type, msg)).catch(
        (err: unknown) => {
          // handleFetch reports expected failures in-band; a throw means it
          // died before emitting response-error. Fail the guest's pending
          // fetch fast instead of letting it stall to the tool timeout.
          console.error(`Sandbox fetch handler failed: ${errorMessage(err)}`);
          conn.sendNotification("fetch/response-error", {
            type: "fetch/response-error",
            id: p.id,
            message: errorMessage(err),
          });
        },
      );
      // Ack the request with the same id.
      return { id: p.id };
    });
  }
}
