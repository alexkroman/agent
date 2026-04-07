// Copyright 2025 the AAI authors. MIT license.
/**
 * Per-sandbox HTTP sidecar server.
 *
 * Runs on the host process at `127.0.0.1:<ephemeral>`, reachable from the
 * isolate via the SIDECAR_URL env var. Routes:
 *
 * - `POST /kv`                        — KV store bridge (uses KvRequestSchema)
 * - `POST /host/*`                   — push channel for session events
 *
 * The sidecar port is added to `loopbackExemptPorts` so the default
 * secure-exec network adapter allows the isolate to reach it.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Kv } from "@alexkroman1/aai/kv";
import { KvRequestSchema } from "@alexkroman1/aai/protocol";

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

// ── KV handler (uses KvRequestSchema from protocol.ts) ────────────────

async function handleKvRequest(kv: Kv, body: string): Promise<{ data: unknown; status: number }> {
  let raw: unknown;
  try {
    raw = body ? JSON.parse(body) : {};
  } catch {
    return { data: { error: "Invalid JSON in KV request body" }, status: 400 };
  }

  const parsed = KvRequestSchema.safeParse(raw);
  if (!parsed.success) return { data: { error: parsed.error.message }, status: 400 };
  const msg = parsed.data;

  switch (msg.op) {
    case "get":
      return { data: (await kv.get(msg.key)) ?? null, status: 200 };
    case "set":
      await kv.set(msg.key, msg.value, msg.expireIn ? { expireIn: msg.expireIn } : undefined);
      return { data: null, status: 200 };
    case "del":
      await kv.delete(msg.key);
      return { data: null, status: 200 };
    case "list": {
      const opts: { limit?: number; reverse?: boolean } = {};
      if (msg.limit !== undefined) opts.limit = msg.limit;
      if (msg.reverse !== undefined) opts.reverse = msg.reverse;
      return { data: await kv.list(msg.prefix, opts), status: 200 };
    }
    case "keys":
      return { data: await kv.keys(msg.pattern), status: 200 };
    default:
      return { data: { error: `Unknown KV op: ${(msg as { op: string }).op}` }, status: 400 };
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
  // KV route: /kv (op is in the request body via KvRequestSchema)
  if (path === "/kv") return handleKvRequest(kv, body);

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
    const token = req.headers["x-harness-token"];
    if (
      typeof token !== "string" ||
      token.length !== authToken.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(authToken))
    ) {
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
