// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Settings pane: a full page (not a dropdown), whose main section is
// deployed-agent secrets talking to the platform's own /:slug/secret routes.
// Unpublished projects get the "publish first" gate, and every successful
// change posts a note into the chat so the coding agent knows which keys
// exist — values never included. The CLI and delete sections work with no
// published slug at all.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { jsonResponse, stubFetch } from "./_test-utils.ts";
import { SettingsPane } from "./settings.tsx";

/**
 * The pane also renders the Database card, which reads its own state on
 * mount. Spread into every route table here so the secrets assertions below
 * don't have to know about it (the card itself is covered by
 * database-card.test.tsx).
 */
const DATABASE_STATE = {
  "GET /studio/projects/demo/database": () =>
    jsonResponse({ enabled: false, configured: true, environments: [] }),
};

/** How many requests this mock saw for one path — counts survive the card's own. */
function callsTo(fetchMock: ReturnType<typeof stubFetch>, path: string): number {
  return fetchMock.mock.calls.filter(([input]) => String(input) === path).length;
}

function renderPanel(slug: string | undefined, onNotifyChat = vi.fn(), onDeleteProject = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsPane
        bearer="sk-test"
        project="demo"
        slug={slug}
        onNotifyChat={onNotifyChat}
        onDeleteProject={onDeleteProject}
        deleting={false}
      />
    </QueryClientProvider>,
  );
  return onNotifyChat;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsPane", () => {
  test("unpublished projects get the publish-first gate, no secret requests", () => {
    const fetchMock = stubFetch({ ...DATABASE_STATE });
    renderPanel(undefined);
    expect(screen.getByText(/Publish the project first/)).toBeTruthy();
    expect(callsTo(fetchMock, "/demo/secret")).toBe(0);
  });

  test("the CLI section renders with no published slug — pulling needs no deploy", () => {
    stubFetch({ ...DATABASE_STATE });
    renderPanel(undefined);
    expect(screen.getByText("aai pull demo")).toBeTruthy();
    expect(screen.getByText("Work locally")).toBeTruthy();
  });

  test("lists the deployed agent's secret names", async () => {
    stubFetch({
      ...DATABASE_STATE,
      "GET /demo/secret": () => jsonResponse({ vars: ["OPENAI_API_KEY"] }),
    });
    renderPanel("demo");
    await waitFor(() => {
      expect(screen.getByText("OPENAI_API_KEY")).toBeTruthy();
    });
  });

  test("saving secrets PUTs them and posts a chat note without the values", async () => {
    stubFetch({
      ...DATABASE_STATE,
      "GET /demo/secret": () => jsonResponse({ vars: [] }),
      "PUT /demo/secret": () => jsonResponse({ ok: true, keys: ["MY_KEY"] }),
    });
    const notify = renderPanel("demo");
    fireEvent.change(screen.getByPlaceholderText("OPENAI_API_KEY=..."), {
      target: { value: "MY_KEY=super-secret-value" },
    });
    fireEvent.click(screen.getByText("Save secrets"));
    await waitFor(() => {
      expect(notify).toHaveBeenCalledTimes(1);
    });
    const note = notify.mock.calls[0]?.[0] as string;
    expect(note).toContain("MY_KEY");
    expect(note).not.toContain("super-secret-value");
  });

  test("saving multiple secrets pluralizes the chat note", async () => {
    stubFetch({
      ...DATABASE_STATE,
      "GET /demo/secret": () => jsonResponse({ vars: [] }),
      "PUT /demo/secret": () => jsonResponse({ ok: true, keys: ["A", "B"] }),
    });
    const notify = renderPanel("demo");
    fireEvent.change(screen.getByPlaceholderText("OPENAI_API_KEY=..."), {
      target: { value: "A=1\nB=2" },
    });
    fireEvent.click(screen.getByText("Save secrets"));
    await waitFor(() => {
      expect(notify).toHaveBeenCalledTimes(1);
    });
    expect(notify.mock.calls[0]?.[0]).toContain("secrets A, B");
  });

  test("saving an empty draft is a no-op — no request, no note", async () => {
    const fetchMock = stubFetch({
      ...DATABASE_STATE,
      "GET /demo/secret": () => jsonResponse({ vars: [] }),
    });
    const notify = renderPanel("demo");
    await waitFor(() => {
      expect(callsTo(fetchMock, "/demo/secret")).toBe(1);
    });
    fireEvent.click(screen.getByText("Save secrets"));
    expect(callsTo(fetchMock, "/demo/secret")).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });

  test("a failed listing surfaces the server's error message", async () => {
    stubFetch({
      ...DATABASE_STATE,
      "GET /demo/secret": () => jsonResponse({ error: "unauthorized" }, 401),
    });
    renderPanel("demo");
    await waitFor(() => {
      expect(screen.getByText("unauthorized")).toBeTruthy();
    });
  });

  test("a failed save surfaces its error and posts no note", async () => {
    stubFetch({
      ...DATABASE_STATE,
      "GET /demo/secret": () => jsonResponse({ vars: [] }),
      "PUT /demo/secret": () => jsonResponse({ error: "vault unavailable" }, 503),
    });
    const notify = renderPanel("demo");
    fireEvent.change(screen.getByPlaceholderText("OPENAI_API_KEY=..."), {
      target: { value: "A=1" },
    });
    fireEvent.click(screen.getByText("Save secrets"));
    await waitFor(() => {
      expect(screen.getByText("vault unavailable")).toBeTruthy();
    });
    expect(notify).not.toHaveBeenCalled();
  });

  test("deleting a secret posts a chat note", async () => {
    stubFetch({
      ...DATABASE_STATE,
      "GET /demo/secret": () => jsonResponse({ vars: ["OLD_KEY"] }),
      "DELETE /demo/secret/OLD_KEY": () => jsonResponse({ ok: true }),
    });
    const notify = renderPanel("demo");
    await waitFor(() => {
      expect(screen.getByText("OLD_KEY")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() => {
      expect(notify).toHaveBeenCalledTimes(1);
    });
    expect(notify.mock.calls[0]?.[0]).toContain("deleted the secret OLD_KEY");
  });

  test("ASSEMBLYAI_API_KEY is neither listed nor deletable", async () => {
    // It is seeded at publish from the caller's account key; deleting it
    // takes the agent off the air with nothing in this pane to restore it.
    stubFetch({
      ...DATABASE_STATE,
      "GET /demo/secret": () => jsonResponse({ vars: ["ASSEMBLYAI_API_KEY", "OPENAI_API_KEY"] }),
    });
    renderPanel("demo");
    await waitFor(() => {
      expect(screen.getByText("OPENAI_API_KEY")).toBeTruthy();
    });
    // The blurb still names it; the LIST must not — and with no row, there
    // is nothing to hang a Delete button on.
    expect(screen.queryByRole("listitem", { name: /ASSEMBLYAI_API_KEY/ })).toBeNull();
    expect(screen.getAllByText("Delete")).toHaveLength(1);
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(rows.some((text) => text?.includes("ASSEMBLYAI_API_KEY"))).toBe(false);
  });

  test("a managed key typed into the box is refused rather than saved and hidden", async () => {
    const fetchMock = stubFetch({
      ...DATABASE_STATE,
      "GET /demo/secret": () => jsonResponse({ vars: [] }),
      "PUT /demo/secret": () => jsonResponse({ ok: true, keys: ["OPENAI_API_KEY"] }),
    });
    const notify = renderPanel("demo");
    await waitFor(() => expect(callsTo(fetchMock, "/demo/secret")).toBe(1));
    fireEvent.change(screen.getByPlaceholderText("OPENAI_API_KEY=..."), {
      target: { value: "ASSEMBLYAI_API_KEY=leaked\nOPENAI_API_KEY=ok" },
    });
    fireEvent.click(screen.getByText("Save secrets"));
    await waitFor(() => {
      expect(screen.getByText(/managed for you and can't be set here/)).toBeTruthy();
    });
    // The rest of the draft still saved; only the managed key was dropped.
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PUT");
    expect(put?.[1]?.body).toContain("OPENAI_API_KEY");
    expect(put?.[1]?.body).not.toContain("ASSEMBLYAI_API_KEY");
    expect(notify.mock.calls[0]?.[0]).not.toContain("ASSEMBLYAI_API_KEY");
  });

  test("a draft of nothing but managed keys sends no request at all", async () => {
    const fetchMock = stubFetch({
      ...DATABASE_STATE,
      "GET /demo/secret": () => jsonResponse({ vars: [] }),
    });
    const notify = renderPanel("demo");
    await waitFor(() => expect(callsTo(fetchMock, "/demo/secret")).toBe(1));
    fireEvent.change(screen.getByPlaceholderText("OPENAI_API_KEY=..."), {
      target: { value: "ASSEMBLYAI_API_KEY=leaked" },
    });
    fireEvent.click(screen.getByText("Save secrets"));
    expect(screen.getByText(/managed for you and can't be set here/)).toBeTruthy();
    expect(callsTo(fetchMock, "/demo/secret")).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });

  test("Delete project asks for confirmation before firing", () => {
    stubFetch({ ...DATABASE_STATE });
    const onDeleteProject = vi.fn();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    renderPanel(undefined, vi.fn(), onDeleteProject);
    fireEvent.click(screen.getByText("Delete project"));
    expect(onDeleteProject).not.toHaveBeenCalled();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    fireEvent.click(screen.getByText("Delete project"));
    expect(onDeleteProject).toHaveBeenCalledTimes(1);
  });

  test("Delete project is available even on published projects", async () => {
    stubFetch({
      ...DATABASE_STATE,
      "GET /demo/secret": () => jsonResponse({ vars: [] }),
    });
    renderPanel("demo");
    await waitFor(() => {
      expect(screen.getByText("Delete project")).toBeTruthy();
    });
  });
});
