// Copyright 2026 the AAI authors. MIT license.
/**
 * The two hooks a FORM needs, as against the one a status view does.
 *
 * `useWorkflowRun` (`workflow-client.ts`) watches a run you already have.
 * These two are what comes before it: `useWorkflows` reads the declared
 * workflows so `<WorkflowFields>` can render a form from a schema, and
 * `useWorkflowSubmit` starts a run and hands the id straight to
 * `useWorkflowRun`.
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

import { errorMessage, type WorkflowSummary } from "@alexkroman1/aai";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import type { UploadParallel, UploadProgress } from "@alexkroman1/aai/workflow-api";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createUploadGate,
  randomUploadId,
  sendThroughGate,
  type UploadGate,
} from "./_upload-session.ts";
import { useWorkflowApiRef } from "./_workflow-api-ref.ts";
import { filesOf } from "./_workflow-files.ts";
import { useWorkflowRun } from "./use-workflow-run.ts";
import type { WorkflowApi, WorkflowRun } from "./workflow-client.ts";

/** Options for {@link useWorkflows}. */
export type UseWorkflowsOptions = {
  /** The client to read the listing with. Defaults to one for the page's own agent. */
  api?: WorkflowApi;
  /**
   * Skip the lookup entirely, reporting an empty listing that is not loading.
   *
   * For a caller that may or may not need the listing and cannot decide with a
   * conditional hook — `<WorkflowFields>` handed a summary rather than a name is
   * the one in this package. It reports `loading: false`, because a skipped
   * lookup is finished rather than pending.
   */
  skip?: boolean;
};

/** What {@link useWorkflows} reports. */
export type UseWorkflowsResult = {
  /** The agent's declared workflows, each with the JSON Schema of its input. */
  workflows: WorkflowSummary[];
  /** True until the listing lands, so a form can hold its fields back. */
  loading: boolean;
  /** The lookup's failure. Set alongside an EMPTY list, which is why it exists. */
  error: string | undefined;
};

/**
 * Read the agent's declared workflows.
 *
 * What `<WorkflowFields>` renders a form FROM: each summary carries the JSON
 * Schema of that workflow's input, converted server-side precisely so a browser
 * can read it.
 *
 * The failure is reported rather than swallowed, because the alternative is an
 * empty list — which renders as a form with no fields and reads as "this agent
 * declares no workflows" about an agent that was merely unreachable.
 *
 * @public
 */
export function useWorkflows(opts: UseWorkflowsOptions = {}): UseWorkflowsResult {
  const { api, skip = false } = opts;
  const [state, setState] = useState<UseWorkflowsResult>({
    workflows: [],
    // A skipped lookup is not a pending one: `loading: true` forever would hold
    // back a form that is waiting on it.
    loading: !skip,
    error: undefined,
  });

  // The client through a ref — see `_workflow-api-ref.ts`.
  const getClient = useWorkflowApiRef(api);

  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    getClient()
      .list()
      .then((workflows) => {
        if (!cancelled) setState({ workflows, loading: false, error: undefined });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          workflows: [],
          loading: false,
          error: errorMessage(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [skip, getClient]);

  return state;
}

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
 * What one submission's uploads know about themselves, across pauses.
 *
 * Held by the hook rather than by the walk below, because the walk RE-RUNS: a
 * pause unwinds nothing, so resuming re-enters `uploadFiles` with the same input
 * and the same session, and every file whose bytes are already in is skipped by
 * `stored` rather than sent again.
 *
 * Which is also why the ids live here. A resumable upload is one whose id
 * outlives the attempt that began it — that is the whole mechanism — so an id
 * minted per attempt would make each round a fresh upload of the whole file.
 */
type UploadSession = {
  /** The id each file is being stored under, minted once. */
  ids: Map<File, string>;
  /** Files whose every byte has landed, by the id they landed under. */
  stored: Map<File, string>;
  /** Files that have had an attempt, so the next one must claim the id as its own. */
  tried: Set<File>;
  /** The person's pause. */
  gate: UploadGate;
};

/** A fresh session for one submission. */
function createUploadSession(): UploadSession {
  return { ids: new Map(), stored: new Map(), tried: new Set(), gate: createUploadGate() };
}

/**
 * Replace every `File` in a submitted form with the id of a stored upload,
 * reporting how far each one has got.
 *
 * Sequential rather than `Promise.all`: these are large bodies, and a form with
 * two 200 MB recordings should send them one after another rather than compete
 * for the same connection. That is also what makes a single bar honest — one
 * file is in flight at a time, and `index`/`count` say which.
 *
 * Anything that is not a `File` (or an array of them) passes through untouched,
 * so this is invisible to every form that has none — including one whose values
 * are not an object at all, which `submit` accepts.
 *
 * ## `uploadStream`, not `upload`, and the id is the reason
 *
 * The difference between the two calls is only who mints the id — and that is
 * exactly what decides whether an interrupted upload can be picked up again. An
 * `upload` mints its own at the END and hands it back, so a caller whose upload
 * died has nothing to name what was stored and no choice but to send the file
 * again. A `uploadStream` is told the id up front, so the windows already in the
 * store are addressable, which is what both a pause and a server restart need.
 *
 * Nothing else about the submission changes: the run is still started after the
 * last byte lands, so the incomplete record a streamed upload leaves along the
 * way is one nobody reads.
 */
async function uploadFiles(
  api: WorkflowApi,
  input: unknown,
  report: (status: UploadStatus) => void,
  parallel: UploadParallel | undefined,
  session: UploadSession,
): Promise<unknown> {
  if (!isRecord(input)) return input;
  const entries = Object.entries(input);
  // Counted before the first byte leaves, because "1 of 3" needs the 3 and the
  // last field is where it becomes known.
  const count = entries.reduce((total, [, value]) => total + filesOf(value).length, 0);
  let index = 0;
  const store = async (file: File): Promise<string> => {
    // Before the early return, so a file's position is the same on every walk: an
    // index derived from what is LEFT would renumber the bar on every resume.
    index += 1;
    const done = session.stored.get(file);
    if (done !== undefined) return done;
    let id = session.ids.get(file);
    if (id === undefined) {
      id = randomUploadId();
      session.ids.set(file, id);
    }
    const position = { name: file.name, index, count };
    await sendThroughGate(session.gate, async (resume) => {
      await api.uploadStream(id, file, {
        name: file.name,
        signal: session.gate.signal,
        onProgress: (progress) =>
          // `gate.paused` rather than a constant `false`: an XHR can deliver one
          // more progress event between the abort and its rejection, and that one
          // would otherwise report a parked upload as running.
          report({ ...position, ...progress, paused: session.gate.paused }),
        // Files stay SEQUENTIAL above whatever this says: `parallel` splits ONE
        // file across connections, and a form sending two recordings at once would
        // still have them competing for the same link with two bars to explain it.
        ...omitUndefined({ parallel, resume: resume ? true : undefined }),
      });
    });
    session.stored.set(file, id);
    return id;
  };
  const out: Record<string, unknown> = {};
  for (const [name, value] of entries) {
    if (value instanceof File) {
      out[name] = await store(value);
      continue;
    }
    const chosen = filesOf(value);
    if (chosen.length === 0) {
      out[name] = value;
      continue;
    }
    const ids: string[] = [];
    for (const file of chosen) ids.push(await store(file));
    // The SHAPE follows the field, not the count: a `multiple` field carrying
    // one file still submits a list, because that is what its schema declares.
    out[name] = ids;
  }
  return out;
}

/** What {@link useWorkflowSubmit} returns. */
export type WorkflowSubmission<R = unknown> = {
  /**
   * Start a run with this input. Resolves once the run EXISTS — progress
   * arrives through `run` — so a `<Form>`'s handler can await it to know the
   * submission was accepted.
   */
  submit: (input: unknown) => Promise<void>;
  /** Clear the run and any error, putting the form back to its initial state. */
  reset: () => void;
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
  /** Correlation key recorded with the run, for finding it again without the id. */
  key?: string;
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
 * @typeParam R - The workflow's output type, which is what makes
 *   `run.status === "completed"` narrow to a typed `run.output`. Derive it with
 *   `WorkflowOutputOf<typeof myWorkflow>`.
 *
 * @example
 * ```tsx
 * import { Form, SubmitButton, TextField, useWorkflowSubmit } from "@alexkroman1/aai-ui";
 *
 * function DigestForm() {
 *   const { submit, run, pending, error } = useWorkflowSubmit("digest");
 *   return (
 *     <Form onSubmit={(values) => submit(values)} error={error}>
 *       <TextField name="url" label="Link" type="url" required />
 *       <SubmitButton pending={pending}>Digest</SubmitButton>
 *       {run?.status === "completed" && <p>Done.</p>}
 *     </Form>
 *   );
 * }
 * ```
 *
 * @public
 */
export function useWorkflowSubmit<R = unknown>(
  workflow: string,
  opts: UseWorkflowSubmitOptions = {},
): WorkflowSubmission<R> {
  const { api, key, wait, intervalMs, parallel } = opts;
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

  const tracked = useWorkflowRun<R>(runId, omitUndefined({ api, intervalMs }));

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
      const current = createUploadSession();
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

  const pauseUpload = useCallback(() => {
    session.current?.gate.pause();
    // The gate stops the bytes; this is what makes the page say so. Folded into
    // the existing status rather than replacing it, because everything else about
    // it — which file, how far, of how many — is still true.
    setUpload((current) => (current ? { ...current, paused: true } : current));
  }, []);

  const resumeUpload = useCallback(() => {
    session.current?.gate.resume();
    setUpload((current) => (current ? { ...current, paused: false } : current));
  }, []);

  return {
    submit,
    reset,
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
    // with no run and no spinner.
    pending: starting || tracked.polling,
    upload,
    error: startError ?? tracked.error,
  };
}
