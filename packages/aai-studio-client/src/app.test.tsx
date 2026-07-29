// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The stale-key path: a 401 from the REST queries must sign the user out
// (clearing the stored key) rather than strand them on dead requests.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "./app.tsx";

// jsdom has no ResizeObserver; use-stick-to-bottom (mounted once a project
// is selected) requires one.
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Route fetch by path — each call gets a fresh Response (bodies are single-use). */
function stubFetch(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://studio.test").pathname;
    const make = routes[path];
    if (!make) throw new Error(`Unexpected fetch: ${path}`);
    return Promise.resolve(make());
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderApp(onSignOut: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App apiKey="sk-test" onSignOut={onSignOut} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  // No vitest globals in this project, so RTL's automatic cleanup never
  // registers — unmount explicitly or renders leak across tests.
  cleanup();
  vi.unstubAllGlobals();
});

describe("App auth handling", () => {
  test("a 401 on the project list signs the user out", async () => {
    stubFetch({
      "/studio/status": () => jsonResponse({ llm: false }),
      "/studio/projects": () => jsonResponse({ error: "unauthorized" }, 401),
    });
    const onSignOut = vi.fn();
    renderApp(onSignOut);
    await waitFor(() => expect(onSignOut).toHaveBeenCalled());
  });

  test("an authorized empty project list renders the guided start, no sign-out", async () => {
    stubFetch({
      "/studio/status": () => jsonResponse({ llm: true }),
      "/studio/projects": () => jsonResponse({ projects: [] }),
    });
    const onSignOut = vi.fn();
    renderApp(onSignOut);
    await waitFor(() => expect(screen.getByText("No project yet")).toBeDefined());
    expect(onSignOut).not.toHaveBeenCalled();
  });

  test("a failed workspace fetch surfaces an error banner instead of an empty project", async () => {
    stubFetch({
      "/studio/status": () => jsonResponse({ llm: true }),
      "/studio/projects": () => jsonResponse({ projects: ["demo"] }),
      "/studio/projects/demo": () => jsonResponse({ error: "storage exploded" }, 500),
    });
    const onSignOut = vi.fn();
    renderApp(onSignOut);
    await waitFor(() => expect(screen.getByText(/storage exploded/)).toBeDefined());
    expect(onSignOut).not.toHaveBeenCalled();
  });
});
