// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * The panel's own decisions: the status line and its overrides, the Clear
 * button's presence, the completed slot's discrimination and typing, the live
 * slot's lifetime, and the order the pieces come in. `WorkflowProgress` and
 * `WorkflowRunError` keep their own specs; this asserts they are COMPOSED, the
 * way `console-shell.test.tsx` asserts its banner.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { WorkflowApi, WorkflowRun } from "../workflow-client.ts";
import { WORKFLOW_STATUS_LABELS } from "../workflow-status-labels.ts";
import { WorkflowRunPanel } from "./workflow-run-panel.tsx";

type Output = { draft: string; words: number };

const BASE = { runId: "run_1", workflow: "redline", createdAt: 0 } as const;
const RUNNING: WorkflowRun<Output> = { ...BASE, status: "running" };
const DONE: WorkflowRun<Output> = {
  ...BASE,
  status: "completed",
  output: { draft: "The piece.", words: 2 },
};
const FAILED: WorkflowRun<Output> = { ...BASE, status: "failed", error: "critic refused" };

/**
 * A client whose progress read answers the given lines and then reports the
 * stream complete — enough for `<WorkflowProgress>` to render, so the
 * composition is observable rather than assumed. The framing is the progress
 * route's own (`event: chunk` / `event: done`), as `workflow-progress.test.tsx`
 * spells it.
 */
function apiWithProgress(
  lines: readonly string[],
): WorkflowApi & { streamOutput: ReturnType<typeof vi.fn> } {
  const body = lines.map((line) => `event: chunk\ndata: ${JSON.stringify(line)}\n\n`).join("");
  const frames = new TextEncoder().encode(
    `${body}event: done\ndata: {"runId":"run_1","complete":true}\n\n`,
  );
  const streamOutput = vi.fn(
    async () =>
      new Response(frames, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  );
  return { streamOutput } as unknown as WorkflowApi & { streamOutput: typeof streamOutput };
}

describe("WorkflowRunPanel", () => {
  test("heads the panel with the SDK's status line by default", () => {
    render(<WorkflowRunPanel run={RUNNING} />);
    expect(screen.getByRole("heading").textContent).toBe(WORKFLOW_STATUS_LABELS.running);
  });

  test("a partial `statusLabels` replaces the named lines and keeps the rest", () => {
    render(<WorkflowRunPanel run={RUNNING} statusLabels={{ running: "Writing…" }} />);
    expect(screen.getByRole("heading").textContent).toBe("Writing…");
    render(<WorkflowRunPanel run={DONE} statusLabels={{ running: "Writing…" }} />);
    expect(screen.getAllByRole("heading")[1]?.textContent).toBe(WORKFLOW_STATUS_LABELS.completed);
  });

  test("renders a Clear button only when given `onClear`, and it calls it", () => {
    const { container } = render(<WorkflowRunPanel run={RUNNING} />);
    expect(container.querySelector("button")).toBeNull();

    const onClear = vi.fn();
    render(<WorkflowRunPanel run={RUNNING} onClear={onClear} />);
    fireEvent.click(screen.getByText("Clear"));
    expect(onClear).toHaveBeenCalledOnce();
  });

  test("renders the completed body from a function of the TYPED output, only once completed", () => {
    const body = vi.fn((output: Output) => <article data-testid="body">{output.draft}</article>);
    render(<WorkflowRunPanel run={RUNNING}>{body}</WorkflowRunPanel>);
    expect(body).not.toHaveBeenCalled();
    expect(screen.queryByTestId("body")).toBeNull();

    render(<WorkflowRunPanel run={DONE}>{body}</WorkflowRunPanel>);
    expect(body).toHaveBeenCalledWith(DONE.output);
    expect(screen.getByTestId("body").textContent).toBe("The piece.");
  });

  test("a plain node as children is rendered as it is, and also only once completed", () => {
    render(
      <WorkflowRunPanel run={RUNNING}>
        <p data-testid="node">done</p>
      </WorkflowRunPanel>,
    );
    expect(screen.queryByTestId("node")).toBeNull();
    render(
      <WorkflowRunPanel run={DONE}>
        <p data-testid="node">done</p>
      </WorkflowRunPanel>,
    );
    expect(screen.getByTestId("node")).toBeDefined();
  });

  test("the `live` slot shows while the run is not terminal and goes away when it is", () => {
    const live = <p data-testid="live">so far…</p>;
    render(<WorkflowRunPanel run={RUNNING} live={live} />);
    expect(screen.getByTestId("live")).toBeDefined();
    for (const run of [DONE, FAILED, { ...BASE, status: "cancelled" as const }]) {
      const { container } = render(<WorkflowRunPanel run={run} live={live} />);
      expect(container.querySelector("[data-testid='live']")).toBeNull();
    }
  });

  test("composes the announced error for a failed run, and no error otherwise", () => {
    render(<WorkflowRunPanel run={FAILED} />);
    expect(screen.getByRole("alert").textContent).toBe("That run failed: critic refused");
    const { container } = render(<WorkflowRunPanel run={DONE} />);
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  test("composes the run's narration through the api it is given", async () => {
    const api = apiWithProgress(["Drafting…", "Grading…"]);
    render(<WorkflowRunPanel run={DONE} api={api} />);
    const log = await screen.findByRole("log");
    expect(log.textContent).toBe("Drafting…\nGrading…");
    expect(api.streamOutput).toHaveBeenCalled();
  });

  test("orders header, narration, completed body, then error", async () => {
    const api = apiWithProgress(["Drafting…"]);
    render(
      <WorkflowRunPanel run={{ ...DONE }} api={api}>
        {(output) => <article data-testid="body">{output.draft}</article>}
      </WorkflowRunPanel>,
    );
    const heading = screen.getByRole("heading");
    const log = await screen.findByRole("log");
    const body = screen.getByTestId("body");
    expect(heading.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(log.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("className is appended to the section's own classes", () => {
    const { container } = render(<WorkflowRunPanel run={RUNNING} className="gap-3" />);
    const section = container.firstElementChild as HTMLElement;
    expect(section.tagName).toBe("SECTION");
    expect(section.className).toContain("rounded-md border p-5");
    expect(section.className).toContain("gap-3");
  });
});
