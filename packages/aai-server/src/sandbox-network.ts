// Copyright 2025 the AAI authors. MIT license.
/**
 * Network policy and adapter for sandbox isolates.
 *
 * Provides virtual hosts for:
 * - `http://kv.internal/` — KV store bridge
 * - `http://host.internal/` — push channel for session events back to host
 *
 * All other outbound requests go through the default adapter (SSRF checks).
 */

import type { Kv } from "@alexkroman1/aai/kv";
import { createDefaultNetworkAdapter } from "secure-exec";
import { z } from "zod";

const KV_ORIGIN = "http://kv.internal";
const HOST_ORIGIN = "http://host.internal";

export type HostEventHandler = (
  path: string,
  body: string | null,
  headers: Record<string, string>,
) => void;

/**
 * Build a network permission check for the isolate.
 * Allows all — the adapter handles SSRF validation.
 */
export function buildNetworkPolicy() {
  return (_req: { op: string; url?: string; hostname?: string }) => ({ allow: true as const });
}

/**
 * Build a network adapter with:
 * 1. KV bridge at `http://kv.internal/`
 * 2. Host push channel at `http://host.internal/`
 * 3. Default adapter with SSRF checks for everything else
 */
export function buildNetworkAdapter(kv: Kv, onHostEvent?: HostEventHandler) {
  const defaultAdapter = createDefaultNetworkAdapter();

  return {
    ...defaultAdapter,
    async fetch(
      url: string,
      options: { method?: string; headers?: Record<string, string>; body?: string | null },
    ) {
      if (url.startsWith(KV_ORIGIN)) {
        return handleKvRequest(kv, url, options.body ?? null);
      }
      if (url.startsWith(HOST_ORIGIN)) {
        if (!onHostEvent) {
          return jsonResponse({ error: "Host event handler not configured" }, 500);
        }
        const path = new URL(url).pathname;
        onHostEvent(path, options.body ?? null, options.headers ?? {});
        return jsonResponse({ ok: true });
      }
      return defaultAdapter.fetch(url, options);
    },
  };
}

type AdapterResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  url: string;
  redirected: boolean;
};

function jsonResponse(data: unknown, status = 200): AdapterResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Bad Request",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
    url: "",
    redirected: false,
  };
}

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

function validationError(result: z.ZodSafeParseError<unknown>): AdapterResponse {
  return jsonResponse({ error: result.error.message }, 400);
}

async function handleKvGet(kv: Kv, raw: unknown): Promise<AdapterResponse> {
  const parsed = KvGetSchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed);
  return jsonResponse((await kv.get(parsed.data.key)) ?? null);
}

async function handleKvSet(kv: Kv, raw: unknown): Promise<AdapterResponse> {
  const parsed = KvSetSchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed);
  await kv.set(
    parsed.data.key,
    parsed.data.value,
    parsed.data.options?.expireIn != null ? { expireIn: parsed.data.options.expireIn } : undefined,
  );
  return jsonResponse(null);
}

async function handleKvDel(kv: Kv, raw: unknown): Promise<AdapterResponse> {
  const parsed = KvDelSchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed);
  await kv.delete(parsed.data.key);
  return jsonResponse(null);
}

async function handleKvList(kv: Kv, raw: unknown): Promise<AdapterResponse> {
  const parsed = KvListSchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed);
  return jsonResponse(
    await kv.list(parsed.data.prefix, {
      ...(parsed.data.limit != null && { limit: parsed.data.limit }),
      ...(parsed.data.reverse != null && { reverse: parsed.data.reverse }),
    }),
  );
}

async function handleKvKeys(kv: Kv, raw: unknown): Promise<AdapterResponse> {
  const parsed = KvKeysSchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed);
  return jsonResponse(await kv.keys(parsed.data.pattern));
}

async function handleKvRequest(kv: Kv, url: string, body: string | null): Promise<AdapterResponse> {
  const path = new URL(url).pathname;

  let raw: unknown;
  try {
    raw = body ? JSON.parse(body) : {};
  } catch {
    return jsonResponse({ error: "Invalid JSON in KV request body" }, 400);
  }

  switch (path) {
    case "/get":
      return handleKvGet(kv, raw);
    case "/set":
      return handleKvSet(kv, raw);
    case "/del":
      return handleKvDel(kv, raw);
    case "/list":
      return handleKvList(kv, raw);
    case "/keys":
      return handleKvKeys(kv, raw);
    default:
      return jsonResponse({ error: `Unknown KV path: ${path}` }, 400);
  }
}
