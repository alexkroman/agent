// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * Specs for `<WorkflowProgress>`.
 *
 * Driven through a stubbed `fetch` and the component's own default client, for
 * the same reason `use-workflow-progress.test.ts` is: it is the path a page
 * that passes no `api` takes, and it needs no cast. What is asserted here is the
 * three rendering rules the component exists to hold, not the streaming — that
 * is the hook's spec next door.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { WorkflowProgress } from "./workflow-progress.tsx";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

/** The `event: chunk` / `event: done` framing the progress route emits. */
function sse(lines: readonly string[]): Response {
  const body = lines.map((line) => `event: chunk\ndata: ${JSON.stringify(line)}\n\n`).join("");
  return new Response(
    new TextEncoder().encode(`${body}event: done\ndata: {"runId":"wrun_1","complete":true}\n\n`),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("WorkflowProgress", () => {
  test("renders the run's lines as one block of text", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(sse(["Reading…", "Filing."])));
    const { container } = render(<WorkflowProgress runId="wrun_1" />);

    await waitFor(() => expect(container.querySelector("pre")).not.toBeNull());
    expect(container.querySelector("pre")?.textContent).toBe("Reading…\nFiling.");
  });

  test("renders nothing before the run has said anything", () => {
    fetchMock.mockImplementation(() => Promise.resolve(sse([])));
    const { container } = render(<WorkflowProgress runId="wrun_1" />);
    expect(container.innerHTML).toBe("");
  });

  test("renders nothing at all without a run id, so a page may pass its state through", () => {
    const { container } = render(<WorkflowProgress />);
    expect(container.innerHTML).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("renders nothing when the agent serves no progress route", async () => {
    // A deploy that predates progress streams: 404, which is what `supported`
    // exists to tell apart from "has written nothing yet".
    fetchMock.mockImplementation(() => Promise.resolve(new Response("", { status: 404 })));
    const { container } = render(<WorkflowProgress runId="wrun_1" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  test("a placeholder stands in while there is nothing to show", () => {
    fetchMock.mockImplementation(() => Promise.resolve(sse([])));
    render(<WorkflowProgress runId="wrun_1" placeholder={<p>Starting…</p>} />);
    expect(screen.getByText("Starting…")).not.toBeNull();
  });

  test("className REPLACES the default, so a custom chrome is not fighting it", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(sse(["Reading…"])));
    const { container } = render(<WorkflowProgress runId="wrun_1" className="font-mono" />);

    await waitFor(() => expect(container.querySelector("pre")).not.toBeNull());
    expect(container.querySelector("pre")?.className).toBe("font-mono");
  });
});
