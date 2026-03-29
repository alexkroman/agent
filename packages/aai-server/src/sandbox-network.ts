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
export function buildNetworkAdapter(kv: Kv, onHostEvent: HostEventHandler) {
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

async function handleKvRequest(kv: Kv, url: string, body: string | null): Promise<AdapterResponse> {
  const path = new URL(url).pathname;
  const payload = body ? JSON.parse(body) : {};

  switch (path) {
    case "/get":
      return jsonResponse((await kv.get(payload.key)) ?? null);
    case "/set":
      await kv.set(
        payload.key,
        payload.value,
        payload.options?.expireIn != null ? { expireIn: payload.options.expireIn } : undefined,
      );
      return jsonResponse(null);
    case "/del":
      await kv.delete(payload.key);
      return jsonResponse(null);
    case "/list":
      return jsonResponse(
        await kv.list(payload.prefix, {
          ...(payload.limit != null && { limit: payload.limit }),
          ...(payload.reverse != null && { reverse: payload.reverse }),
        }),
      );
    case "/keys":
      return jsonResponse(await kv.keys(payload.pattern));
    default:
      return jsonResponse({ error: `Unknown KV path: ${path}` }, 400);
  }
}
