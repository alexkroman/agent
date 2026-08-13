// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Settings pane: a full page (not a dropdown), whose main section is
// project secrets talking to /studio/projects/:project/secret — the server
// writes both of a project's agents AND the project's own record, so the pane
// no longer mirrors anything and needs no publish first. Every successful
// change posts a note into the chat so the coding agent knows which keys
// exist — values never included. Every section works with no published slug,
// and they run in a fixed order (Work locally, Phone number, Database,
// Secrets, Danger zone) that the Phone card's copy points into.

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

function renderPanel(onNotifyChat = vi.fn(), onDeleteProject = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsPane
        bearer="sk-test"
        project="demo"
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
  test("the sections run in the order a project needs them", async () => {
    // Setting up first, provider keys last: the CLI round-trip, the webhook
    // URLs, the Database switch, the Workflows read, Secrets, and Delete
    // project at the bottom. Workflows sits with Database because the two are
    // one subject — the correlation index a run is found by is a table in the
    // project's own schema, so a workflow app has storage on.
    // The order is also what two pieces of Phone card copy point at — both
    // send the reader to "Secrets below" for a carrier's signing secret.
    stubFetch({
      ...DATABASE_STATE,
      "GET /studio/projects/demo/secret": () => jsonResponse({ vars: [], pending: [] }),
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Database")).toBeTruthy());
    // Card titles are eyebrow spans rather than headings, and inside this
    // pane every one of them is a section title.
    const titles = [...document.querySelectorAll(".eyebrow")].map((el) => el.textContent);
    expect(titles).toEqual([
      "Work locally",
      "Phone number",
      "Database",
      "Workflows",
      "Secrets",
      "Danger zone",
    ]);
  });

  test("the box is usable with nothing published — no publish-first gate", async () => {
    // An agent needs its provider key to RUN, so requiring a publish first
    // asked for the one order that cannot work: ship it broken, attach the
    // key, ship again.
    const fetchMock = stubFetch({
      ...DATABASE_STATE,
      "GET /studio/projects/demo/secret": () => jsonResponse({ vars: [], pending: [] }),
    });
    renderPanel();
    await waitFor(() => expect(callsTo(fetchMock, "/studio/projects/demo/secret")).toBe(1));
    expect(screen.queryByText(/Publish the project first/)).toBeNull();
    expect(screen.getByText("Save secrets")).toBeTruthy();
  });

  test("the CLI section renders with no published slug — pulling needs no deploy", () => {
    stubFetch({ ...DATABASE_STATE });
    renderPanel();
    expect(screen.getByText("aai pull demo")).toBeTruthy();
    expect(screen.getByText("Work locally")).toBeTruthy();
  });

  test("lists the project's secret names", async () => {
    stubFetch({
      ...DATABASE_STATE,
      "GET /studio/projects/demo/secret": () => jsonResponse({ vars: ["OPENAI_API_KEY"] }),
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("OPENAI_API_KEY")).toBeTruthy();
    });
  });

  test("a name no deployed agent carries yet says so, rather than reading as live", async () => {
    stubFetch({
      ...DATABASE_STATE,
      "GET /studio/projects/demo/secret": () =>
        jsonResponse({ vars: ["LIVE_KEY", "NEW_KEY"], pending: ["NEW_KEY"] }),
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText("NEW_KEY")).toBeTruthy());
    expect(screen.getAllByText("on next deploy")).toHaveLength(1);
  });

  test("saving secrets PUTs them and posts a chat note without the values", async () => {
    stubFetch({
      ...DATABASE_STATE,
      "GET /studio/projects/demo/secret": () => jsonResponse({ vars: [] }),
      "PUT /studio/projects/demo/secret": () => jsonResponse({ ok: true, keys: ["MY_KEY"] }),
    });
    const notify = renderPanel();
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
      "GET /studio/projects/demo/secret": () => jsonResponse({ vars: [] }),
      "PUT /studio/projects/demo/secret": () => jsonResponse({ ok: true, keys: ["A", "B"] }),
    });
    const notify = renderPanel();
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
      "GET /studio/projects/demo/secret": () => jsonResponse({ vars: [] }),
    });
    const notify = renderPanel();
    await waitFor(() => {
      expect(callsTo(fetchMock, "/studio/projects/demo/secret")).toBe(1);
    });
    fireEvent.click(screen.getByText("Save secrets"));
    expect(callsTo(fetchMock, "/studio/projects/demo/secret")).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });

  test("a failed listing surfaces the server's error message", async () => {
    stubFetch({
      ...DATABASE_STATE,
      "GET /studio/projects/demo/secret": () => jsonResponse({ error: "unauthorized" }, 401),
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("unauthorized")).toBeTruthy();
    });
  });

  test("a failed save surfaces its error and posts no note", async () => {
    stubFetch({
      ...DATABASE_STATE,
      "GET /studio/projects/demo/secret": () => jsonResponse({ vars: [] }),
      "PUT /studio/projects/demo/secret": () => jsonResponse({ error: "vault unavailable" }, 503),
    });
    const notify = renderPanel();
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
      "GET /studio/projects/demo/secret": () => jsonResponse({ vars: ["OLD_KEY"] }),
      "DELETE /studio/projects/demo/secret/OLD_KEY": () => jsonResponse({ ok: true }),
    });
    const notify = renderPanel();
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
      "GET /studio/projects/demo/secret": () =>
        jsonResponse({ vars: ["ASSEMBLYAI_API_KEY", "OPENAI_API_KEY"] }),
    });
    renderPanel();
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
      "GET /studio/projects/demo/secret": () => jsonResponse({ vars: [] }),
      "PUT /studio/projects/demo/secret": () =>
        jsonResponse({ ok: true, keys: ["OPENAI_API_KEY"] }),
    });
    const notify = renderPanel();
    await waitFor(() => expect(callsTo(fetchMock, "/studio/projects/demo/secret")).toBe(1));
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
      "GET /studio/projects/demo/secret": () => jsonResponse({ vars: [] }),
    });
    const notify = renderPanel();
    await waitFor(() => expect(callsTo(fetchMock, "/studio/projects/demo/secret")).toBe(1));
    fireEvent.change(screen.getByPlaceholderText("OPENAI_API_KEY=..."), {
      target: { value: "ASSEMBLYAI_API_KEY=leaked" },
    });
    fireEvent.click(screen.getByText("Save secrets"));
    expect(screen.getByText(/managed for you and can't be set here/)).toBeTruthy();
    expect(callsTo(fetchMock, "/studio/projects/demo/secret")).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });

  test("Delete project asks for confirmation before firing", () => {
    stubFetch({ ...DATABASE_STATE });
    const onDeleteProject = vi.fn();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    renderPanel(vi.fn(), onDeleteProject);
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
      "GET /studio/projects/demo/secret": () => jsonResponse({ vars: [] }),
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("Delete project")).toBeTruthy();
    });
  });
});
