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
import { useCallback, useEffect, useState } from "react";
import { useWorkflowApiRef } from "./_workflow-api-ref.ts";
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
 * Replace every `File` in a submitted form with the id of a stored upload.
 *
 * Sequential rather than `Promise.all`: these are large bodies, and a form with
 * two 200 MB recordings should send them one after another rather than compete
 * for the same connection.
 *
 * Anything that is not a `File` (or an array of them) passes through untouched,
 * so this is invisible to every form that has none — including one whose values
 * are not an object at all, which `submit` accepts.
 */
async function uploadFiles(api: WorkflowApi, input: unknown): Promise<unknown> {
  if (!isRecord(input)) return input;
  const entries = Object.entries(input);
  const out: Record<string, unknown> = {};
  for (const [name, value] of entries) {
    if (value instanceof File) {
      out[name] = (await api.upload(value)).id;
    } else if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((one) => one instanceof File)
    ) {
      const ids: string[] = [];
      for (const file of value) ids.push((await api.upload(file)).id);
      out[name] = ids;
    } else {
      out[name] = value;
    }
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
  const { api, key, wait, intervalMs } = opts;
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | undefined>(undefined);

  // The caller's client through a ref — see `_workflow-api-ref.ts`.
  const getClient = useWorkflowApiRef(api);

  const tracked = useWorkflowRun<R>(runId, {
    ...(api && { api }),
    ...omitUndefined({ intervalMs }),
  });

  const submit = useCallback(
    async (input: unknown) => {
      const client = getClient();
      setStarting(true);
      setStartError(undefined);
      // Dropped BEFORE the request, not after it returns: the previous run's
      // result must not sit under a form that is already submitting again.
      setRunId(undefined);
      try {
        const options = omitUndefined({ key });
        // Files first: a run input carries an upload ID, never bytes, and this
        // is the one place that knows both the chosen file and the client that
        // can store it. A form using `<FileField upload>` (which is what
        // `<WorkflowFields>` renders for a declared upload property) therefore
        // needs no upload code of its own.
        const started = await uploadFiles(client, input);
        // Both paths end in a run id — the difference is only whether the agent
        // held the request open — so the watch below is identical either way.
        setRunId(
          wait === undefined
            ? await client.start(workflow, started, options)
            : (await client.startAndWait(workflow, started, { ...options, wait })).runId,
        );
      } catch (err: unknown) {
        setStartError(errorMessage(err));
      } finally {
        setStarting(false);
      }
    },
    [workflow, key, wait, getClient],
  );

  const reset = useCallback(() => {
    setRunId(undefined);
    setStartError(undefined);
  }, []);

  return {
    submit,
    reset,
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
    error: startError ?? tracked.error,
  };
}
