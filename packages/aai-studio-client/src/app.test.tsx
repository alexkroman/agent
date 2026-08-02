// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The stale-key path: a 401 from the REST queries must sign the user out
// (clearing the stored key) rather than strand them on dead requests.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/** Landing always shows the hero — opening a project is a sidebar click. */
async function openProject(name: string) {
  await waitFor(() => expect(screen.getByRole("button", { name })).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name }));
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

  test("an authorized empty project list renders the hero prompt box, no sign-out", async () => {
    stubFetch({
      "/studio/status": () => jsonResponse({ llm: true }),
      "/studio/projects": () => jsonResponse({ projects: [] }),
    });
    const onSignOut = vi.fn();
    renderApp(onSignOut);
    await waitFor(() => expect(screen.getByText("What should your voice agent do?")).toBeDefined());
    expect(screen.getByText("No project yet")).toBeDefined();
    expect(onSignOut).not.toHaveBeenCalled();
  });

  test("a failed workspace fetch surfaces an error banner instead of an empty project", async () => {
    stubFetch({
      "/studio/status": () => jsonResponse({ llm: true }),
      "/studio/projects": () => jsonResponse({ projects: ["demo"] }),
      "/studio/projects/demo": () => jsonResponse({ error: "storage exploded" }, 500),
      "/studio/projects/demo/chat": () => jsonResponse({ messages: [] }),
      "/studio/projects/demo/session": () =>
        jsonResponse({ url: "http://studio.test/sandbox/studio/chat" }),
      "/sandbox/studio/tools": () => jsonResponse({ tools: [] }),
    });
    const onSignOut = vi.fn();
    renderApp(onSignOut);
    await openProject("demo");
    await waitFor(() => expect(screen.getByText(/storage exploded/)).toBeDefined());
    expect(onSignOut).not.toHaveBeenCalled();
  });
});

describe("chat history hydration", () => {
  const demoRoutes = {
    "/studio/status": () => jsonResponse({ llm: true }),
    "/studio/projects": () => jsonResponse({ projects: ["demo"] }),
    "/studio/projects/demo": () => jsonResponse({ files: { "agent.ts": "x" } }),
    "/studio/projects/demo/session": () =>
      jsonResponse({ url: "http://studio.test/sandbox/studio/chat" }),
    "/sandbox/studio/tools": () =>
      jsonResponse({ tools: [{ name: "bash", label: "Run command" }] }),
  };

  test("landing shows the hero even when projects exist — no auto-open", async () => {
    stubFetch({
      ...demoRoutes,
      "/studio/projects/demo/chat": () => jsonResponse({ messages: [] }),
    });
    renderApp(vi.fn());
    await waitFor(() => expect(screen.getByText("What should your voice agent do?")).toBeDefined());
    // The previous project waits in the sidebar instead.
    await waitFor(() => expect(screen.getByRole("button", { name: "demo" })).toBeDefined());
  });

  test("a persisted conversation renders when the project opens", async () => {
    stubFetch({
      ...demoRoutes,
      "/studio/projects/demo/chat": () =>
        jsonResponse({
          messages: [
            { id: "m1", role: "user", parts: [{ type: "text", text: "build a pizza bot" }] },
            { id: "m2", role: "assistant", parts: [{ type: "text", text: "Done — pizza bot" }] },
          ],
        }),
    });
    renderApp(vi.fn());
    await openProject("demo");
    await waitFor(() => expect(screen.getByText("build a pizza bot")).toBeDefined());
    expect(screen.getByText(/Done — pizza bot/)).toBeDefined();
    // Hydrated history means no "new chat" welcome bubble.
    expect(screen.queryByText(/Welcome to AssemblyAI App Builder/)).toBeNull();
  });

  test("a project with no history shows the empty chat, not a stuck loader", async () => {
    stubFetch({
      ...demoRoutes,
      "/studio/projects/demo/chat": () => jsonResponse({ messages: [] }),
    });
    renderApp(vi.fn());
    await openProject("demo");
    await waitFor(() =>
      expect(screen.getByText(/Welcome to AssemblyAI App Builder/)).toBeDefined(),
    );
    expect(screen.queryByText("Loading conversation…")).toBeNull();
  });

  test("while the history loads, the panel holds instead of flashing a new chat", async () => {
    stubFetch({
      ...demoRoutes,
      // Never resolves — the loading state must persist, not fall through.
      "/studio/projects/demo/chat": () =>
        new Response(new ReadableStream(), { headers: { "Content-Type": "application/json" } }),
    });
    renderApp(vi.fn());
    await openProject("demo");
    await waitFor(() => expect(screen.getByText("Loading conversation…")).toBeDefined());
    expect(screen.queryByText(/Welcome to AssemblyAI App Builder/)).toBeNull();
  });
});
