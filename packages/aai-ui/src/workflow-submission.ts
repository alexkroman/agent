// Copyright 2026 the AAI authors. MIT license.
/**
 * What a workflow SUBMISSION is, as a type: the object `useWorkflowSubmit` and
 * `useWorkflowStream` both hand back. Moved out of `use-workflow-form.ts` at
 * the source-length cap, on the seam `form-types.ts` is cut on — the two hooks
 * and the form statechart all name these, and a type living in one of them
 * would make the others import a hook to say what they return.
 */

import type { UploadProgress, WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";
import type { FormValues } from "./components/form-types.ts";
import type { WorkflowRun } from "./workflow-client.ts";
import type { SubmitInputOf } from "./workflow-def-types.ts";

/**
 * What {@link WorkflowSubmission.upload} reports while the bytes are going.
 *
 * The SDK's per-request {@link UploadProgress} plus WHICH file it describes,
 * because a form is allowed more than one and a bar over "the upload" would
 * restart at zero partway through with nothing to say why.
 *
 * @sealed
 * @public
 */
export type UploadStatus = UploadProgress & {
  /** The file being sent, by the name the picker gave it. */
  name: string;
  /** Which file of the submission this is, counting from 1. */
  index: number;
  /** How many files this submission sends in total. */
  count: number;
  /**
   * Whether the person has parked this upload.
   *
   * A paused upload is not a stopped one: the windows already stored stay stored,
   * `loaded` holds where it got to, and resuming sends what is missing rather than
   * the file. So a bar rendering this reads "Paused at 62%", never "62% and
   * frozen" — which is what a page could otherwise only guess from a number that
   * stopped moving, the same ambiguity `complete` exists to remove on the run side.
   */
  paused: boolean;
};

/**
 * The two marks a submission's wall clock is read from — press to settle,
 * across the upload, the run, and the gap between them, which no server-side
 * number can give: `output.elapsedMs` is the RUN's own clock and begins after
 * the upload. Only the browser holds both ends.
 *
 * `performance.now()` marks rather than elapsed durations, and that is the
 * load-bearing part: an elapsed number is stale the instant it is computed, so
 * a page holding one has to re-render to keep it true. A mark lets the one
 * section that prints a running clock re-render on its own interval and read
 * `performance.now() - submittedAt` at render. Monotonic, so a clock
 * correction cannot make a run look instant, or negative.
 *
 * @sealed
 * @public
 */
export type WorkflowSubmissionTiming = {
  /** When `submit()` was called on this mount, or `undefined` before the first. */
  submittedAt?: number | undefined;
  /**
   * When the submission settled — the run reached a terminal status, or the
   * submit itself failed — measured at that moment rather than at the next
   * render. `undefined` while it is in flight, and for a run this page did
   * not start (there was no press to time from).
   */
  settledAt?: number | undefined;
};

/**
 * Who can find the run again — the lifetime of the key it was recorded under.
 *
 * - `"tab"` — `useWorkflowSubmit`'s own `sessionStorage` key: a reload or a
 *   same-tab navigation finds the run; a new tab does not.
 * - `"browser"` — a `localStorage` key (`key: { storage: "local" }`, or
 *   `useRunKey({ storage: "local" })`), or a key the page supplied itself (an
 *   account's id): any tab on this browser finds it, so closing the tab loses
 *   nothing.
 * - `"none"` — nothing will find it: `recover: false`, or `useWorkflowStream`,
 *   whose run is reading the bytes THIS page is sending and is ended, not
 *   orphaned, by a reload.
 *
 * `<WorkflowPendingNote>` reads it to say the right sentence; the raw fact is
 * published so a page with its own note can too.
 *
 * @public
 */
export type WorkflowSubmissionScope = "tab" | "browser" | "none";

/**
 * What {@link useWorkflowSubmit} returns.
 *
 * @see {@link WorkflowStreamSubmission} — an ALIAS of this type, returned by
 * `useWorkflowStream`, which is a drop-in sibling. Exactly two fields MEAN
 * something different there, and both differences follow from WHEN the run is
 * created: there, `submit()` resolves when the UPLOAD finishes rather than when
 * the run is accepted, and `run` is non-`undefined` from before the bytes are
 * in, so a page can render `<WorkflowProgress>` beside the upload bar instead
 * of after it. Here the run does not exist until the last byte lands.
 *
 * @sealed
 */
export type WorkflowSubmission<R = unknown, I = unknown> = {
  /**
   * Start a run with this input. Resolves once the run EXISTS — progress
   * arrives through `run` — so a `<Form>`'s handler can await it to know the
   * submission was accepted.
   */
  submit: (input: I) => Promise<void>;
  /**
   * Start a run from a `<Form>`'s values, which are UNVALIDATED.
   *
   * The same function as {@link WorkflowSubmission.submit}, with the type the
   * form path can honestly offer. `FormValues` is `Record<string, unknown>`
   * scraped off the DOM at submit time — a `<TextField name="limit">`
   * contributes a string whatever the schema says — so the shape is not known
   * here and the SERVER is what checks it against the workflow's schema.
   *
   * Two doors rather than one loose one: `submit` takes the workflow's own
   * input type, so a hand-built object is checked at compile time and
   * `submit({ ur1: 42 })` is an error; widening it to accept `FormValues` would
   * have made every object satisfy it and given the typing back. Reaching for
   * this one is the author saying "these came from a form", which is a fact
   * about the values and not a cast.
   */
  submitForm: (values: FormValues) => Promise<void>;
  /** Clear the run and any error, putting the form back to its initial state. */
  reset: () => void;
  /**
   * End the current run's `sleep()` early — "file it now" — resolving how many
   * pending sleeps were interrupted.
   *
   * Bound to the run this submission is following, which is the point: it is
   * the only reason a page holding one of these hooks needed an `api` of its
   * own. `0` is an answer rather than a failure (the run had already moved past
   * its wait, or there is no run yet), so nothing here has to be guarded.
   */
  wake: () => Promise<number>;
  /**
   * Stop the current run, resolving whether this call is what ended it.
   *
   * `false` for a run that had already finished, and for no run at all — the
   * SDK's contract, because two tabs pressing Stop is ordinary. Distinct from
   * `reset()`, which puts the FORM back and leaves the run running.
   */
  cancel: () => Promise<boolean>;
  /** The run, once started, followed to completion. */
  run: WorkflowRun<R> | undefined;
  /**
   * True from `submit()` on this mount until `reset()` — did THIS page start
   * the run it is showing?
   *
   * A page needs it to say the right sentence and cannot derive it: a run
   * ADOPTED by the mount-time lookup after a reload looks exactly like one this
   * page started. Six templates kept a `useState(false)` next to this hook, set
   * it in their `onSubmit` and mirrored it in their `onClear` — shadow state
   * for a fact only this hook can know, since it is the thing that decides
   * between `submit()` and the recovery lookup. One of the six grew a fourth
   * branch and had to move the whole note into its own module with its own
   * spec, which is what a seam missing one layer down looks like.
   *
   * The RAW fact rather than a derived "recovered", deliberately: with `run`
   * these are three states, not two, and the third is the one a page most needs
   * to explain. `startedHere` is "you pressed the button"; `!startedHere &&
   * !run` is the mount-time lookup still going; `!startedHere && run` is a run
   * this browser started earlier, now in front of somebody who did not press
   * anything. A boolean meaning only the last of those cannot express the
   * middle one.
   *
   * @example
   * ```ts
   * declare const submission: import("@alexkroman1/aai-ui").WorkflowSubmission;
   * const note = submission.startedHere
   *   ? "You can close this tab or reload it — this page will find the run again."
   *   : submission.run === undefined
   *     ? "Looking for a run this tab started earlier…"
   *     : "Still working on the run this tab started earlier. Reloading is safe.";
   * ```
   */
  startedHere: boolean;
  /**
   * True from `submit()` until the run reaches a terminal status.
   *
   * The WORK, not the request: a run outlives its `POST`, and a submit button
   * that re-enabled on the response would invite a second submission of work
   * already in flight.
   */
  pending: boolean;
  /**
   * How far the submission's files have got, while any are still going.
   *
   * Undefined before the first byte and again from the moment the last one
   * lands, so a page can render `{upload && <UploadProgressBar upload={upload} />}`
   * and the bar exists exactly for as long as there is an upload to describe. A
   * form with no files never sets it at all.
   *
   * The wait it covers is the one `run` cannot: a run does not EXIST until its
   * input is stored, so `pending` is true and there is nothing to poll — which
   * for a 200 MB recording is minutes of a page that looks stuck.
   */
  upload: UploadStatus | undefined;
  /**
   * Park the upload where it is, stopping the bytes in flight.
   *
   * The windows already stored stay stored, so `resumeUpload()` sends what is
   * missing rather than the file — which is the difference between a pause a
   * person will actually use on a 200 MB recording and a cancel dressed up as one.
   *
   * `submit()`'s promise stays unresolved across a pause, because the submission
   * genuinely has not finished: the run does not exist until the last byte lands,
   * so resolving here would tell a `<Form>` the work was accepted when nothing has
   * been started. A no-op when there is no upload in flight.
   */
  pauseUpload: () => void;
  /** Continue a paused upload, sending only the windows the store does not have. */
  resumeUpload: () => void;
  /** The submit's own failure (a rejected input), or the watch's. */
  error: string | undefined;
  /**
   * Press-to-settle marks for the submission THIS mount made — see
   * {@link WorkflowSubmissionTiming}. Both `undefined` before the first
   * `submit()` and again after `reset()`; a run adopted by the mount-time
   * lookup has no press to time from and sets neither.
   */
  timing: WorkflowSubmissionTiming;
  /**
   * Who can find the run again after this page is gone — see
   * {@link WorkflowSubmissionScope}. Derived from the hook's options (`key`,
   * `recover`), so a page never restates it; `<WorkflowPendingNote>` reads it.
   */
  scope: WorkflowSubmissionScope;
};

/**
 * The submission `useWorkflowSubmit<D>` / `useWorkflowStream<D>` hands back for
 * the workflow def `D`, named so a component can take one as a prop.
 *
 * The hook's own return is inferred, so a page that renders everything in one
 * function never needs this. A page that splits does, and there was no way to
 * write it from the outside without three names — `WorkflowSubmission`,
 * `WorkflowOutputOf` and `SubmitInputOf` — composed by hand, which is what a
 * `ReturnType<typeof useWorkflowSubmit>` cannot say because the hook is
 * generic. `podcast-digest-workflow`'s `client.tsx` composed exactly that.
 *
 * @example
 * ```tsx no-check
 * import type { WorkflowSubmissionOf } from "@alexkroman1/aai-ui";
 * import type { dailyDigest } from "./agent.ts";
 *
 * function ScheduleControls({ submission }: { submission: WorkflowSubmissionOf<typeof dailyDigest> }) {
 *   return submission.run?.status === "completed" ? <p>{submission.run.output.posted}</p> : null;
 * }
 * ```
 *
 * @public
 */
export type WorkflowSubmissionOf<D> = WorkflowSubmission<WorkflowOutputOf<D>, SubmitInputOf<D>>;
