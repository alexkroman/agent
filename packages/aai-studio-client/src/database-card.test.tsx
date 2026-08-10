// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Settings pane's Database card: one switch for the project's `ctx.db`
// across both deployed agents. What matters here is that it reaches the
// PROJECT route (never a per-slug storage route), that it is usable before
// anything has been published, that disabling asks first because it drops
// data, and that every change is announced to the coding agent — which
// otherwise has no way to know it may build on ctx.db.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { jsonResponse, stubFetch } from "./_test-utils.ts";
import { DatabaseCard } from "./database-card.tsx";

const PATH = "/studio/projects/demo/database";

const OFF = { enabled: false, configured: true, environments: [] };

const ON = {
  enabled: true,
  configured: true,
  environments: [
    { environment: "production", slug: "demo", enabled: true },
    { environment: "preview", slug: "demo-preview", enabled: true },
  ],
};

function renderCard(onNotifyChat = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DatabaseCard bearer="sk-test" project="demo" onNotifyChat={onNotifyChat} />
    </QueryClientProvider>,
  );
  return onNotifyChat;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The switch, once the initial state read has settled — it renders its
 * "Enable database" label from the start but stays DISABLED until then, so
 * clicking on the first paint does nothing.
 */
function settledSwitch(label: string): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const button = screen.getByText(label) as HTMLButtonElement;
    if (button.disabled) throw new Error(`${label} is still loading`);
    return button;
  });
}

describe("DatabaseCard", () => {
  test("offers to enable when the project has no database", async () => {
    stubFetch({ [`GET ${PATH}`]: () => jsonResponse(OFF) });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText("Enable database")).toBeTruthy();
    });
    // No environment rows to show — nothing is provisioned.
    expect(screen.queryByText("Production")).toBeNull();
  });

  test("enabling POSTs the project route and tells the coding agent", async () => {
    const fetchMock = stubFetch({
      [`GET ${PATH}`]: () => jsonResponse(OFF),
      [`POST ${PATH}`]: () => jsonResponse(ON),
    });
    const notify = renderCard();
    fireEvent.click(await settledSwitch("Enable database"));
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    // The PROJECT route, not the platform's per-slug /:slug/storage: a project
    // is two deployed agents and the server fans the switch out.
    const posted = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit)?.method === "POST",
    );
    expect(String(posted?.[0])).toBe(PATH);
    expect(notify.mock.calls[0]?.[0]).toContain("ctx.db");
  });

  test("both environments' state is listed once enabled", async () => {
    stubFetch({ [`GET ${PATH}`]: () => jsonResponse(ON) });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText("demo-preview")).toBeTruthy();
    });
    expect(screen.getByText("Production")).toBeTruthy();
    expect(screen.getByText("Preview")).toBeTruthy();
    expect(screen.getAllByText("Ready")).toHaveLength(2);
  });

  test("an environment reports what its schema holds", async () => {
    // "Ready" answers whether the switch took effect, which is not the
    // question people have — they want to know whether anything is landing.
    stubFetch({
      [`GET ${PATH}`]: () =>
        jsonResponse({
          ...ON,
          environments: [
            {
              environment: "production",
              slug: "demo",
              enabled: true,
              usage: { tables: 2, rows: 17, bytes: 49_152 },
            },
            {
              environment: "preview",
              slug: "demo-preview",
              enabled: true,
              usage: { tables: 0, rows: 0, bytes: 0 },
            },
          ],
        }),
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText("2 tables · 17 rows · 48 KB")).toBeTruthy();
    });
    // An enabled schema with nothing in it says so, rather than "Ready".
    expect(screen.getByText("Ready · no tables yet")).toBeTruthy();
  });

  test("an unread schema stays 'Ready' rather than claiming zero rows", async () => {
    // A failed measurement and an empty database are different answers.
    stubFetch({ [`GET ${PATH}`]: () => jsonResponse(ON) });
    renderCard();
    await waitFor(() => {
      expect(screen.getAllByText("Ready")).toHaveLength(2);
    });
    expect(screen.queryByText(/0 rows/)).toBeNull();
  });

  test("the counts can be re-read without leaving the pane", async () => {
    const fetchMock = stubFetch({ [`GET ${PATH}`]: () => jsonResponse(ON) });
    renderCard();
    await waitFor(() => expect(screen.getByText("Refresh counts")).toBeTruthy());
    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByText("Refresh counts"));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });

  test("an environment the switch is waiting on says what it is waiting for", async () => {
    // Enabled before the first publish — the common case. Production has no
    // slug yet, and its database is provisioned when Publish claims one.
    stubFetch({
      [`GET ${PATH}`]: () =>
        jsonResponse({
          enabled: true,
          configured: true,
          environments: [
            { environment: "production", enabled: false },
            { environment: "preview", slug: "demo-preview", enabled: true },
          ],
        }),
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText("Publish to create it")).toBeTruthy();
    });
    expect(screen.getByText("not deployed yet")).toBeTruthy();
    // And the pane says which deploy applies the change, for both.
    expect(
      screen.getByText(/preview redeploys on its own, production when you publish/),
    ).toBeTruthy();
  });

  test("disabling asks first — it drops both schemas and their data", async () => {
    const fetchMock = stubFetch({
      [`GET ${PATH}`]: () => jsonResponse(ON),
      [`DELETE ${PATH}`]: () => jsonResponse(OFF),
    });
    const notify = renderCard();
    const button = await settledSwitch("Disable database");
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    fireEvent.click(button);
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit)?.method === "DELETE")).toBe(
      false,
    );
    expect(notify).not.toHaveBeenCalled();

    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    fireEvent.click(button);
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0]?.[0]).toContain("disabled the database");
    // The response is the new state, so the card flips without a re-read.
    await waitFor(() => expect(screen.getByText("Enable database")).toBeTruthy());
  });

  test("a server with no database configured offers no switch", async () => {
    stubFetch({
      [`GET ${PATH}`]: () => jsonResponse({ enabled: false, configured: false, environments: [] }),
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/no database configured/)).toBeTruthy();
    });
    expect(screen.queryByText("Enable database")).toBeNull();
  });

  test("a failed switch surfaces the error and posts no note", async () => {
    stubFetch({
      [`GET ${PATH}`]: () => jsonResponse(OFF),
      [`POST ${PATH}`]: () => jsonResponse({ error: "database unavailable" }, 503),
    });
    const notify = renderCard();
    fireEvent.click(await settledSwitch("Enable database"));
    await waitFor(() => {
      expect(screen.getByText("database unavailable")).toBeTruthy();
    });
    expect(notify).not.toHaveBeenCalled();
  });

  test("a partial switch shows the server's warning beside the real state", async () => {
    // One environment switched, the other didn't: the state says which, and
    // the warning says the request was not wholly satisfied.
    stubFetch({
      [`GET ${PATH}`]: () => jsonResponse(OFF),
      [`POST ${PATH}`]: () =>
        jsonResponse({
          enabled: true,
          configured: true,
          environments: [
            { environment: "production", slug: "demo", enabled: true },
            { environment: "preview", slug: "demo-preview", enabled: false },
          ],
          warning: "Could not enable the preview database",
        }),
    });
    renderCard();
    fireEvent.click(await settledSwitch("Enable database"));
    await waitFor(() => {
      expect(screen.getByText("Could not enable the preview database")).toBeTruthy();
    });
    expect(screen.getByText("Ready")).toBeTruthy();
  });
});
