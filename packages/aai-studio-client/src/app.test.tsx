// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The stale-key path: a 401 from the REST queries must sign the user out
// (clearing the stored key) rather than strand them on dead requests.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { jsonResponse, stubFetch } from "./_test-utils.ts";
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
  // Selection syncs the URL (v0-style project paths); jsdom keeps the
  // location across tests, so reset it or a later render inherits it.
  window.history.replaceState(null, "", "/");
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
    await waitFor(() => expect(screen.getByText(/No projects yet/)).toBeDefined());
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

  test("opening a project syncs the v0-style URL", async () => {
    stubFetch({
      ...demoRoutes,
      "/studio/projects/demo/chat": () => jsonResponse({ messages: [] }),
    });
    renderApp(vi.fn());
    await openProject("demo");
    await waitFor(() => expect(window.location.pathname).toBe("/studio/chat/demo"));
  });

  test("loading a /studio/chat/<name> URL opens that project directly", async () => {
    window.history.replaceState(null, "", "/studio/chat/demo");
    const fetchMock = stubFetch({
      ...demoRoutes,
      "/studio/projects/demo/chat": () => jsonResponse({ messages: [] }),
    });
    renderApp(vi.fn());
    // Straight into the project chat — no hero, no sidebar click.
    await waitFor(() =>
      expect(screen.getByText(/Welcome to AssemblyAI App Builder/)).toBeDefined(),
    );
    const paths = fetchMock.mock.calls.map(
      (c) => new URL(String(c[0]), "http://studio.test").pathname,
    );
    expect(paths).toContain("/studio/projects/demo");
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

  test("a broker failure during a restart retries and connects without a reload", async () => {
    // The reported wedge: open a chat while the server restarts and the
    // panel sat on "Starting sandbox…" forever, even once a sandbox was
    // available. Transient broker failures must retry behind that state.
    let calls = 0;
    stubFetch({
      ...demoRoutes,
      "/studio/projects/demo/chat": () => jsonResponse({ messages: [] }),
      "/studio/projects/demo/session": () =>
        ++calls === 1
          ? jsonResponse({ error: "service unavailable" }, 503)
          : jsonResponse({ url: "http://studio.test/sandbox/studio/chat" }),
    });
    renderApp(vi.fn());
    await openProject("demo");
    // Holds on the boot state while the retry rides out the restart…
    await waitFor(() => expect(screen.getByText("Starting sandbox…")).toBeDefined());
    // …then connects on its own once the broker answers (first retry ~1s).
    await waitFor(
      () => expect(screen.getByText(/Welcome to AssemblyAI App Builder/)).toBeDefined(),
      { timeout: 4000 },
    );
    expect(calls).toBe(2);
  });

  test("a 4xx broker answer fails immediately, and Try again re-brokers in place", async () => {
    let calls = 0;
    stubFetch({
      ...demoRoutes,
      "/studio/projects/demo/chat": () => jsonResponse({ messages: [] }),
      "/studio/projects/demo/session": () =>
        ++calls === 1
          ? jsonResponse({ error: "Project not found" }, 404)
          : jsonResponse({ url: "http://studio.test/sandbox/studio/chat" }),
    });
    renderApp(vi.fn());
    await openProject("demo");
    await waitFor(() =>
      expect(screen.getByText(/Could not start the project's sandbox/)).toBeDefined(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByText(/Welcome to AssemblyAI App Builder/)).toBeDefined(),
    );
    expect(calls).toBe(2);
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
