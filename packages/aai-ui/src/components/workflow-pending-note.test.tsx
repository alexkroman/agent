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

  test("says something different in each of its situations", () => {
    const notes = [
      ...[PRESSED, LOOKING, FOUND].map((submission) => noteOf({ submission })),
      noteOf({ submission: { ...PRESSED, scope: "none" } }),
      noteOf({
        submission: {
          ...PRESSED,
          upload: {
            name: "a",
            index: 1,
            count: 1,
            loaded: 1,
            total: 2,
            fraction: 0.5,
            paused: true,
          },
        },
      }),
    ];
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

  test("reads the submission's own scope, and the prop overrides it", () => {
    expect(noteOf({ submission: { ...PRESSED, scope: "browser" } })).toMatch(/close this tab/i);
    expect(noteOf({ submission: { ...PRESSED, scope: "browser" }, scope: "tab" })).toMatch(
      /reloading is safe/i,
    );
  });

  test("a run nothing will find again says to keep the tab open, whoever started it", () => {
    // `useWorkflowStream`'s run reads the recording as this page sends it, so a
    // reload does not orphan it, it ENDS it — "you can close this tab" would be
    // wrong in exactly that mode.
    for (const submission of [PRESSED, LOOKING, FOUND]) {
      const note = noteOf({ submission: { ...submission, scope: "none" }, subject: "transcript" });
      expect(note).toMatch(/keep this tab open/i);
      expect(note).toContain("the transcript");
    }
  });

  test("a PAUSED upload gets its own line, and it differs by whether a run exists yet", () => {
    const paused = {
      name: "a.wav",
      index: 1,
      count: 1,
      loaded: 10,
      total: 100,
      fraction: 0.1,
      paused: true,
    } as const;
    const safe = noteOf({ submission: { ...PRESSED, upload: paused } });
    expect(safe).toMatch(/upload paused/i);
    expect(safe).toMatch(/nothing has started yet/i);
    const risky = noteOf({ submission: { ...PRESSED, upload: paused, scope: "none" } });
    expect(risky).toMatch(/upload paused/i);
    expect(risky).toMatch(/already started/i);
    // An upload in flight but NOT paused says the ordinary thing.
    expect(noteOf({ submission: { ...PRESSED, upload: { ...paused, paused: false } } })).toMatch(
      /reloading is safe/i,
    );
  });

  test("renders the sentence muted, and className is added rather than replacing that", () => {
    const plain = render(<WorkflowPendingNote submission={FOUND} />).container.firstElementChild;
    expect(plain).toHaveClass("text-sm opacity-70", { exact: true });
    const extra = render(<WorkflowPendingNote submission={PRESSED} className="mt-2" />).container
      .firstElementChild;
    expect(extra).toHaveClass("text-sm opacity-70 mt-2", { exact: true });
  });
});
