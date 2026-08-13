// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Settings pane's Workflows card: what durable work a project declares and
// how its recent runs are doing.
//
// What matters here is that it reads the AGENT'S own brokered API rather than a
// studio route, that it falls back to the PREVIEW agent before a first publish
// (the usual state — a project has a preview long before it has production),
// that a failure quotes the agent's own sentence (a 503 while a sandbox boots
// reads very differently from a 404 for an agent that declares none), and that
// only a LIVE run offers a Stop button.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { jsonResponse, stubFetch } from "./_test-utils.ts";
import { WorkflowsCard } from "./workflows-card.tsx";

const LIST = "/demo/workflows";
const RUNS = "/demo/workflows/runs";

function run(over: Record<string, unknown> = {}) {
  return {
    runId: "wrun_1abcdef9",
    workflow: "digest",
    createdAt: 1_700_000_000_000,
    status: "running",
    ...over,
  };
}

function renderCard(props: { deployedSlug?: string; previewSlug?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WorkflowsCard {...props} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorkflowsCard", () => {
  test("asks for a publish or an edit when the project has neither slug", () => {
    // Nothing to read from: no deployed agent and no preview.
    renderCard();
    expect(screen.getByText(/Publish this project/)).toBeTruthy();
  });

  test("reads the agent's own brokered API, workflow by workflow", async () => {
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () =>
        jsonResponse({ workflows: [{ name: "digest", description: "Nightly" }] }),
      [`GET ${RUNS}`]: () => jsonResponse({ runs: [run()] }),
    });
    renderCard({ deployedSlug: "demo" });

    await waitFor(() => expect(screen.getByText("digest")).toBeTruthy());
    expect(screen.getByText("Nightly")).toBeTruthy();
    // The runs read carries no `key`: a console has no correlation key to ask
    // about, and most runs carry none at all.
    const runsUrl = new URL(String(fetchMock.mock.calls[1]?.[0]), "http://studio.test");
    expect(runsUrl.searchParams.get("workflow")).toBe("digest");
    expect(runsUrl.searchParams.get("key")).toBeNull();
    expect(runsUrl.searchParams.get("limit")).toBe("5");
  });

  test("falls back to the PREVIEW agent, and says which one it is showing", async () => {
    stubFetch({
      "GET /demo-preview/workflows": () => jsonResponse({ workflows: [] }),
    });
    renderCard({ previewSlug: "demo-preview" });
    await waitFor(() => expect(screen.getByText(/declares no workflows/)).toBeTruthy());
    expect(screen.getByText(/preview/).textContent).toContain("preview");
  });

  test("prefers the published slug when both exist", async () => {
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse({ workflows: [] }),
    });
    renderCard({ deployedSlug: "demo", previewSlug: "demo-preview" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/demo/workflows");
  });

  test("quotes the agent's own error sentence", async () => {
    // That text is the difference between "still booting" and "declares none".
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse({ error: "agent unavailable, retry shortly" }, 503),
    });
    renderCard({ deployedSlug: "demo" });
    const line = await waitFor(() => screen.getByText(/agent unavailable, retry shortly/));
    // UNWRAPPED, which a substring match alone does not prove: the card used to
    // render the raw body (`503: {"error":"agent unavailable, retry shortly"}`),
    // which CONTAINS that sentence — so this test passed over the bug it exists
    // to catch until `responseErrorMessage` replaced the hand-written reader.
    expect(line.textContent).not.toContain('{"error"');
    expect(line.textContent).toContain("Could not read the workflows: agent unavailable");
  });

  test("shows a failed run's MESSAGE, not just its status", async () => {
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse({ workflows: [{ name: "digest" }] }),
      [`GET ${RUNS}`]: () =>
        jsonResponse({ runs: [run({ status: "failed", error: "topic not found" })] }),
    });
    renderCard({ deployedSlug: "demo" });
    await waitFor(() => expect(screen.getByText("topic not found")).toBeTruthy());
    expect(screen.getByText("failed")).toBeTruthy();
  });

  test("offers Stop for a live run and nothing for a terminal one", async () => {
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse({ workflows: [{ name: "digest" }] }),
      [`GET ${RUNS}`]: () =>
        jsonResponse({
          runs: [run(), run({ runId: "wrun_2", status: "completed" })],
        }),
    });
    renderCard({ deployedSlug: "demo" });
    await waitFor(() => expect(screen.getByText("completed")).toBeTruthy());
    expect(screen.getAllByRole("button", { name: /^Stop run/ })).toHaveLength(1);
  });

  test("Stop sends a DELETE and re-reads rather than patching the row", async () => {
    // The run's new state is the agent's to report, and a cancel races whatever
    // the run was doing.
    let cancelled = false;
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse({ workflows: [{ name: "digest" }] }),
      [`GET ${RUNS}`]: () =>
        jsonResponse({ runs: [run({ status: cancelled ? "cancelled" : "running" })] }),
      [`DELETE ${RUNS}/wrun_1abcdef9`]: () => {
        cancelled = true;
        return jsonResponse({ runId: "wrun_1abcdef9", cancelled: true });
      },
    });
    renderCard({ deployedSlug: "demo" });

    const stop = await waitFor(() => screen.getByRole("button", { name: /^Stop run/ }));
    fireEvent.click(stop);

    await waitFor(() => expect(screen.getByText("cancelled")).toBeTruthy());
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(true);
  });

  test("a failed Stop is reported without losing the list", async () => {
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse({ workflows: [{ name: "digest" }] }),
      [`GET ${RUNS}`]: () => jsonResponse({ runs: [run()] }),
      [`DELETE ${RUNS}/wrun_1abcdef9`]: () => jsonResponse({ error: "gone" }, 503),
    });
    renderCard({ deployedSlug: "demo" });
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: /^Stop run/ })));
    await waitFor(() => expect(screen.getByText(/Could not stop the run/)).toBeTruthy());
    expect(screen.getByText("digest")).toBeTruthy();
  });

  test("refresh re-reads, since the numbers are as old as the last fetch", async () => {
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse({ workflows: [] }),
    });
    renderCard({ deployedSlug: "demo" });
    await waitFor(() => expect(screen.getByText("Refresh runs")).toBeTruthy());
    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByText("Refresh runs"));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });
});
