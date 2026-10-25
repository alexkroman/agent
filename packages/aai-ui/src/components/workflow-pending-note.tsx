// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";
import type { WorkflowRun } from "../workflow-client.ts";
import type { UploadStatus, WorkflowSubmissionScope } from "../workflow-submission.ts";

/**
 * Props for {@link WorkflowPendingNote}.
 *
 * @input
 * @public
 */
export type WorkflowPendingNoteProps = {
  /**
   * The submission the page is rendering — `useWorkflowSubmit`'s or
   * `useWorkflowStream`'s result, or any object carrying the three required
   * fields. Nothing renders while `pending` is false. `scope` and `upload`,
   * when present, choose two more sentences — see below.
   */
  submission: {
    readonly pending: boolean;
    readonly startedHere: boolean;
    readonly run: WorkflowRun | undefined;
    /** Who finds the run again — `WorkflowSubmission.scope`; the `scope` prop overrides it. */
    readonly scope?: WorkflowSubmissionScope | undefined;
    /** The bytes in flight — `WorkflowSubmission.upload`; a PAUSED one gets its own line. */
    readonly upload?: UploadStatus | undefined;
  };
  /**
   * What the run produces, as the noun the sentences name: `"draft"`,
   * `"summary"`, `"transcript"`. Default `"run"`.
   */
  subject?: string | undefined;
  /**
   * Where the key that finds the run again lives, overriding what the
   * submission reports. `"tab"` is `useWorkflowSubmit`'s own `sessionStorage`
   * key; `"browser"` is a page that passed `useRunKey({ storage: "local" })`,
   * whose runs any tab on this browser can find — so the sentence says "this
   * browser" and stops promising that closing the tab loses anything;
   * `"none"` is a run nothing will find again (`recover: false`,
   * `useWorkflowStream`), which the sentence has to say instead. Default: the
   * submission's own `scope`, else `"tab"`.
   */
  scope?: WorkflowSubmissionScope | undefined;
  /**
   * ADDED to the note's own `text-sm opacity-70` rather than replacing it.
   * There is no `tailwind-merge` in this package, so a class that CONFLICTS with
   * a base one is not reliably the winner.
   */
  className?: string | undefined;
};

/**
 * The one sentence a page says while a run is in flight — five situations,
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
 * booleans a page would re-derive. The two situations past those three read
 * two more of its fields, and used to be the one page that wrote its own note:
 *
 * - **A run nothing will find again** (`scope: "none"` — `useWorkflowStream`,
 *   whose run reads the recording as this page sends it and gives up on one
 *   that stops arriving, or `recover: false`): "keep this tab open", because
 *   a reload does not orphan that run, it ENDS it. A page telling a reader they
 *   can close the tab would be wrong in exactly that mode.
 * - **A PAUSED upload** is that same fact arriving through a button, which is
 *   why it is tested first and why its two sentences differ: with no run yet
 *   a pause costs nothing, and in the streaming mode the run is already
 *   watching an upload it will give up on.
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
  scope,
  className,
}: WorkflowPendingNoteProps): ReactNode {
  if (!submission.pending) return null;
  return (
    <p className={clsx("text-sm opacity-70", className)}>
      {pendingNote(submission, subject, scope ?? submission.scope ?? "tab")}
    </p>
  );
}

/** The sentence itself, over the five states the doc above names. */
function pendingNote(
  submission: WorkflowPendingNoteProps["submission"],
  subject: string,
  scope: WorkflowSubmissionScope,
): string {
  const recoverable = scope !== "none";
  if (submission.upload?.paused === true) {
    return recoverable
      ? "Upload paused — nothing has started yet, so resume whenever you are ready."
      : `Upload paused — resume within a few minutes: the ${subject} has already started and gives up on a file that stops arriving.`;
  }
  if (!recoverable) {
    return `Keep this tab open — the ${subject} is being made from what this page sends, so a reload ends it.`;
  }
  const here = scope === "browser" ? "this browser" : "this tab";
  if (submission.startedHere) {
    return scope === "browser"
      ? `You can close this tab — this browser will find the ${subject} again.`
      : `Reloading is safe — this page will find the ${subject} again.`;
  }
  if (submission.run === undefined) return `Looking for the ${subject} ${here} started earlier…`;
  return `Still working on the ${subject} ${here} started earlier — no need to start it again.`;
}
