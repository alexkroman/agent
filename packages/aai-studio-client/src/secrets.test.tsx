// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Secrets panel: its own UI (not part of Publish), talking to the
// platform's own /:slug/secret routes. Unpublished projects get the
// "publish first" gate, and every successful change posts a note into the
// chat so the coding agent knows which keys exist — values never included.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { jsonResponse, stubFetch } from "./_test-utils.ts";
import { SecretsPanel } from "./secrets.tsx";

function renderPanel(slug: string | undefined, onNotifyChat = vi.fn(), onDeleteProject = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SecretsPanel
        apiKey="sk-test"
        project="demo"
        slug={slug}
        onNotifyChat={onNotifyChat}
        onClose={() => undefined}
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

  test("saving multiple secrets pluralizes the chat note", async () => {
    stubFetch({
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
    const fetchMock = stubFetch({ "GET /demo/secret": () => jsonResponse({ vars: [] }) });
    const notify = renderPanel("demo");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByText("Save secrets"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  test("a failed listing surfaces the server's error message", async () => {
    stubFetch({
      "GET /demo/secret": () => jsonResponse({ error: "unauthorized" }, 401),
    });
    renderPanel("demo");
    await waitFor(() => {
      expect(screen.getByText("unauthorized")).toBeTruthy();
    });
  });

  test("a failed save surfaces its error and posts no note", async () => {
    stubFetch({
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

  test("Delete project asks for confirmation before firing", () => {
    stubFetch({});
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
    stubFetch({ "GET /demo/secret": () => jsonResponse({ vars: [] }) });
    renderPanel("demo");
    await waitFor(() => {
      expect(screen.getByText("Delete project")).toBeTruthy();
    });
  });
});
