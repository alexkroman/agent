// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Secrets panel: its own UI (not part of Publish), talking to the
// platform's own /:slug/secret routes. Unpublished projects get the
// "publish first" gate, and every successful change posts a note into the
// chat so the coding agent knows which keys exist — values never included.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SecretsPanel } from "./secrets.tsx";

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

function renderPanel(slug: string | undefined, onNotifyChat = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SecretsPanel
        apiKey="sk-test"
        slug={slug}
        onNotifyChat={onNotifyChat}
        onClose={() => undefined}
      />
    </QueryClientProvider>,
  );
  return onNotifyChat;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SecretsPanel", () => {
  test("unpublished projects get the publish-first gate, no requests", () => {
    const fetchMock = stubFetch({});
    renderPanel(undefined);
    expect(screen.getByText(/Publish the project first/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("lists the deployed agent's secret names", async () => {
    stubFetch({ "GET /demo/secret": () => jsonResponse({ vars: ["OPENAI_API_KEY"] }) });
    renderPanel("demo");
    await waitFor(() => {
      expect(screen.getByText("OPENAI_API_KEY")).toBeTruthy();
    });
  });

  test("saving secrets PUTs them and posts a chat note without the values", async () => {
    stubFetch({
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

  test("deleting a secret posts a chat note", async () => {
    stubFetch({
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
});
