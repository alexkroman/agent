// Copyright 2025 the AAI authors. MIT license.
/**
 * Network policy and adapter for sandbox isolates.
 *
 * The network adapter handles SSRF validation (DNS resolution, private-IP
 * blocking, redirect re-validation) for outbound requests and provides a
 * virtual KV bridge via `http://kv.internal/` URLs.
 */

import type { Kv } from "@alexkroman1/aai/kv";
import { createDefaultNetworkAdapter } from "secure-exec";

const KV_ORIGIN = "http://kv.internal";

/**
 * Build a network permission check for the isolate.
 *
 * Allows listening, DNS, and all outbound requests. The network adapter
 * handles real SSRF validation.
 */
export function buildNetworkPolicy() {
  return (_req: { op: string; url?: string; hostname?: string }) => ({ allow: true as const });
}

/**
 * Build a network adapter that:
 * 1. Intercepts `http://kv.internal/` requests and routes them to the host-side KV store
 * 2. Passes all other requests through the default adapter (with SSRF checks)
 */
export function buildNetworkAdapter(kv: Kv) {
  const defaultAdapter = createDefaultNetworkAdapter();

  return {
    ...defaultAdapter,
    async fetch(
      url: string,
      options: { method?: string; headers?: Record<string, string>; body?: string | null },
    ) {
      // KV bridge — virtual host handled on the host side
      if (url.startsWith(KV_ORIGIN)) {
        return handleKvRequest(kv, url, options.body ?? null);
      }
      // Everything else goes through the default adapter (with SSRF checks)
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
