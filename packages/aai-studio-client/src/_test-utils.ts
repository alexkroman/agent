// Copyright 2026 the AAI authors. MIT license.
// Shared fetch-mocking helpers for the studio client's test suites.

import { vi } from "vitest";

/**
 * A spy that stands in for `fetch` where one is INJECTED rather than stubbed
 * globally (`createResilientFetch`, `createSandboxTransport`).
 *
 * The one typed seam for that, and the reason it is worth having is that the
 * hand-rolled version was an `as unknown as typeof fetch` per suite — the cast
 * is unnecessary once the mock's parameter types are declared here instead of
 * being inferred from a narrower callback at each call site.
 */
export function fakeFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn(impl);
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * An SSE stream.
 *
 * With no `frames`, a never-ending one — what the studio's event routes look
 * like to a client that subscribes and hears nothing, which is how the app's
 * always-on subscriptions are stubbed so they don't trip the strict route
 * table. With `frames`, those frames are enqueued and the stream CLOSES, which
 * is what a push-asserting test wants (a closed stream is also what makes the
 * client report `onDown`).
 *
 * Frames are written verbatim, so a test can split one SSE frame across two
 * entries to exercise reassembly.
 */
export function sseResponse(frames?: readonly string[]): Response {
  const stream = new ReadableStream<Uint8Array>(
    frames === undefined
      ? {}
      : {
          start(controller) {
            const encoder = new TextEncoder();
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            controller.close();
          },
        },
  );
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** Wait until a stream's `finally` block has run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
