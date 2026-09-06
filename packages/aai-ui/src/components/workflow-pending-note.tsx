// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";
import type { WorkflowRun } from "../workflow-client.ts";

/**
 * Props for {@link WorkflowPendingNote}.
 *
 * @public
 */
export type WorkflowPendingNoteProps = {
  /**
   * The submission the page is rendering — `useWorkflowSubmit`'s or
   * `useWorkflowStream`'s result, or any object carrying these three fields.
   * Nothing renders while `pending` is false.
   */
  submission: {
    readonly pending: boolean;
    readonly startedHere: boolean;
    readonly run: WorkflowRun | undefined;
  };
  /**
   * What the run produces, as the noun the sentences name: `"draft"`,
   * `"summary"`, `"transcript"`. Default `"run"`.
   */
  subject?: string | undefined;
  /**
   * Where the key that finds the run again lives. `"tab"` (the default) is
   * `useWorkflowSubmit`'s own `sessionStorage` key; `"browser"` is a page that
   * passed `useRunKey({ storage: "local" })`, whose runs any tab on this browser
   * can find — so the sentence says "this browser" and stops promising that
   * closing the tab loses anything.
   */
  scope?: "tab" | "browser" | undefined;
  /**
   * ADDED to the note's own `text-sm opacity-70` rather than replacing it.
   * There is no `tailwind-merge` in this package, so a class that CONFLICTS with
   * a base one is not reliably the winner.
   */
  className?: string | undefined;
};

/**
 * The one sentence a page says while a run is in flight — three situations,
 * one line each — as a muted line under the form, and nothing otherwise.
 *
 * Six template pages had each written the function under this, byte-identical
 * in control flow and different only in the noun, under a doc arguing the same
 * two things. Both survive here, once:
 *
 * - **The reload case gets its own words.** `!startedHere && run` is a run in
 *   front of somebody who did not press anything — a reload, or another tab on
 *   the same key — and they are owed an explanation for work appearing, plus
 *   the line that stops them starting it again. The sentence a page reaches for
 *   instead ("you can close this tab") was true about the RUN and false about
 *   the page for as long as a reload could not find its run.
 * - **The lookup is a state, not an absence.** `!startedHere && !run` is the
 *   stretch on a reload where the key is being resolved and an empty form would
 *   read as "nothing is happening". It is the same length as the request.
 *
 * The render site had drifted too — three pages muted the line and two did not
 * — so the typography is the component's, in the same `text-sm opacity-70`
 * every other muted line on these pages uses.
 *
 * `startedHere`, `run` and `pending` are what {@link WorkflowSubmission}
 * reports, which is why the prop is the submission itself rather than three
 * booleans a page would re-derive. A page with a FOURTH situation — a run that a
 * reload does not recover but ENDS, as `transcription-workflow`'s streaming
 * flow has — writes its own sentence, and that template is the one doing so.
 *
 * @example
 * ```tsx
 * import { useWorkflowSubmit, WorkflowPendingNote } from "@alexkroman1/aai-ui";
 *
 * function App() {
 *   const submission = useWorkflowSubmit("redline");
 *   return <WorkflowPendingNote submission={submission} subject="draft" />;
 * }
 * ```
 *
 * @param props - See {@link WorkflowPendingNoteProps}.
 *
 * @public
 */
export function WorkflowPendingNote({
  submission,
  subject = "run",
  scope = "tab",
  className,
}: WorkflowPendingNoteProps): ReactNode {
  if (!submission.pending) return null;
  return (
    <p className={clsx("text-sm opacity-70", className)}>
      {pendingNote(submission, subject, scope)}
    </p>
  );
}

/** The sentence itself, over the three states the doc above names. */
function pendingNote(
  submission: WorkflowPendingNoteProps["submission"],
  subject: string,
  scope: "tab" | "browser",
): string {
  const here = scope === "browser" ? "this browser" : "this tab";
  if (submission.startedHere) {
    return scope === "browser"
      ? `You can close this tab — this browser will find the ${subject} again.`
      : `Reloading is safe — this page will find the ${subject} again.`;
  }
  if (submission.run === undefined) return `Looking for the ${subject} ${here} started earlier…`;
  return `Still working on the ${subject} ${here} started earlier — no need to start it again.`;
}
