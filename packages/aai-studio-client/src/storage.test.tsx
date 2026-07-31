// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Storage toggle: state comes from GET, enabling POSTs, disabling is
// destructive (drops the app's database) so it must go through an explicit
// confirmation, and a 409 renders the "publish first" gate rather than an
// error.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DISABLE_STORAGE_WARNING, StorageControl } from "./storage.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Route fetch by "METHOD /path" — each call gets a fresh Response. */
function stubFetch(routes: Record<string, () => Response>) {
  const fetchMock = vi
    .fn()
    .mockImplementation((input: RequestInfo | URL, init?: RequestInit | undefined) => {
      const path = new URL(String(input), "http://studio.test").pathname;
      const route = `${init?.method ?? "GET"} ${path}`;
      const make = routes[route];
      if (!make) throw new Error(`Unexpected fetch: ${route}`);
      return Promise.resolve(make());
    });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function calls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((c) => {
    const [url, init] = c as [string, RequestInit | undefined];
    return `${init?.method ?? "GET"} ${new URL(String(url), "http://studio.test").pathname}`;
  });
}

function renderControl() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StorageControl apiKey="sk-test" project="demo" />
    </QueryClientProvider>,
  );
}

const GET = "GET /studio/projects/demo/storage";
const POST = "POST /studio/projects/demo/storage";
const DELETE = "DELETE /studio/projects/demo/storage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("StorageControl", () => {
  test("renders the enabled state from GET", async () => {
    stubFetch({ [GET]: () => jsonResponse({ enabled: true }) });
    renderControl();
    await waitFor(() => expect(screen.getByText("Enabled")).toBeDefined());
    expect(screen.getByRole("button", { name: "Disable storage…" })).toBeDefined();
  });

  test("renders the disabled state from GET", async () => {
    stubFetch({ [GET]: () => jsonResponse({ enabled: false }) });
    renderControl();
    await waitFor(() => expect(screen.getByText("Disabled")).toBeDefined());
    expect(screen.getByRole("button", { name: "Enable storage" })).toBeDefined();
  });

  test("enabling calls POST and refetches the state", async () => {
    let enabled = false;
    const fetchMock = stubFetch({
      [GET]: () => jsonResponse({ enabled }),
      [POST]: () => {
        enabled = true;
        return jsonResponse({ ok: true, enabled: true });
      },
    });
    renderControl();
    // The button exists (disabled) while the GET is in flight — wait for the
    // loaded state before clicking.
    await waitFor(() => expect(screen.getByText("Disabled")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Enable storage" }));
    await waitFor(() => expect(screen.getByText("Enabled")).toBeDefined());
    expect(calls(fetchMock)).toEqual([GET, POST, GET]);
  });

  test("disabling asks for confirmation and does nothing when declined", async () => {
    const fetchMock = stubFetch({ [GET]: () => jsonResponse({ enabled: true }) });
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmMock);
    renderControl();
    const button = await screen.findByRole("button", { name: "Disable storage…" });
    fireEvent.click(button);
    expect(confirmMock).toHaveBeenCalledWith(DISABLE_STORAGE_WARNING);
    // Declined — no DELETE, state unchanged.
    expect(calls(fetchMock)).toEqual([GET]);
    expect(screen.getByText("Enabled")).toBeDefined();
  });

  test("a confirmed disable calls DELETE and refetches", async () => {
    let enabled = true;
    const fetchMock = stubFetch({
      [GET]: () => jsonResponse({ enabled }),
      [DELETE]: () => {
        enabled = false;
        return jsonResponse({ ok: true, enabled: false });
      },
    });
    vi.stubGlobal("confirm", () => true);
    renderControl();
    const button = await screen.findByRole("button", { name: "Disable storage…" });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText("Disabled")).toBeDefined());
    expect(calls(fetchMock)).toEqual([GET, DELETE, GET]);
  });

  test("a 409 renders the publish-first hint with the toggle disabled", async () => {
    stubFetch({ [GET]: () => jsonResponse({ error: "not published" }, 409) });
    renderControl();
    await waitFor(() =>
      expect(screen.getByText("Publish the project first to enable storage.")).toBeDefined(),
    );
    const button = screen.getByRole("button", { name: "Enable storage" });
    expect(button.hasAttribute("disabled")).toBe(true);
    // The gate is a state, not a failure — no error text.
    expect(screen.queryByText(/not published/)).toBeNull();
  });

  test("a failed GET surfaces its error instead of a silent blank", async () => {
    stubFetch({ [GET]: () => jsonResponse({ error: "storage exploded" }, 500) });
    renderControl();
    await waitFor(() => expect(screen.getByText("storage exploded")).toBeDefined());
    expect(screen.getByText("Unavailable")).toBeDefined();
  });

  test("a failed enable shows the error and re-syncs with the server", async () => {
    const fetchMock = stubFetch({
      [GET]: () => jsonResponse({ enabled: false }),
      [POST]: () => jsonResponse({ error: "provisioning failed" }, 500),
    });
    renderControl();
    await waitFor(() => expect(screen.getByText("Disabled")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Enable storage" }));
    await waitFor(() => expect(screen.getByText("provisioning failed")).toBeDefined());
    // onSettled refetches even on failure.
    expect(calls(fetchMock)).toEqual([GET, POST, GET]);
    expect(screen.getByText("Disabled")).toBeDefined();
  });
});
