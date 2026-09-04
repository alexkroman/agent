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

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushEffects } from "../_react-test-utils.ts";
import { DEFAULT_PROGRESS_POLL_MS } from "../use-workflow-progress.ts";
import { WorkflowProgress } from "./workflow-progress.tsx";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // `useFakeTimers` is outside `restoreMocks`, and only one spec below installs
  // them — so this is the file-level undo the root guide asks for rather than a
  // `finally` inside that test body.
  vi.useRealTimers();
});

/**
 * The frames the progress route emits, as one SSE payload.
 *
 * `Uint8Array<ArrayBuffer>` rather than the default `ArrayBufferLike`: only the
 * former is a `BodyInit`, and a shared-buffer view cannot be a response body.
 */
function frames(lines: readonly string[]): Uint8Array<ArrayBuffer> {
  const body = lines.map((line) => `event: chunk\ndata: ${JSON.stringify(line)}\n\n`).join("");
  return new TextEncoder().encode(
    `${body}event: done\ndata: {"runId":"wrun_1","complete":true}\n\n`,
  );
}

/** The `event: chunk` / `event: done` framing the progress route emits. */
function sse(lines: readonly string[]): Response {
  return new Response(frames(lines), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * The same response, plus a promise that settles once the hook has READ it.
 *
 * The component returns `placeholder ?? null` both before the first read
 * resolves and after a read that produced nothing, so a "renders nothing" spec
 * that asserts straight after `render` is asserting the PRE-FETCH frame — it
 * passes with the rendering rules deleted, and it passed here. Awaiting
 * `consumed` is what moves the assertion onto the settled frame. `waitFor` on
 * the fetch having been CALLED is not enough: that resolves inside the effect,
 * before the body is consumed.
 */
function trackedSse(lines: readonly string[]): { response: Response; consumed: Promise<void> } {
  const { promise, resolve } = Promise.withResolvers<void>();
  const payload = frames(lines);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(payload);
      controller.close();
      resolve();
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    consumed: promise,
  };
}

describe("WorkflowProgress", () => {
  test("renders the run's lines as one block of text", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(sse(["Reading…", "Filing."])));
    const { container } = render(<WorkflowProgress runId="wrun_1" />);

    await waitFor(() => expect(container.querySelector("pre")).not.toBeNull());
    expect(container.querySelector("pre")?.textContent).toBe("Reading…\nFiling.");
  });

  test("renders nothing once a read has come back with nothing", async () => {
    const { response, consumed } = trackedSse([]);
    fetchMock.mockImplementation(() => Promise.resolve(response));
    const { container } = render(<WorkflowProgress runId="wrun_1" />);

    // The settled frame, not the pre-fetch one — see `trackedSse`.
    await consumed;
    await flushEffects();
    expect(container.innerHTML).toBe("");
  });

  test("renders nothing at all without a run id, so a page may pass its state through", () => {
    const { container } = render(<WorkflowProgress />);
    expect(container.innerHTML).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("renders nothing when the agent serves no progress route, and stops reading", async () => {
    // A deploy that predates progress streams: 404, which is what `supported`
    // exists to tell apart from "has written nothing yet".
    //
    // An empty DOM alone cannot make that distinction — a 404 leaves `progress`
    // empty too, so the component renders `placeholder ?? null` either way, and
    // the old `waitFor(fetch called)` gate settled inside the effect before the
    // response was even looked at. What DOES discriminate is that a 404 is a
    // stable answer: `supported` latches and the reader stops. Treat it as a
    // transport blip (`partial`) instead and this re-opens once per interval.
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => Promise.resolve(new Response("", { status: 404 })));
    const { container } = render(<WorkflowProgress runId="wrun_1" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_POLL_MS * 3);
    });
    expect(container.innerHTML).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a placeholder stands in once a read has come back with nothing", async () => {
    const { response, consumed } = trackedSse([]);
    fetchMock.mockImplementation(() => Promise.resolve(response));
    render(<WorkflowProgress runId="wrun_1" placeholder={<p>Starting…</p>} />);

    await consumed;
    await flushEffects();
    expect(screen.getByText("Starting…")).not.toBeNull();
  });

  test("className REPLACES the default, so a custom chrome is not fighting it", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(sse(["Reading…"])));
    const { container } = render(<WorkflowProgress runId="wrun_1" className="font-mono" />);

    await waitFor(() => expect(container.querySelector("pre")).not.toBeNull());
    expect(container.querySelector("pre")?.className).toBe("font-mono");
  });
  test("`lines` shows only the newest N, which is what the two raw pages hand-rolled", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(sse(["Fetching…", "Reading…", "Summarising…"])),
    );
    const { container } = render(<WorkflowProgress runId="wrun_1" lines={1} />);

    await waitFor(() => expect(container.querySelector("pre")).not.toBeNull());
    expect(container.querySelector("pre")?.textContent).toBe("Summarising…");
  });

  test("`lines` larger than the log shows the whole log rather than padding it", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(sse(["Reading…", "Filing."])));
    const { container } = render(<WorkflowProgress runId="wrun_1" lines={10} />);

    await waitFor(() => expect(container.querySelector("pre")).not.toBeNull());
    expect(container.querySelector("pre")?.textContent).toBe("Reading…\nFiling.");
  });

  test("`lines={0}` renders the placeholder, not the whole log", async () => {
    // The reading that keeps a COMPUTED window of zero from silently inverting
    // into "everything".
    fetchMock.mockImplementation(() => Promise.resolve(sse(["Reading…"])));
    render(<WorkflowProgress runId="wrun_1" lines={0} placeholder={<p>Starting…</p>} />);

    await waitFor(() => expect(screen.getByText("Starting…")).not.toBeNull());
  });

  test("`lines` still respects `supported` — an older agent stays blank, not windowed", async () => {
    // The whole reason this is a prop: both hand-rolled versions carried a
    // six-line comment about exactly this, and a third copy would eventually
    // drop it.
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => Promise.resolve(new Response("", { status: 404 })));
    const { container } = render(<WorkflowProgress runId="wrun_1" lines={1} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_POLL_MS * 3);
    });
    expect(container.innerHTML).toBe("");
  });
});
