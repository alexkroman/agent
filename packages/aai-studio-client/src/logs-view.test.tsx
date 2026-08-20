// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { button } from "./_test-utils.ts";
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
  // The pane's own scroll-follow reads layout, which jsdom does not compute.
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { value: 0, configurable: true });
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
