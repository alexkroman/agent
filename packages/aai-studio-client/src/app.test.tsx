// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The stale-key path: a 401 from the REST queries must REFRESH the bearer
// rather than strand the user on dead requests — and rather than sign them out
// of a session that was still recoverable (see auth-recovery.ts).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { jsonResponse, sseResponse, stubFetch } from "./_test-utils.ts";
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

function renderApp(
  onSignOut: () => void,
  refreshAuth: () => Promise<void> = () => Promise.resolve(),
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App bearer="sk-test" onSignOut={onSignOut} refreshAuth={refreshAuth} />
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
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Each render mints a new bearer, standing in for a refresh that "succeeds"
    // and produces a token the server rejects just the same.
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <App bearer="t1" onSignOut={onSignOut} refreshAuth={() => Promise.resolve()} />
      </QueryClientProvider>,
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

  test("a failed workspace fetch surfaces an error banner instead of an empty project", async () => {
    stubFetch({
      "/studio/status": () => jsonResponse({ provider: "assemblyai", model: "gpt-5.5" }),
      "/studio/events": sseResponse,
      "/studio/projects/demo/events": sseResponse,
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
    expect(screen.queryByText(/Welcome to AssemblyAI Build/)).toBeNull();
  });

  test("a project with no history shows the empty chat, not a stuck loader", async () => {
    stubFetch({
      ...demoRoutes,
      "/studio/projects/demo/chat": () => jsonResponse({ messages: [] }),
    });
    renderApp(vi.fn());
    await openProject("demo");
    await waitFor(() => expect(screen.getByText(/Welcome to AssemblyAI Build/)).toBeDefined());
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
    // Holds on the boot note while the retry rides out the restart…
    await waitFor(() => expect(screen.getByText("Starting sandbox…")).toBeDefined());
    // …then connects on its own once the broker answers (first retry ~1s).
    // The note going away is the signal, not the welcome bubble: that renders
    // over the restored (here empty) history from the first paint.
    await waitFor(() => expect(screen.queryByText("Starting sandbox…")).toBeNull(), {
      timeout: 4000,
    });
    expect(screen.getByPlaceholderText("Describe your agent…")).toBeDefined();
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
      expect(screen.queryByText(/Could not start the project's sandbox/)).toBeNull(),
    );
    expect(screen.getByPlaceholderText("Describe your agent…")).toBeDefined();
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
    expect(screen.queryByText(/Welcome to AssemblyAI Build/)).toBeNull();
  });

  test("the conversation renders while the sandbox is still being brokered", async () => {
    // The history is a row read and the sandbox is a container boot, so
    // gating the transcript on the broker showed nothing for seconds on a
    // project whose whole conversation was already in hand.
    stubFetch({
      ...demoRoutes,
      "/studio/projects/demo/chat": () =>
        jsonResponse({
          messages: [
            { id: "m1", role: "user", parts: [{ type: "text", text: "build a pizza bot" }] },
          ],
        }),
      // Never resolves — the transcript must not wait on it.
      "/studio/projects/demo/session": () =>
        new Response(new ReadableStream(), { headers: { "Content-Type": "application/json" } }),
    });
    renderApp(vi.fn());
    await openProject("demo");
    await waitFor(() => expect(screen.getByText("build a pizza bot")).toBeDefined());
    // The wait is said under the last message, and it is SENDING that waits.
    expect(screen.getByText("Starting sandbox…")).toBeDefined();
    expect((screen.getByLabelText("Send") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a message typed while the sandbox starts is held, then handed to the live composer", async () => {
    // The field stays live through the wait, so a thought had while the
    // container boots isn't lost — and the component swap underneath it
    // (pre-sandbox view → live chat) must not take the text with it.
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
    const waiting = await waitFor(() => screen.getByPlaceholderText(/Starting sandbox/));
    fireEvent.change(waiting, { target: { value: "make it italian" } });
    fireEvent.keyDown(waiting, { key: "Enter" });
    // Submitting early neither sends nor clears: there is nothing to send to.
    expect((waiting as HTMLTextAreaElement).value).toBe("make it italian");

    const live = await waitFor(() => screen.getByPlaceholderText("Describe your agent…"), {
      timeout: 4000,
    });
    expect((live as HTMLTextAreaElement).value).toBe("make it italian");
  });
});
