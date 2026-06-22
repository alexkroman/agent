// Copyright 2025 the AAI authors. MIT license.

/**
 * Shared HTTP helpers for platform API calls (deploy, delete, secrets).
 */

export const HINT_INVALID_API_KEY =
  "Your API key may be invalid. Run `aai` to re-enter your AssemblyAI API key.";

const defaultFetch = globalThis.fetch.bind(globalThis);

/**
 * Send an authenticated request to the platform API.
 *
 * Adds the `Authorization` header and, on network failure, throws with a hint
 * to check the network connection and server URL.
 */
export async function apiRequest(
  url: string,
  init: RequestInit & { apiKey: string; action: string },
  fetchFn: typeof globalThis.fetch = defaultFetch,
): Promise<Response> {
  const { apiKey, action, ...rest } = init;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    ...(rest.body ? { "Content-Type": "application/json" } : {}),
    ...(rest.headers as Record<string, string>),
  };
  try {
    return await fetchFn(url, { ...rest, headers });
  } catch (err: unknown) {
    const hint = "Check your network connection and verify the server URL is correct.";
    throw new Error(`${action} failed: could not reach ${url}\n  ${hint}`, { cause: err });
  }
}

/** Format a non-ok API response into a descriptive error. */
export function apiError(action: string, status: number, body: string, hint?: string): Error {
  return new Error(`${action} failed (HTTP ${status}): ${body}${hint ? `\n  ${hint}` : ""}`);
}

/**
 * Like `apiRequest`, but throws on non-ok responses with status-specific hints.
 * A built-in 401 hint is always included; pass additional hints via `opts.hints`.
 */
export async function apiRequestOrThrow(
  url: string,
  init: RequestInit & { apiKey: string; action: string },
  opts?: { hints?: Record<number, string>; fetch?: typeof globalThis.fetch | undefined },
): Promise<Response> {
  const resp = await apiRequest(url, init, opts?.fetch);
  if (resp.ok) return resp;
  const text = await resp.text();
  const hints: Record<number, string> = { ...opts?.hints, 401: HINT_INVALID_API_KEY };
  throw apiError(init.action, resp.status, text, hints[resp.status]);
}
