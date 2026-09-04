// Copyright 2026 the AAI authors. MIT license.
/**
 * The hook a FORM needs, as against the one a status view does.
 *
 * `useWorkflowRun` (`workflow-client.ts`) watches a run you already have.
 * This is what comes before it: `useWorkflowSubmit` starts a run and hands the
 * id straight to `useWorkflowRun`. Its sibling `useWorkflows` — the listing
 * `<WorkflowFields>` renders a form from — is `use-workflows.ts`.
 *
 * ## `useWorkflowSubmit` — a form's two halves in one hook
 *
 * A page that submits a workflow always needs the same four pieces of state:
 * the run id, whether a submit is in flight, whether the RUN is still going, and
 * whichever of the two failed. `link-digest` writes them out by hand, which is
 * the right shape for a template teaching the primitives and the wrong shape to
 * write a third time — and it is easy to get subtly wrong: dropping the previous
 * run id before the new `POST` returns is what stops a finished result sitting
 * under a form that is already submitting again.
 *
 * So this is `api.start` plus {@link useWorkflowRun}, with the state between
 * them. It adds no transport of its own and holds no run state of its own; the
 * watching (stream first, poll as its fallback, terminal stops) is entirely
 * `useWorkflowRun`'s, and `run` here IS its run.
 *
 * ## Why it starts ASYNCHRONOUSLY even though a synchronous call exists
 *
 * `api.startAndWait` would collapse this to one request, and it is the wrong
 * default for a page: it holds a socket open for up to a minute, answers nothing
 * until it settles, and a page has `useWorkflowRun` — which survives a reload,
 * shows progress, and costs one stream. The synchronous call is for callers with
 * nowhere to put a watch (a script, a cron, a form POST from a server). Pass
 * `wait` here when the page really does want one request, and the run is
 * followed from the same id either way.
 */

import { errorMessage } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type {
  AnyWorkflowDef,
  UploadParallel,
  UploadProgress,
  WorkflowOutputOf,
} from "@alexkroman1/aai/workflow-api";
import { useCallback, useRef, useState } from "react";
import { useRecoveredRun } from "./_recover-run.ts";
import { useRunControls } from "./_run-controls.ts";
import { createUploadSession, type UploadSession, uploadFiles } from "./_upload-files.ts";
import { useUploadPause } from "./_upload-pause.ts";
import { useWorkflowApiRef } from "./_workflow-api-ref.ts";
import type { FormValues } from "./components/form-types.ts";
import { useDefaultRunKey } from "./use-run-key.ts";
import { useWorkflowRun } from "./use-workflow-run.ts";
import type { WorkflowApi, WorkflowRun } from "./workflow-client.ts";
import type { SubmitInputOf } from "./workflow-def-types.ts";

/**
 * What {@link WorkflowSubmission.upload} reports while the bytes are going.
 *
 * The SDK's per-request {@link UploadProgress} plus WHICH file it describes,
 * because a form is allowed more than one and a bar over "the upload" would
 * restart at zero partway through with nothing to say why.
 *
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
 * What {@link useWorkflowSubmit} returns.
 *
 * @see {@link WorkflowStreamSubmission} — an ALIAS of this type, returned by
 * `useWorkflowStream`, which is a drop-in sibling. Exactly two fields MEAN
 * something different there, and both differences follow from WHEN the run is
 * created: there, `submit()` resolves when the UPLOAD finishes rather than when
 * the run is accepted, and `run` is non-`undefined` from before the bytes are
 * in, so a page can render `<WorkflowProgress>` beside the upload bar instead
 * of after it. Here the run does not exist until the last byte lands.
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
};

/** Options for {@link useWorkflowSubmit}. */
export type UseWorkflowSubmitOptions = {
  /** The client to start runs with. Defaults to one for the page's own agent. */
  api?: WorkflowApi;
  /**
   * Correlation key recorded with the run, for finding it again without the id.
   *
   * **Defaulted**, to an opaque per-page key in `sessionStorage` that the next
   * load produces again — `useRunKey()`'s, minted by the hook. Pass one to
   * scope runs to something the page knows better: an ACCOUNT's own id, which
   * is what makes a run follow the person to a new device, or
   * `useRunKey({ storage: "local" })` for a run that outlives the tab by
   * design. The key is a lookup CAPABILITY (there is no per-user filtering
   * behind `find`), it must fit the route's 256-character bound, and anything
   * derived from a person's own input both collides and carries what they
   * typed — `use-run-key.ts` argues every alternative.
   */
  key?: string;
  /**
   * On mount, adopt the newest run this `key` already has.
   *
   * **This is what makes a reload survivable, and it is ON.** The run id is
   * this hook's own state, so a refresh loses it while the run carries on — and
   * a page that cannot name a run cannot show it, cancel it or wake it. The
   * hook asks `find(workflow, key)` once as it mounts and follows whatever
   * comes back, so the answer, the progress and the controls are all there
   * again.
   *
   * It used to be opt-in, on the argument that a `key` alone means only "record
   * this with the run" — true of `ctx.workflows.start({ key })`, where there is
   * no page to put a run back on, and not of a form: six of six page templates
   * passed `useRunKey()` and `recover: true` together, which is a default in
   * the wrong place. `false` is the opt-out, and what it buys is a form that
   * always opens empty — no lookup on mount, and a live run reachable only by
   * an id the page has already lost.
   */
  recover?: boolean;
  /**
   * Hold the `POST` open until the run settles, up to this many ms — the
   * synchronous mode. Omitted (the default) returns as soon as the run exists.
   */
  wait?: number;
  /** How often the fallback poll re-reads a live run. */
  intervalMs?: number;
  /**
   * Send each chosen file as concurrent parts instead of in one request.
   *
   * **On by default.** `false` opts out, `{ partBytes, concurrency }` tunes it.
   * This is the wait a form with a recording in it actually spends: the run does
   * not exist until its input is stored, so until the last byte lands there is no
   * run to watch and nothing for `<WorkflowProgress>` to say. Splitting the file
   * across connections is what makes that stretch shorter, and it degrades to the
   * single request wherever it would not help — a small file, an older agent — so
   * the default costs nothing where it would not have paid. See
   * `UploadOptions.parallel`.
   */
  parallel?: UploadParallel;
};

/**
 * Start a workflow from a form, and follow the run it creates.
 *
 * @typeParam D - The workflow DEFINITION, which types both halves of the
 *   submission: `submit(input)` takes what the workflow's schema parses to, and
 *   `run.status === "completed"` narrows to a typed `run.output`.
 *
 *   It used to be the OUTPUT type alone, and the asymmetry was the bug: a page
 *   already wrote `WorkflowOutputOf<typeof digest>` to get the output, while
 *   `submit` took `unknown`, so `submit({ ur1: 42 })` compiled and arrived as a
 *   400 in the browser. Naming the def instead types the input from the same
 *   declaration — and `import type` is ERASED, so it costs the bundle nothing.
 *   Passing an output type where a def belongs is now a compile error rather
 *   than a silent loss of typing, which is the point.
 *
 * @example
 * ```tsx no-check
 * import { Form, SubmitButton, TextField, useWorkflowSubmit } from "@alexkroman1/aai-ui";
 * import type { digest } from "./agent.ts";
 *
 * function DigestForm() {
 *   const { submit, run, pending, error } = useWorkflowSubmit<typeof digest>("digest");
 *   return (
 *     <Form onSubmit={(values) => submit(values)} error={error}>
 *       <TextField name="url" label="Link" type="url" required />
 *       <SubmitButton pending={pending}>Digest</SubmitButton>
 *       {run?.status === "completed" && <p>{run.output.title}</p>}
 *     </Form>
 *   );
 * }
 * ```
 *
 * @public
 */
export function useWorkflowSubmit<D extends AnyWorkflowDef>(
  workflow: string,
  opts: UseWorkflowSubmitOptions = {},
): WorkflowSubmission<WorkflowOutputOf<D>, SubmitInputOf<D>> {
  const { api, recover = true, wait, intervalMs, parallel } = opts;
  // The key the runs are recorded under: the caller's, or the per-page one this
  // hook mints and stores for itself. Minted even when `recover` is off, so
  // opting out of the LOOKUP still leaves the run findable — by the next load
  // that turns recovery back on, and by anything else holding the key.
  const key = useDefaultRunKey(opts.key);
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | undefined>(undefined);
  const [upload, setUpload] = useState<UploadStatus | undefined>(undefined);
  // The live submission's uploads, so `pauseUpload` reaches the gate the walk is
  // waiting on. A ref rather than state: nothing renders from it, and a re-render
  // per pause would be a re-render that changes nothing on the page.
  const session = useRef<UploadSession | undefined>(undefined);

  // The caller's client through a ref — see `_workflow-api-ref.ts`.
  const getClient = useWorkflowApiRef(api);

  const tracked = useWorkflowRun<WorkflowOutputOf<D>>(runId, omitUndefined({ api, intervalMs }));
  const { wake, cancel } = useRunControls(runId, getClient);

  // The other half of "a run outlives the page": `key` records the handle, this
  // reads it back. See `_recover-run.ts` for why it happens once per mount and
  // why the answer can never displace a run the person has already started.
  const recovering = useRecoveredRun({
    workflow,
    key,
    enabled: recover,
    getClient,
    onFound: (found) => {
      setRunId((current) => current ?? found);
    },
    onError: setStartError,
  });

  const submit = useCallback(
    async (input: unknown) => {
      const client = getClient();
      setStarting(true);
      setStartError(undefined);
      // Dropped BEFORE the request, not after it returns: the previous run's
      // result must not sit under a form that is already submitting again.
      setRunId(undefined);
      // A submission that is starting takes the pause controls from whatever was
      // there before, so a stale gate cannot park the new one.
      session.current?.gate.cancel();
      const current = createUploadSession(workflow);
      session.current = current;
      try {
        const options = omitUndefined({ key });
        // Files first: a run input carries an upload ID, never bytes, and this
        // is the one place that knows both the chosen file and the client that
        // can store it. A form using `<FileField upload>` (which is what
        // `<WorkflowFields>` renders for a declared upload property) therefore
        // needs no upload code of its own.
        const started = await uploadFiles(client, input, setUpload, parallel, current);
        // Both paths end in a run id — the difference is only whether the agent
        // held the request open — so the watch below is identical either way.
        setRunId(
          wait === undefined
            ? await client.start(workflow, started, options)
            : (await client.startAndWait(workflow, started, { ...options, wait })).runId,
        );
      } catch (err: unknown) {
        // An abandoned upload is not a failure to report: `reset()` and the next
        // `submit()` both cancel, and both are the person's own doing.
        if (!current.gate.cancelled) setStartError(errorMessage(err));
      } finally {
        // A SUPERSEDED submission owns none of this state any more. Its walk
        // unwinds after the next one has already set `starting`, so clearing here
        // unconditionally would report the live submission as finished and drop the
        // bar it is drawing.
        if (session.current === current) {
          session.current = undefined;
          setStarting(false);
          // Dropped whichever way it went. From here the wait belongs to the RUN,
          // which `run` and `pending` describe, and a bar left at 100% under a
          // running workflow reads as the thing that is taking the time.
          setUpload(undefined);
        }
      }
    },
    [workflow, key, wait, parallel, getClient],
  );

  const reset = useCallback(() => {
    // Abandoned rather than left running: a form put back to its initial state has
    // no bar to draw and no submission to finish, so bytes still going would be
    // bytes nobody is waiting for.
    session.current?.gate.cancel();
    session.current = undefined;
    setRunId(undefined);
    setStartError(undefined);
    setUpload(undefined);
  }, []);

  // The gate stops the bytes; the hook is what makes the page say so — see
  // `_upload-pause.ts`, shared with `useWorkflowStream` so the two cannot
  // disagree about what a paused bar reads.
  const { pauseUpload, resumeUpload } = useUploadPause(
    useCallback(() => session.current?.gate, []),
    setUpload,
  );

  return {
    submit,
    submitForm: submit,
    reset,
    wake,
    cancel,
    pauseUpload,
    resumeUpload,
    run: tracked.run,
    // `tracked.polling` rather than a second derivation from the snapshot, and
    // that is the whole of it: `useWorkflowRun` gives up on an id the agent
    // keeps reporting as unknown (`MAX_MISSING_READS`), which leaves `run`
    // undefined — so `!isTerminal(tracked.run)` reads as "still waiting" and
    // pinned the submit button disabled and reading "Working…" for the life of
    // the page, with the correct error shown directly above it. That stop is
    // exactly what `polling` exists to report, per its own doc: it cannot be
    // derived from the snapshot. `starting` still covers the gap between the
    // POST returning and the first read landing, which is otherwise a frame
    // with no run and no spinner. `recovering` is the same gap on a RELOAD,
    // where there is no submit to have set `starting`: a form that offered
    // Submit while a live run was arriving would invite a second one.
    pending: recovering || starting || tracked.polling,
    upload,
    error: startError ?? tracked.error,
  };
}
