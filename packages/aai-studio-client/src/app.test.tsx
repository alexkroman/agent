// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The stale-key path: a 401 from the REST queries must REFRESH the bearer
// rather than strand the user on dead requests — and rather than sign them out
// of a session that was still recoverable (see auth-recovery.ts) — and the
// routing into a project. What an OPEN project reads is project-view.test.tsx's.

import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  installResizeObserver,
  jsonResponse,
  renderWithClient,
  sseResponse,
  stubFetch,
} from "./_test-utils.ts";
import { App } from "./app.tsx";

function renderApp(
  onSignOut: () => void,
  refreshAuth: () => Promise<void> = () => Promise.resolve(),
) {
  return renderWithClient(<App bearer="sk-test" onSignOut={onSignOut} refreshAuth={refreshAuth} />);
}

/** Landing always shows the hero — opening a project is a sidebar click. */
async function openProject(name: string) {
  await waitFor(() => expect(screen.getByRole("button", { name })).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name }));
}

beforeEach(() => {
  installResizeObserver();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Selection syncs the URL (v0-style project paths); jsdom keeps the
  // location across tests, so reset it or a later render inherits it.
  window.history.replaceState(null, "", "/");
});

describe("App auth handling", () => {
  test("a 401 on the project list refreshes the bearer instead of signing out", async () => {
    // The regression: supabase-js pauses its refresh ticker on hidden tabs, so
    // focusing a tab that sat for an hour refetches with an expired — but
    // REFRESHABLE — access token. Signing out there revokes the refresh token
    // on a live session, and races supabase-js's own focus refresh.
    stubFetch({
      "/studio/status": () => jsonResponse({ provider: "assemblyai", model: "gpt-5.5" }),
      "/studio/events": sseResponse,
      "/studio/projects": () => jsonResponse({ error: "unauthorized" }, 401),
    });
    const onSignOut = vi.fn();
    const refreshAuth = vi.fn(() => Promise.resolve());
    renderApp(onSignOut, refreshAuth);
    await waitFor(() => expect(refreshAuth).toHaveBeenCalled());
    expect(onSignOut).not.toHaveBeenCalled();
  });

  test("a bearer that stays rejected after its refresh budget signs the user out", async () => {
    // The terminal state. A server that will 401 a refreshable token (a
    // different Supabase project, a JWT-secret mismatch, clock skew) must not
    // become an unbounded refresh+refetch loop — the sign-in gate is somewhere
    // the user can act.
    stubFetch({
      "/studio/status": () => jsonResponse({ provider: "assemblyai", model: "gpt-5.5" }),
      "/studio/events": sseResponse,
      "/studio/projects": () => jsonResponse({ error: "unauthorized" }, 401),
    });
    const onSignOut = vi.fn();
    // Each render mints a new bearer, standing in for a refresh that "succeeds"
    // and produces a token the server rejects just the same.
    const { rerender, client } = renderWithClient(
      <App bearer="t1" onSignOut={onSignOut} refreshAuth={() => Promise.resolve()} />,
    );
    for (const bearer of ["t2", "t3", "t4"]) {
      rerender(
        <QueryClientProvider client={client}>
          <App bearer={bearer} onSignOut={onSignOut} refreshAuth={() => Promise.resolve()} />
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(screen.getByText(/No projects yet|Loading projects/)).toBeDefined(),
      );
    }
    await waitFor(() => expect(onSignOut).toHaveBeenCalled());
  });

  test("a 401 from an event stream refreshes the session rather than retrying the dead token", async () => {
    // The regression: an access token that expired while the tab sat in the
    // background is rejected on every resubscribe, and supabase-js does not
    // refresh a hidden tab — so without this the stream polls a token nobody
    // will accept, forever, at the floor backoff.
    stubFetch({
      "/studio/status": () => jsonResponse({ provider: "assemblyai", model: "gpt-5.5" }),
      "/studio/events": () => jsonResponse({ error: "unauthorized" }, 401),
      "/studio/projects": () => jsonResponse({ projects: [] }),
    });
    const refreshAuth = vi.fn(() => Promise.resolve());
    renderApp(vi.fn(), refreshAuth);
    await waitFor(() => expect(refreshAuth).toHaveBeenCalled());
  });

  test("an authorized empty project list renders the hero prompt box, no sign-out", async () => {
    stubFetch({
      "/studio/status": () => jsonResponse({ provider: "assemblyai", model: "gpt-5.5" }),
      "/studio/events": sseResponse,
      "/studio/projects/demo/events": sseResponse,
      "/studio/projects": () => jsonResponse({ projects: [] }),
    });
    const onSignOut = vi.fn();
    renderApp(onSignOut);
    await waitFor(() => expect(screen.getByText("What should your voice agent do?")).toBeDefined());
    await waitFor(() => expect(screen.getByText(/No projects yet/)).toBeDefined());
    expect(onSignOut).not.toHaveBeenCalled();
  });
});

describe("opening a project", () => {
  const demoRoutes = {
    "/studio/status": () => jsonResponse({ provider: "assemblyai", model: "gpt-5.5" }),
    "/studio/events": sseResponse,
    "/studio/projects/demo/events": sseResponse,
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
    await waitFor(() => expect(screen.getByText(/Welcome to AssemblyAI Build/)).toBeDefined());
    const paths = fetchMock.mock.calls.map(
      (c) => new URL(String(c[0]), "http://studio.test").pathname,
    );
    expect(paths).toContain("/studio/projects/demo");
  });
});
