// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// Everything that exists only while a project is open: its workspace read,
// its persisted chat history, and the brokered sandbox the chat runs on.
//
// Moved from app.test.tsx, and rendered as `ProjectView` itself rather than
// through the app's sidebar click — opening a project is App's (routing and
// the URL sync stay in app.test.tsx); what the open project then reads, and
// how each read failing or hanging reaches the screen, is this component's.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  button,
  installResizeObserver,
  jsonResponse,
  renderWithClient,
  sseResponse,
  stubFetch,
  textarea,
} from "./_test-utils.ts";
import { ProjectView } from "./project-view.tsx";

/** The `demo` project open, with the chat status already in hand. */
function renderProject() {
  const onLogOut = vi.fn();
  renderWithClient(
    <ProjectView
      bearer="sk-test"
      project="demo"
      chatStatus={{ provider: "assemblyai", model: "gpt-5.5" }}
      refreshAuth={() => Promise.resolve()}
      initialPrompt={null}
      onInitialPromptSent={vi.fn()}
      onGoHome={vi.fn()}
      onLogOut={onLogOut}
      accountOpen={false}
      onToggleAccount={vi.fn()}
    />,
  );
  return { onLogOut };
}

beforeEach(() => {
  installResizeObserver();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProjectView workspace", () => {
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
    const { onLogOut } = renderProject();
    await waitFor(() => expect(screen.getByText(/storage exploded/)).toBeDefined());
    expect(onLogOut).not.toHaveBeenCalled();
  });
});

describe("ProjectView chat history and sandbox", () => {
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
    renderProject();
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
    renderProject();
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
    renderProject();
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
    renderProject();
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
    renderProject();
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
    renderProject();
    await waitFor(() => expect(screen.getByText("build a pizza bot")).toBeDefined());
    // The wait is said under the last message, and it is SENDING that waits.
    expect(screen.getByText("Starting sandbox…")).toBeDefined();
    expect(button("Send").disabled).toBe(true);
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
    renderProject();
    const waiting = await waitFor(() => textarea(/Starting sandbox/));
    fireEvent.change(waiting, { target: { value: "make it italian" } });
    fireEvent.keyDown(waiting, { key: "Enter" });
    // Submitting early neither sends nor clears: there is nothing to send to.
    expect(waiting.value).toBe("make it italian");

    const live = await waitFor(() => textarea("Describe your agent…"), { timeout: 4000 });
    expect(live.value).toBe("make it italian");
  });
});
