// Copyright 2025 the AAI authors. MIT license.
/**
 * Host-side fetch handler for the sandbox.
 *
 * Validates outbound fetch requests from guest agents against an allowedHosts
 * list, applies SSRF protection, and streams the response back in chunks via
 * an emit callback.
 *
 * The handler is stateful (tracks active count) and the returned function is
 * safe to call concurrently — each invocation either emits an error
 * immediately or proceeds through the full fetch lifecycle.
 */

import { matchesAllowedHost } from "@alexkroman1/aai";
import { ssrfSafeFetch } from "./ssrf.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // 4 MB
export const DEFAULT_MAX_CONCURRENT = 10;
export const FETCH_TIMEOUT_MS = 30_000;
export const CHUNK_SIZE = 64 * 1024; // 64 KB

// ── Types ──────────────────────────────────────────────────────────────────────

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

// ── Options ───────────────────────────────────────────────────────────────────

export type FetchHandlerOptions = {
  allowedHosts: string[];
  fetchFn?: typeof globalThis.fetch; // override for testing
  skipSsrf?: boolean; // testing only
  maxResponseBytes?: number; // testing only
  maxConcurrent?: number; // testing only
};

// ── Internal helpers ──────────────────────────────────────────────────────────

type ResolvedOptions = Required<FetchHandlerOptions>;

function emitError(id: string, message: string, emit: (msg: FetchResponseMessage) => void): void {
  emit({ type: "fetch/response-error", id, message });
}

function buildRequestInit(req: FetchRequest, signal: AbortSignal): RequestInit {
  const body: Buffer | undefined = req.body !== null ? Buffer.from(req.body, "base64") : undefined;
  return {
    method: req.method,
    headers: req.headers,
    signal,
    ...(body !== undefined ? { body } : {}),
  };
}

async function executeFetch(
  req: FetchRequest,
  init: RequestInit,
  opts: ResolvedOptions,
): Promise<Response> {
  if (opts.skipSsrf) {
    return opts.fetchFn(req.url, init);
  }
  return ssrfSafeFetch(req.url, init, opts.fetchFn);
}

function collectResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

/**
 * Reads the response body in CHUNK_SIZE chunks and emits each as
 * fetch/response-chunk. Returns `false` if the size limit is exceeded
 * (in which case a fetch/response-error has already been emitted).
 */
async function streamResponseBody(
  response: Response,
  id: string,
  maxResponseBytes: number,
  emit: (msg: FetchResponseMessage) => void,
): Promise<boolean> {
  if (!response.body) return true;

  const reader = response.body.getReader();
  let buffer = new Uint8Array(0);
  let totalBytes = 0;

  try {
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;

      if (result.value && result.value.length > 0) {
        const merged = new Uint8Array(buffer.length + result.value.length);
        merged.set(buffer);
        merged.set(result.value, buffer.length);
        buffer = merged;
      }

      // Emit complete CHUNK_SIZE chunks from the buffer
      while (buffer.length >= CHUNK_SIZE) {
        const chunk = buffer.slice(0, CHUNK_SIZE);
        buffer = buffer.slice(CHUNK_SIZE);
        totalBytes += chunk.length;
        if (totalBytes > maxResponseBytes) {
          reader.cancel().catch(() => undefined);
          emitError(id, `Response size exceeded limit of ${maxResponseBytes} bytes`, emit);
          return false;
        }
        emit({ type: "fetch/response-chunk", id, data: Buffer.from(chunk).toString("base64") });
      }
    }

    // Emit the remaining partial chunk
    if (buffer.length > 0) {
      totalBytes += buffer.length;
      if (totalBytes > maxResponseBytes) {
        emitError(id, `Response size exceeded limit of ${maxResponseBytes} bytes`, emit);
        return false;
      }
      emit({ type: "fetch/response-chunk", id, data: Buffer.from(buffer).toString("base64") });
    }
  } finally {
    reader.releaseLock();
  }

  return true;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates a fetch handler that validates URLs against an allowedHosts list,
 * applies SSRF protection, and streams responses in chunks via an emit callback.
 *
 * @param opts - Handler configuration options
 * @returns An async function that handles a single fetch request
 */
export function createFetchHandler(opts: FetchHandlerOptions) {
  const resolved: ResolvedOptions = {
    allowedHosts: opts.allowedHosts,
    fetchFn: opts.fetchFn ?? globalThis.fetch,
    skipSsrf: opts.skipSsrf ?? false,
    maxResponseBytes: opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    maxConcurrent: opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
  };

  let activeCount = 0;

  return async function handleFetch(
    req: FetchRequest,
    id: string,
    emit: (msg: FetchResponseMessage) => void,
  ): Promise<void> {
    // Guard: concurrent fetch limit
    if (activeCount >= resolved.maxConcurrent) {
      emitError(id, `Fetch concurrent limit of ${resolved.maxConcurrent} exceeded`, emit);
      return;
    }

    // Guard: parse URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url);
    } catch {
      emitError(id, `Invalid URL: ${req.url}`, emit);
      return;
    }

    // Guard: allowedHosts check
    if (!matchesAllowedHost(parsedUrl.hostname, resolved.allowedHosts)) {
      emitError(
        id,
        `Host "${parsedUrl.hostname}" is not allowed. Add it to the agent's allowedHosts list.`,
        emit,
      );
      return;
    }

    activeCount++;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let response: Response;
      try {
        response = await executeFetch(req, buildRequestInit(req, controller.signal), resolved);
      } finally {
        clearTimeout(timeout);
      }

      emit({
        type: "fetch/response-start",
        id,
        status: response.status,
        statusText: response.statusText,
        headers: collectResponseHeaders(response),
      });

      const ok = await streamResponseBody(response, id, resolved.maxResponseBytes, emit);
      if (ok) {
        emit({ type: "fetch/response-end", id });
      }
    } catch (err) {
      emitError(id, err instanceof Error ? err.message : String(err), emit);
    } finally {
      activeCount--;
    }
  };
}
