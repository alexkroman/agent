// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { button, installResizeObserver } from "./_test-utils.ts";
import type { AgentLogsPage } from "./api-types.ts";
import { LogsView } from "./logs-view.tsx";

/** One page, with the fields a caller does not care about filled in. */
function page(over: Partial<AgentLogsPage> = {}): AgentLogsPage {
  return { lines: [], cursor: -1, dropped: 0, running: true, ...over };
}

function line(seq: number, text: string, stream: "stdout" | "stderr" = "stdout") {
  return { seq, at: 1_700_000_000_000 + seq, stream, text };
}

/** Serve a queue of pages; the last one repeats once the queue drains. */
function serve(pages: AgentLogsPage[]): { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    calls.push(String(input));
    const body = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
  return { calls };
}

beforeEach(() => {
  // jsdom has no ResizeObserver, and `<AutoScroll>` — which owns this pane's
  // follow-the-bottom behaviour — constructs one on mount.
  installResizeObserver();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LogsView", () => {
  test("tails the preview agent by default and renders its lines", async () => {
    const { calls } = serve([page({ lines: [line(0, "hello from a tool")], cursor: 0 })]);

    render(<LogsView bearer="k" previewSlug="proj-preview" deployedSlug="proj" />);

    expect(await screen.findByText("hello from a tool")).toBeTruthy();
    expect(calls[0]).toContain("/proj-preview/logs?after=-1");
  });

  test("passes the page's cursor back on the next poll", async () => {
    const { calls } = serve([
      page({ lines: [line(0, "first")], cursor: 0 }),
      page({ lines: [line(1, "second")], cursor: 1 }),
    ]);

    render(<LogsView bearer="k" previewSlug="p" deployedSlug={undefined} />);

    await screen.findByText("second");
    expect(calls[1]).toContain("after=0");
  });

  test("reports a gap rather than silently skipping it", async () => {
    serve([page({ lines: [line(9, "after the gap")], cursor: 9, dropped: 4 })]);

    render(<LogsView bearer="k" previewSlug="p" deployedSlug={undefined} />);

    expect(await screen.findByText(/4 earlier lines dropped/)).toBeTruthy();
  });

  test("an agent that is up but quiet reads differently from one that is not running", async () => {
    serve([page({ running: true })]);
    const up = render(<LogsView bearer="k" previewSlug="p" deployedSlug={undefined} />);
    expect(await screen.findByText("No output yet")).toBeTruthy();
    up.unmount();

    vi.restoreAllMocks();
    serve([page({ running: false })]);
    render(<LogsView bearer="k" previewSlug="p" deployedSlug={undefined} />);
    expect(await screen.findByText("Nothing running")).toBeTruthy();
  });

  test("a project with no preview says so instead of polling", async () => {
    const { calls } = serve([page()]);

    render(<LogsView bearer="k" previewSlug={undefined} deployedSlug="proj" />);

    expect(await screen.findByText("No preview yet")).toBeTruthy();
    expect(calls).toEqual([]);
  });

  test("switching to production tails the other slug from the start", async () => {
    const { calls } = serve([page({ lines: [line(0, "preview line")], cursor: 0 })]);
    render(<LogsView bearer="k" previewSlug="proj-preview" deployedSlug="proj" />);
    await screen.findByText("preview line");

    button(/Production/).click();

    await waitFor(() => {
      expect(calls.some((url) => url.includes("/proj/logs?after=-1"))).toBe(true);
    });
  });

  test("the switch is disabled for an environment with no agent", () => {
    serve([page()]);
    render(<LogsView bearer="k" previewSlug="p" deployedSlug={undefined} />);

    expect(button(/Production/).disabled).toBe(true);
    expect(button(/Preview/).disabled).toBe(false);
  });

  test("a failed poll shows the reason and keeps polling", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      calls.push(String(input));
      return calls.length === 1
        ? Promise.reject(new Error("network down"))
        : Promise.resolve(
            new Response(JSON.stringify(page({ lines: [line(0, "recovered")], cursor: 0 })), {
              status: 200,
            }),
          );
    });

    render(<LogsView bearer="k" previewSlug="p" deployedSlug={undefined} />);

    expect(await screen.findByText(/network down/)).toBeTruthy();
    expect(await screen.findByText("recovered")).toBeTruthy();
  });

  test("stderr is distinguishable from stdout", async () => {
    serve([page({ lines: [line(0, "boom", "stderr")], cursor: 0 })]);

    render(<LogsView bearer="k" previewSlug="p" deployedSlug={undefined} />);

    const el = await screen.findByText("boom");
    expect(el.className).toContain("text-err");
  });

  test("says out loud that the log is not durable", async () => {
    serve([page()]);
    render(<LogsView bearer="k" previewSlug="p" deployedSlug={undefined} />);

    expect(await screen.findByText(/goes when the sandbox does/)).toBeTruthy();
  });
});

describe("following the bottom", () => {
  /*
   * This is WIRING, and deliberately not the behaviour.
   *
   * Following the bottom belongs to `aai-ui`'s `<AutoScroll>` now — the same
   * component the chat transcript mounts — and the library under it is driven
   * by a ResizeObserver over real boxes. jsdom computes no layout and its
   * ResizeObserver here is a stub, so nothing this suite can do makes content
   * grow in a way the library can see; an assertion about `scrollTop` would
   * pass or fail on the stub rather than on the pane.
   *
   * The two behavioural tests that stood here were only writable because the
   * hand-rolled version read three numbers (`scrollHeight`, `clientHeight`,
   * `scrollTop`) that a test could define by hand. They pinned an
   * implementation this pane no longer owns. What is still this pane's claim,
   * and still regresses silently, is that the lines are mounted INSIDE that
   * scroller at all — dropping back to a plain `<div className="overflow-auto">`
   * renders identically and follows nothing.
   */
  test("mounts the tail inside a stick-to-bottom scroller", async () => {
    serve([page({ lines: [line(0, "first")], cursor: 0 })]);
    render(<LogsView bearer="k" previewSlug="p" deployedSlug={undefined} />);

    // `AutoScroll`'s inner scroller is styled inline by the library and carries
    // only the class it is passed, so those styles are the handle — and asking from the
    // LINE outwards is the assertion that matters: a scroller mounted somewhere
    // the lines are not would follow an empty box.
    const written = await screen.findByText("first");
    const scroller = written.closest<HTMLElement>("[style*='scrollbar-gutter']");
    expect(scroller, "the log line is not inside a stick-to-bottom scroller").not.toBeNull();
    expect(scroller?.style.height).toBe("100%");
  });
});

test("one dropped line is not reported as lines", async () => {
  serve([page({ lines: [line(3, "after")], cursor: 3, dropped: 1 })]);

  render(<LogsView bearer="k" previewSlug="p" deployedSlug={undefined} />);

  expect(await screen.findByText(/1 earlier line dropped/)).toBeTruthy();
});

test("a production agent that goes away mid-view says it is not published", async () => {
  serve([page({ lines: [line(0, "prod line")], cursor: 0 })]);
  const view = render(<LogsView bearer="k" previewSlug="p" deployedSlug="proj" />);
  await screen.findByText("prod line");
  button(/Production/).click();
  await screen.findByText("prod line");

  view.rerender(<LogsView bearer="k" previewSlug="p" deployedSlug={undefined} />);

  expect(screen.getByText("Not published yet")).toBeTruthy();
});

describe("a poll that lands after the pane closes", () => {
  test("does not render what came back", async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(promise);
    const view = render(<LogsView bearer="k" previewSlug="p" deployedSlug={undefined} />);
    view.unmount();

    resolve(new Response(JSON.stringify(page({ lines: [line(0, "late")] })), { status: 200 }));
    await promise;

    expect(screen.queryByText("late")).toBeNull();
  });

  test("does not report its failure either", async () => {
    const { promise, reject } = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(promise);
    const view = render(<LogsView bearer="k" previewSlug="p" deployedSlug={undefined} />);
    view.unmount();

    reject(new Error("network down"));
    // The pane's own catch is what this asserts about; the rejection is
    // settled here only so the assertion runs after it.
    await promise.catch(() => undefined);

    expect(screen.queryByText(/network down/)).toBeNull();
  });
});
