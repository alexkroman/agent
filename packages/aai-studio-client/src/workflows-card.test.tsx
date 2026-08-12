// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Settings pane's "Workflows" card: what durable work this project declares
// and how its recent runs are doing.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WorkflowsCard } from "./workflows-card.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Props = Parameters<typeof WorkflowsCard>[0];

/** Answer the two GETs the card makes, by URL. */
function stubApi(routes: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    const match = Object.keys(routes).find((pattern) => url.includes(pattern));
    if (match === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(routes[match]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderCard(props: Props): ReturnType<typeof render> {
  vi.stubGlobal("location", { origin: "https://build.test" });
  // `retry: false` so a failing case asserts the failure rather than the backoff.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkflowsCard {...props} />
    </QueryClientProvider>,
  );
}

describe("WorkflowsCard", () => {
  test("asks for a build when the project has no slug at all", () => {
    const fetchMock = stubApi({});
    renderCard({});
    expect(screen.getByText(/Publish this project, or make an edit/)).toBeTruthy();
    // And reads nothing: brokering a slug that does not exist cannot answer, and
    // this card's read is what boots a sandbox.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("reads the agent's own workflow API, keyed to the published slug", async () => {
    const fetchMock = stubApi({
      "/demo-x7k2mq/workflows/runs": { runs: [] },
      "/demo-x7k2mq/workflows": { workflows: [{ name: "transcribe" }] },
    });
    renderCard({ deployedSlug: "demo-x7k2mq", previewSlug: "demo-preview" });

    await waitFor(() => expect(screen.getByText("transcribe")).toBeTruthy());
    // The published slug wins over the preview, as on the API card beside it.
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toBe("https://build.test/demo-x7k2mq/workflows");
    expect(urls.some((url) => url.includes("demo-preview"))).toBe(false);
  });

  test("lists runs WITHOUT a correlation key", async () => {
    const fetchMock = stubApi({
      "/workflows/runs": { runs: [] },
      "/workflows": { workflows: [{ name: "transcribe" }] },
    });
    renderCard({ deployedSlug: "demo" });

    await waitFor(() => expect(screen.getByText("No runs yet.")).toBeTruthy());
    const runsUrl = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((u) => u.includes("/runs?"));
    // The keyless read is the whole reason `recent` exists: a console has no key
    // to ask about, and a static page's runs carry none — filtering by one would
    // show an empty list for every workflow app in the product.
    expect(runsUrl).toContain("workflow=transcribe");
    expect(runsUrl).not.toContain("key=");
  });

  test("renders a run's status, step count and failure message", async () => {
    stubApi({
      "/workflows/runs": {
        runs: [
          {
            runId: "0123456789abcdef",
            workflow: "transcribe",
            status: "failed",
            stepsCompleted: 3,
            error: "sync transcribe failed: 429",
          },
        ],
      },
      "/workflows": { workflows: [{ name: "transcribe", description: "Transcribe a recording" }] },
    });
    renderCard({ deployedSlug: "demo" });

    await waitFor(() => expect(screen.getByText("failed")).toBeTruthy());
    expect(screen.getByText("01234567")).toBeTruthy();
    expect(screen.getByText("3 steps")).toBeTruthy();
    expect(screen.getByText("Transcribe a recording")).toBeTruthy();
    // The message, not just the status: "failed" alone sends someone to the logs
    // for something already in hand.
    expect(screen.getByText("sync transcribe failed: 429")).toBeTruthy();
  });

  test("translates a sleeping run into a wait, not an epoch", async () => {
    stubApi({
      "/workflows/runs": {
        runs: [
          {
            runId: "abcdef0123",
            workflow: "after_action",
            status: "sleeping",
            stepsCompleted: 1,
            wakeAt: Date.now() + 45_000,
          },
        ],
      },
      "/workflows": { workflows: [{ name: "after_action" }] },
    });
    renderCard({ deployedSlug: "demo" });

    // `sleeping` is the state that makes these runs durable rather than slow — the
    // run holds no container — and a bare status beside a `wakeAt` epoch reads as
    // a stuck job.
    await waitFor(() => expect(screen.getByText(/sleeping, resumes in 4[45]s/)).toBeTruthy());
  });

  test("stops a live run, and retries a terminal one", async () => {
    // Before this the card was read-only, so a failed run was a dead end. A
    // retried run keeps its journal, so it resumes from its last completed step.
    const fetchMock = stubApi({
      "/workflows/runs": {
        runs: [
          { runId: "live-1", workflow: "w", status: "running", stepsCompleted: 1 },
          { runId: "dead-1", workflow: "w", status: "failed", stepsCompleted: 2, error: "boom" },
        ],
      },
      "/workflows": { workflows: [{ name: "w" }] },
    });
    renderCard({ deployedSlug: "demo" });
    await waitFor(() => expect(screen.getByLabelText("Stop run live-1")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Stop run live-1"));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            String(call[0]).endsWith("/runs/live-1") &&
            (call[1] as RequestInit | undefined)?.method === "DELETE",
        ),
      ).toBe(true),
    );

    fireEvent.click(screen.getByLabelText("Retry run dead-1"));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            String(call[0]).endsWith("/runs/dead-1/retry") &&
            (call[1] as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true),
    );
  });

  test("offers neither action on a completed run", async () => {
    // A finished run has nothing to stop and nothing to redo — offering Retry
    // would invite re-running work that already succeeded.
    stubApi({
      "/workflows/runs": {
        runs: [{ runId: "done-1", workflow: "w", status: "completed", stepsCompleted: 3 }],
      },
      "/workflows": { workflows: [{ name: "w" }] },
    });
    renderCard({ deployedSlug: "demo" });

    await waitFor(() => expect(screen.getByText("completed")).toBeTruthy());
    expect(screen.queryByLabelText("Stop run done-1")).toBeNull();
    expect(screen.queryByLabelText("Retry run done-1")).toBeNull();
  });

  test("offers Retry on a cancelled run", async () => {
    stubApi({
      "/workflows/runs": {
        runs: [{ runId: "stopped-1", workflow: "w", status: "cancelled", stepsCompleted: 1 }],
      },
      "/workflows": { workflows: [{ name: "w" }] },
    });
    renderCard({ deployedSlug: "demo" });

    await waitFor(() => expect(screen.getByLabelText("Retry run stopped-1")).toBeTruthy());
  });

  test("says an agent declaring no workflows is fine", async () => {
    stubApi({ "/workflows": { workflows: [] } });
    renderCard({ deployedSlug: "demo" });

    await waitFor(() => expect(screen.getByText(/declares no workflows/)).toBeTruthy());
  });

  test("labels a preview read, and quotes the agent's own failure", async () => {
    // A 404 here is the ordinary case for an agent with no workflow API at all,
    // and a 503 is a sandbox still booting — the text is what separates them, so
    // it is quoted rather than replaced with a house sentence.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response("agent unavailable, retry shortly", { status: 503 })),
      ),
    );
    renderCard({ previewSlug: "demo-preview" });

    await waitFor(() =>
      expect(screen.getByText(/503: agent unavailable, retry shortly/)).toBeTruthy(),
    );
    expect(screen.getByText(/its own journal, separate from production/)).toBeTruthy();
  });
});
