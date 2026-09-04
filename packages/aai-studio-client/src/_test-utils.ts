// Copyright 2026 the AAI authors. MIT license.
// Shared helpers for the studio client's test suites: fetch mocking, the
// TanStack wrapper every card is rendered under, and the DOM seams that keep
// `as HTML*Element` out of the assertions.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderResult, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
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

/** A `vi.fn()` standing in for `fetch`, with `fetch`'s own parameter types. */
export type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

/**
 * Stub the global `fetch`. Pass a single factory to answer every request, or
 * a route table keyed `"METHOD /path"` (or just `"/path"` for any method).
 * Factories, not Responses: a Response body is single-use, so each call must
 * mint a fresh one.
 *
 * The single-factory arm SEES the request and may answer asynchronously, which
 * is what lets a responder branch on the URL or reject outright. Without that
 * it was `() => Response`, so every suite whose stub had to look at where the
 * request was going hand-rolled `vi.fn(...)` + `vi.stubGlobal` instead — and
 * typed the callback narrower than `fetch`, which is the thing {@link fakeFetch}
 * exists to prevent.
 */
export function stubFetch(
  routes:
    | ((input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>)
    | Record<string, () => Response>,
): FetchMock {
  // Typed as `fetch` itself, exactly as `fakeFetch` above is: untyped, every
  // caller either cast `mock.calls[n]` back to `[string, RequestInit]` or read
  // an unchecked `any` off it — and the second is the worse half, since a
  // renamed field on an assertion nothing type-checks stays green.
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    if (typeof routes === "function") return Promise.resolve(routes(input, init));
    const path = new URL(String(input), "http://studio.test").pathname;
    const make = routes[`${init?.method ?? "GET"} ${path}`] ?? routes[path];
    if (!make) throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${path}`);
    return Promise.resolve(make());
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * One recorded request, read the way the assertions want it: the URL as a
 * string, and the method defaulted the way `fetch` defaults it. Throws rather
 * than returning `undefined` for a call that was never made, so a test that
 * asserts on request #1 fails saying so instead of on a property of nothing.
 */
export function fetchCall(
  mock: FetchMock,
  index = 0,
): { url: string; method: string; init: RequestInit } {
  const call = mock.mock.calls[index];
  if (!call) throw new Error(`No fetch call #${index} — ${mock.mock.calls.length} were made`);
  const [input, init] = call;
  return { url: String(input), method: init?.method ?? "GET", init: init ?? {} };
}

/**
 * The recorded requests made with `method`, in order — the reader behind "did
 * it PUT, and with what body".
 *
 * Eight assertions across three suites had rebuilt the same
 * `mock.calls.find(([, init]) => init?.method === "PUT")` predicate, six of them
 * casting `init` back to `RequestInit` although the mock is already typed as
 * `fetch` itself. Defaulting is {@link fetchCall}'s, so a GET matches whether or
 * not the caller named one.
 */
export function fetchCallsWith(
  mock: FetchMock,
  method: string,
): { url: string; method: string; init: RequestInit }[] {
  return mock.mock.calls
    .map((_call, index) => fetchCall(mock, index))
    .filter((call) => call.method === method);
}

/** Every recorded request as `"METHOD /url"`, in order. */
export function fetchLines(mock: FetchMock): string[] {
  return mock.mock.calls.map((_call, index) => {
    const { url, method } = fetchCall(mock, index);
    return `${method} ${url}`;
  });
}

/**
 * Render `ui` under its own `QueryClient`, and hand back the client so a test
 * can spy on it.
 *
 * One client per render (never a module-level one) so no test inherits
 * another's cache, and `retry: false` so a test asserting an error state gets
 * it on the first answer rather than waiting out three backoffs. Five suites
 * had rebuilt this same pair by hand.
 */
export function renderWithClient(ui: ReactNode): RenderResult & { client: QueryClient } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { ...render(createElement(QueryClientProvider, { client }, ui)), client };
}

/**
 * The one button with this accessible name, typed — so `.disabled` reads off
 * it without an `as HTMLButtonElement` at each assertion. The `instanceof` is
 * the check that cast skipped: a role that resolved to an `<a>` or a `<div
 * role="button">` has no `disabled`, and `undefined === true` is a quiet
 * false rather than a failure that names the reason.
 */
export function button(name: string | RegExp): HTMLButtonElement {
  const found = screen.getByRole("button", { name });
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`Expected a <button> named ${String(name)}, got <${found.localName}>`);
  }
  return found;
}

/**
 * The `<input>` with this accessible name, typed so `.value` / `.checked`
 * read off it without a cast. `by` picks how it is named — a labelled field
 * ("label", the default) or a role's accessible name, which is how the
 * segmented control's radios are found.
 */
export function input(name: string, by: "label" | "radio" = "label"): HTMLInputElement {
  const found = by === "label" ? screen.getByLabelText(name) : screen.getByRole("radio", { name });
  if (!(found instanceof HTMLInputElement)) {
    throw new Error(`Expected an <input> named ${name}, got <${found.localName}>`);
  }
  return found;
}

/** The textarea carrying this placeholder, typed so `.value` needs no cast. */
export function textarea(placeholder: string | RegExp): HTMLTextAreaElement {
  const found = screen.getByPlaceholderText(placeholder);
  if (!(found instanceof HTMLTextAreaElement)) {
    throw new Error(`Expected a <textarea> placeholdered ${String(placeholder)}`);
  }
  return found;
}

/**
 * jsdom has no `ResizeObserver`, and `use-stick-to-bottom` — mounted with the
 * chat transcript — constructs one. Layout never changes here, so every method
 * is a no-op; what matters is that the constructor exists.
 */
export function installResizeObserver(): void {
  class ResizeObserverStub {
    observe(): void {
      // jsdom stub — layout never changes.
    }
    unobserve(): void {
      // jsdom stub.
    }
    disconnect(): void {
      // jsdom stub.
    }
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
}
