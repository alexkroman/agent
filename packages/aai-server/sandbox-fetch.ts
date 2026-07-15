// Copyright 2025 the AAI authors. MIT license.
/**
 * Host-side fetch handler for the sandbox.
 *
 * Validates outbound fetch requests from guest agents against an allowedHosts
 * list, applies SSRF protection, and streams the response back in chunks via
 * an emit callback.
 */

import { errorMessage, matchesAllowedHost } from "@alexkroman1/aai";
import { ssrfSafeFetch } from "./ssrf.ts";

export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_CONCURRENT = 10;
export const FETCH_TIMEOUT_MS = 30_000;
export const CHUNK_SIZE = 64 * 1024;

export type FetchRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null; // base64-encoded
};

export type FetchResponseStart = {
  type: "fetch/response-start";
  id: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
};

export type FetchResponseChunk = {
  type: "fetch/response-chunk";
  id: string;
  data: string; // base64-encoded
};

export type FetchResponseEnd = {
  type: "fetch/response-end";
  id: string;
};

export type FetchResponseError = {
  type: "fetch/response-error";
  id: string;
  message: string;
};

export type FetchResponseMessage =
  | FetchResponseStart
  | FetchResponseChunk
  | FetchResponseEnd
  | FetchResponseError;

export type FetchHandlerOptions = {
  allowedHosts: string[];
  fetchFn?: typeof globalThis.fetch;
  skipSsrf?: boolean;
  maxResponseBytes?: number;
  maxConcurrent?: number;
};

type Emit = (msg: FetchResponseMessage) => void;

function emitError(id: string, message: string, emit: Emit): void {
  emit({ type: "fetch/response-error", id, message });
}

function emitChunk(id: string, bytes: Uint8Array, emit: Emit): void {
  emit({ type: "fetch/response-chunk", id, data: Buffer.from(bytes).toString("base64") });
}

async function streamResponseBody(
  response: Response,
  id: string,
  maxResponseBytes: number,
  emit: Emit,
): Promise<boolean> {
  if (!response.body) return true;

  const reader = response.body.getReader();
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      if (!value || value.length === 0) continue;

      totalBytes += value.length;
      if (totalBytes > maxResponseBytes) {
        reader.cancel().catch(() => undefined);
        emitError(id, `Response size exceeded limit of ${maxResponseBytes} bytes`, emit);
        return false;
      }

      for (let offset = 0; offset < value.length; offset += CHUNK_SIZE) {
        emitChunk(id, value.subarray(offset, Math.min(offset + CHUNK_SIZE, value.length)), emit);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function performFetch(
  req: FetchRequest,
  fetchFn: typeof globalThis.fetch,
  skipSsrf: boolean,
  allowedHosts: string[],
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const init: RequestInit = {
    method: req.method,
    headers: req.headers,
    signal: controller.signal,
    ...(req.body !== null ? { body: Buffer.from(req.body, "base64") } : {}),
  };
  try {
    // Enforce the egress allowlist on every redirect hop, not just the initial
    // URL (ssrfSafeFetch also strips credentials on cross-origin redirects).
    return skipSsrf
      ? await fetchFn(req.url, init)
      : await ssrfSafeFetch(req.url, init, fetchFn, {
          isHostAllowed: (h) => matchesAllowedHost(h, allowedHosts),
        });
  } finally {
    clearTimeout(timeout);
  }
}

export function createFetchHandler(opts: FetchHandlerOptions) {
  const allowedHosts = opts.allowedHosts;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const skipSsrf = opts.skipSsrf ?? false;
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;

  let activeCount = 0;

  return async function handleFetch(req: FetchRequest, id: string, emit: Emit): Promise<void> {
    if (activeCount >= maxConcurrent) {
      emitError(id, `Fetch concurrent limit of ${maxConcurrent} exceeded`, emit);
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url);
    } catch {
      emitError(id, `Invalid URL: ${req.url}`, emit);
      return;
    }

    if (!matchesAllowedHost(parsedUrl.hostname, allowedHosts)) {
      emitError(
        id,
        `Host "${parsedUrl.hostname}" is not allowed. Add it to the agent's allowedHosts list.`,
        emit,
      );
      return;
    }

    activeCount++;
    try {
      const response = await performFetch(req, fetchFn, skipSsrf, allowedHosts);
      emit({
        type: "fetch/response-start",
        id,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
      });
      if (await streamResponseBody(response, id, maxResponseBytes, emit)) {
        emit({ type: "fetch/response-end", id });
      }
    } catch (err) {
      emitError(id, errorMessage(err), emit);
    } finally {
      activeCount--;
    }
  };
}
