// Copyright 2025 the AAI authors. MIT license.

import { vi } from "vitest";

/**
 * Narrow a test double to `fetch`'s type, in ONE place: a fake never matches
 * `typeof globalThis.fetch` structurally (`RequestInfo | URL`, a full
 * `Response`, `preconnect`), and a cast per call site is the alternative.
 */
export function fakeFetch(
  fn: (url: string, init: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  // One CHECKED cast: `fetch` is assignable to `fn`'s narrower type, so the
  // compiler still relates the two.
  return fn as typeof globalThis.fetch;
}

/** One request a {@link recordingFetch} received, decoded. */
export type RecordedRequest = {
  url: string;
  method: string;
  headers: Headers;
  /** The body as text (`""` when there was none). */
  body: string;
  /** The body parsed as JSON. */
  json(): Record<string, unknown>;
};

/**
 * A `fetch` spy that answers every call with `answer()`, plus `requests()`,
 * which decodes what it was sent from the spy's own `mock.calls`.
 *
 * Call-shaped assertions (`toHaveBeenCalledTimes`, `not.toHaveBeenCalled`) go
 * on `fetch`; what crossed (URL, bearer, body) on `requests()`. Bodies are
 * decoded synchronously, so a call must pass its body in `init` as a string or
 * bytes — which every platform and provider caller here does.
 */
export function recordingFetch(
  answer: () => Response | Promise<Response> = () => Response.json({ result: null }),
): {
  fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  requests: () => RecordedRequest[];
} {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => await answer());
  const requests = () => fetch.mock.calls.map(([input, init]) => decodeRequest(input, init));
  return { fetch, requests };
}

function decodeRequest(
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
): RecordedRequest {
  const url = input instanceof Request ? input.url : String(input);
  const body = bodyText(init?.body);
  return {
    url,
    method: init?.method ?? (input instanceof Request ? input.method : "GET"),
    headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
    body,
    json: () => JSON.parse(body) as Record<string, unknown>,
  };
}

function bodyText(raw: RequestInit["body"]): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  return String(raw);
}
