// Copyright 2025 the AAI authors. MIT license.
/**
 * Per-sandbox HTTP sidecar server.
 *
 * Runs on the host process at `127.0.0.1:<ephemeral>`, reachable from the
 * isolate via the SIDECAR_URL env var. Routes:
 *
 * - `POST /kv/get|set|del|list|keys` — KV store bridge
 * - `POST /host/*`                   — push channel for session events
 *
 * The sidecar port is added to `loopbackExemptPorts` so the default
 * secure-exec network adapter allows the isolate to reach it.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Kv } from "@alexkroman1/aai/kv";
import { z } from "zod";

export type HostEventHandler = (
  path: string,
  body: string | null,
  headers: Record<string, string>,
) => void;

export interface Sidecar {
  port: number;
  url: string;
  close(): Promise<void>;
}

const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5 MB

// ── KV bridge request schemas (validates isolate → host payloads) ──────

const KvGetSchema = z.object({ key: z.string() });
const KvSetSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  options: z.object({ expireIn: z.number().int().positive() }).optional(),
});
const KvDelSchema = z.object({ key: z.string() });
const KvListSchema = z.object({
  prefix: z.string(),
  limit: z.number().int().positive().optional(),
  reverse: z.boolean().optional(),
});
const KvKeysSchema = z.object({ pattern: z.string().optional() });

/** @internal Exposed for testing schema validation. */
export const _kvSchemas = { KvGetSchema, KvSetSchema, KvDelSchema, KvListSchema, KvKeysSchema };

// ── HTTP helpers ───────────────────────────────────────────────────────

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// ── KV handlers ────────────────────────────────────────────────────────

async function handleKvGet(kv: Kv, raw: unknown): Promise<{ data: unknown; status: number }> {
  const parsed = KvGetSchema.safeParse(raw);
  if (!parsed.success) return { data: { error: parsed.error.message }, status: 400 };
  return { data: (await kv.get(parsed.data.key)) ?? null, status: 200 };
}

async function handleKvSet(kv: Kv, raw: unknown): Promise<{ data: unknown; status: number }> {
  const parsed = KvSetSchema.safeParse(raw);
  if (!parsed.success) return { data: { error: parsed.error.message }, status: 400 };
  await kv.set(
    parsed.data.key,
    parsed.data.value,
    parsed.data.options?.expireIn != null ? { expireIn: parsed.data.options.expireIn } : undefined,
  );
  return { data: null, status: 200 };
}

async function handleKvDel(kv: Kv, raw: unknown): Promise<{ data: unknown; status: number }> {
  const parsed = KvDelSchema.safeParse(raw);
  if (!parsed.success) return { data: { error: parsed.error.message }, status: 400 };
  await kv.delete(parsed.data.key);
  return { data: null, status: 200 };
}

async function handleKvList(kv: Kv, raw: unknown): Promise<{ data: unknown; status: number }> {
  const parsed = KvListSchema.safeParse(raw);
  if (!parsed.success) return { data: { error: parsed.error.message }, status: 400 };
  const entries = await kv.list(parsed.data.prefix, {
    ...(parsed.data.limit != null && { limit: parsed.data.limit }),
    ...(parsed.data.reverse != null && { reverse: parsed.data.reverse }),
  });
  return { data: entries, status: 200 };
}

async function handleKvKeys(kv: Kv, raw: unknown): Promise<{ data: unknown; status: number }> {
  const parsed = KvKeysSchema.safeParse(raw);
  if (!parsed.success) return { data: { error: parsed.error.message }, status: 400 };
  return { data: await kv.keys(parsed.data.pattern), status: 200 };
}

async function handleKvRequest(
  kv: Kv,
  op: string,
  body: string,
): Promise<{ data: unknown; status: number }> {
  let raw: unknown;
  try {
    raw = body ? JSON.parse(body) : {};
  } catch {
    return { data: { error: "Invalid JSON in KV request body" }, status: 400 };
  }

  switch (op) {
    case "get":
      return handleKvGet(kv, raw);
    case "set":
      return handleKvSet(kv, raw);
    case "del":
      return handleKvDel(kv, raw);
    case "list":
      return handleKvList(kv, raw);
    case "keys":
      return handleKvKeys(kv, raw);
    default:
      return { data: { error: `Unknown KV op: ${op}` }, status: 400 };
  }
}

// ── Sidecar server ─────────────────────────────────────────────────────

async function routeRequest(
  kv: Kv,
  path: string,
  body: string,
  req: IncomingMessage,
  onHostEvent?: HostEventHandler,
): Promise<{ data: unknown; status: number }> {
  // KV routes: /kv/<op>
  const kvMatch = path.match(/^\/kv\/(\w+)$/);
  if (kvMatch?.[1]) return handleKvRequest(kv, kvMatch[1], body);

  // Host event routes: /host/*
  if (path.startsWith("/host/")) {
    if (!onHostEvent) return { data: { error: "Host event handler not configured" }, status: 500 };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k] = v;
    }
    onHostEvent(path.slice("/host".length), body || null, headers);
    return { data: { ok: true }, status: 200 };
  }

  return { data: { error: "Not found" }, status: 404 };
}

export async function createSidecar(
  kv: Kv,
  authToken: string,
  onHostEvent?: HostEventHandler,
): Promise<Sidecar> {
  const server = createServer(async (req, res) => {
    if (req.headers["x-harness-token"] !== authToken) {
      json(res, { error: "Unauthorized" }, 401);
      return;
    }
    if (req.method !== "POST") {
      json(res, { error: "Method not allowed" }, 405);
      return;
    }

    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    try {
      const body = await readBody(req);
      const result = await routeRequest(kv, path, body, req, onHostEvent);
      json(res, result.data, result.status);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      json(res, { error: message }, 500);
    }
  });

  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => resolve());
  await promise;

  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Sidecar failed to bind");
  const port = addr.port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
