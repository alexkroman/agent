// Copyright 2026 the AAI authors. MIT license.
// Shared fetch-mocking helpers for the studio client's test suites.

import { vi } from "vitest";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A never-ending SSE stream — what the studio's event routes look like to a
 * client that subscribes and hears nothing. Tests that assert on pushes
 * build their own bodies; everything else stubs the events routes with this
 * so the app's always-on subscriptions don't trip the strict route table.
 */
export function sseResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>(), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * Stub the global `fetch`. Pass a single factory to answer every request, or
 * a route table keyed `"METHOD /path"` (or just `"/path"` for any method).
 * Factories, not Responses: a Response body is single-use, so each call must
 * mint a fresh one.
 */
export function stubFetch(routes: (() => Response) | Record<string, () => Response>) {
  const fetchMock = vi
    .fn()
    .mockImplementation((input: RequestInfo | URL, init?: RequestInit | undefined) => {
      if (typeof routes === "function") return Promise.resolve(routes());
      const path = new URL(String(input), "http://studio.test").pathname;
      const make = routes[`${init?.method ?? "GET"} ${path}`] ?? routes[path];
      if (!make) throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${path}`);
      return Promise.resolve(make());
    });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
