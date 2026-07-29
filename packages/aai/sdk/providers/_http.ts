// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared HTTP plumbing for the fetch-based sdk providers (send channels,
 * sync transcription). Package-internal.
 */

import { safeJsonParse } from "../utils.ts";

/** The standard fetch signature (global fetch, a proxied fetch, or a test mock). */
export type FetchLike = typeof globalThis.fetch;

/**
 * Default a caller-supplied fetch, wrapping the global so it is never
 * invoked with a detached `this` (illegal invocation in browsers).
 */
export function resolveFetch(fetchFn: FetchLike | undefined): FetchLike {
  return fetchFn ?? ((input, init) => globalThis.fetch(input, init));
}

/** How much of an error response body to surface in thrown errors. */
const ERROR_BODY_PREVIEW_CHARS = 200;

/**
 * Best-effort detail from a failed response's body: a JSON `message`/`detail`
 * field when present, else the raw text — always capped, never the URL or
 * credentials.
 */
export async function httpErrorDetail(resp: Response): Promise<string> {
  const text = await resp.text().catch(() => "");
  const parsed = safeJsonParse(text);
  if (parsed && typeof parsed === "object") {
    const err = parsed as { message?: string; detail?: string };
    const detail = err.message ?? err.detail;
    if (typeof detail === "string") return detail.slice(0, ERROR_BODY_PREVIEW_CHARS);
  }
  return text.slice(0, ERROR_BODY_PREVIEW_CHARS);
}
