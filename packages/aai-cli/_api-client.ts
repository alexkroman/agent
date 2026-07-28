// Copyright 2025 the AAI authors. MIT license.

/**
 * Shared HTTP helper for platform API calls (deploy, delete, secrets).
 *
 * Built on ofetch: JSON bodies are serialized (with Content-Type set) and
 * responses parsed automatically, and transient failures (network errors,
 * 5xx/429) are retried before surfacing an error.
 */

import { FetchError, ofetch } from "ofetch";

export const HINT_INVALID_API_KEY =
  "Your API key may be invalid. Run `aai` to re-enter your AssemblyAI API key.";

export type ApiRequestOptions = {
  apiKey: string;
  /** Verb used in error messages, e.g. "deploy". */
  action: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /**
   * Request body. Plain objects are JSON-serialized by ofetch (with
   * Content-Type set); binary bodies (e.g. a pre-gzipped Buffer) pass
   * through untouched — set Content-Type/Content-Encoding via `headers`.
   */
  body?: unknown;
  /** Extra request headers, merged with the built-in Authorization header. */
  headers?: Record<string, string>;
  /** Extra error hints keyed by HTTP status. The 401 hint is built in. */
  hints?: Record<number, string>;
  /** Optional fetch implementation for testing. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
};

/**
 * Send an authenticated request to the platform API and return the parsed
 * JSON response. Throws a descriptive error with status-specific hints on
 * failure (the 401 hint is always included; pass more via `hints`).
 */
export async function apiRequest<T = unknown>(url: string, opts: ApiRequestOptions): Promise<T> {
  // A custom fetch implementation must be wired at client-creation time —
  // ofetch ignores a per-request `fetch` option.
  const client = opts.fetch ? ofetch.create({}, { fetch: opts.fetch }) : ofetch;
  try {
    return await client<T>(url, {
      method: opts.method ?? "GET",
      headers: { Authorization: `Bearer ${opts.apiKey}`, ...opts.headers },
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      retry: 2,
      retryDelay: 300,
    });
  } catch (err) {
    throw toApiError(err, url, opts);
  }
}

/** Format an ofetch failure into a descriptive, action-centric error. */
function toApiError(err: unknown, url: string, opts: ApiRequestOptions): Error {
  if (err instanceof FetchError && err.statusCode !== undefined) {
    const status = err.statusCode;
    const body = typeof err.data === "string" ? err.data : JSON.stringify(err.data ?? "");
    const hint = status === 401 ? HINT_INVALID_API_KEY : opts.hints?.[status];
    return new Error(`${opts.action} failed (HTTP ${status}): ${body}${hint ? `\n  ${hint}` : ""}`);
  }
  const hint = "Check your network connection and verify the server URL is correct.";
  const cause = err instanceof FetchError && err.cause !== undefined ? err.cause : err;
  return new Error(`${opts.action} failed: could not reach ${url}\n  ${hint}`, { cause });
}
