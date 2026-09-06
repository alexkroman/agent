// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { WorkflowRun } from "../workflow-client.ts";
import { WorkflowPendingNote, type WorkflowPendingNoteProps } from "./workflow-pending-note.tsx";

const RUNNING: WorkflowRun = {
  runId: "run_1",
  workflow: "digest",
  createdAt: 0,
  status: "running",
};

/** The three situations a pending run can be in, as the hook reports them. */
const PRESSED = { pending: true, startedHere: true, run: undefined };
const LOOKING = { pending: true, startedHere: false, run: undefined };
const FOUND = { pending: true, startedHere: false, run: RUNNING };

function noteOf(props: WorkflowPendingNoteProps): string {
  const { container } = render(<WorkflowPendingNote {...props} />);
  return container.textContent ?? "";
}

describe("WorkflowPendingNote", () => {
  test("renders nothing while nothing is pending", () => {
    const { container } = render(
      <WorkflowPendingNote submission={{ pending: false, startedHere: false, run: undefined }} />,
    );
    expect(container.innerHTML).toBe("");
  });

  test("promises the reload back to whoever pressed the button", () => {
    expect(noteOf({ submission: PRESSED })).toMatch(/reloading is safe/i);
  });

  test("says it is LOOKING while the lookup is still out", () => {
    // The stretch on a reload where an empty form would read as "nothing is
    // happening" — the same length as the request.
    expect(noteOf({ submission: LOOKING })).toMatch(/looking for/i);
  });

  test("explains a run the reader did not start, and says not to start it again", () => {
    const note = noteOf({ submission: FOUND });
    expect(note).toMatch(/earlier/i);
    expect(note).toMatch(/no need to start it again/i);
  });

  test("names the subject the page gave it, in every branch", () => {
    for (const submission of [PRESSED, LOOKING, FOUND]) {
      expect(noteOf({ submission, subject: "draft" })).toContain("the draft");
    }
  });

  test("says something different in each of its three situations", () => {
    const notes = [PRESSED, LOOKING, FOUND].map((submission) => noteOf({ submission }));
    // A branch that duplicates its neighbour's sentence is a branch nobody can
    // see, and the three are the whole of what a page says about the wait.
    expect(new Set(notes).size).toBe(notes.length);
  });

  test("a browser-scoped key stops talking about the tab", () => {
    // `useRunKey({ storage: "local" })` means any tab on this browser finds the
    // run, so "this tab started" would be wrong and "close this tab" is safe.
    expect(noteOf({ submission: PRESSED, scope: "browser" })).toMatch(/close this tab/i);
    const found = noteOf({ submission: FOUND, scope: "browser" });
    expect(found).toContain("this browser");
    expect(found).not.toContain("this tab");
  });

  test("renders the sentence muted, and className is added rather than replacing that", () => {
    const plain = render(<WorkflowPendingNote submission={FOUND} />).container.firstElementChild;
    expect(plain?.className).toBe("text-sm opacity-70");
    const extra = render(<WorkflowPendingNote submission={PRESSED} className="mt-2" />).container
      .firstElementChild;
    expect(extra?.className).toBe("text-sm opacity-70 mt-2");
  });
});
