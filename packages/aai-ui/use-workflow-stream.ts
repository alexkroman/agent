// Copyright 2026 the AAI authors. MIT license.
/**
 * Starting a run BEFORE its file has finished uploading.
 *
 * `useWorkflowSubmit` (`use-workflow-form.ts`) stores every file and then starts the
 * run, because a `POST /workflows/uploads` cannot answer with an id until the last
 * byte is in — the store writes an ordinary upload's record last, so "incomplete"
 * and "no such upload" are deliberately the same answer. For a long recording that
 * order is most of the wall clock.
 *
 * This hook inverts it, and it takes ONE extra idea to do so: the id is the
 * CLIENT's. It mints one, starts the run on it, and `PUT`s the whole file in a
 * single streaming request; the upload record exists from the first byte with
 * `complete: false` and its `size` grows, so the run reads whatever has arrived.
 *
 * ```text
 *   start run ─┬──────────────────────────────────────────────► (still running)
 *              │
 *   PUT /uploads/<id>  ═══════════════════════════════════►  wake
 *              (one request; the run polls `size` and `complete`)
 * ```
 *
 * ## What it does NOT do, which is the point
 *
 * There is no cutting, no part numbering, no terminator and no per-part request. An
 * earlier version of this hook took a `cut` callback and uploaded N parts into a
 * "group" that a separate call had to seal; it worked, and every piece of it was
 * something the caller had to get right. The whole of that is replaced by the store
 * publishing `size` as bytes land — which `readUpload` already clamped to — so the
 * run does exactly what it does over a finished file and simply waits for windows to
 * become present.
 *
 * It also means the FORMAT knowledge stays where it already was. Deciding where a
 * recording may be divided is the run's business (`planSegments` in the
 * transcription template), and nothing here needs to know it is audio at all.
 *
 * ## Three things it owns
 *
 * - **The id.** Minted here, put in the run input where the workflow's `uploads`
 *   list says, and never seen by the page. It is a capability — anyone holding it
 *   can read the bytes back — so it is a `crypto.randomUUID()` rather than anything
 *   derived from the file, and the store refuses a second `PUT` to it.
 * - **The wake after the upload.** `POST /workflows/runs/:id/wake` ends a pending
 *   `sleep`, and a run waiting on an upload is asleep between polls — so without
 *   this it learns the file is complete up to a poll interval late, every time. On
 *   the transcription template's 5-second interval that is most of the tail it has
 *   left to pay. Best-effort, because a wake that finds nothing sleeping answers 0
 *   and a missed one costs latency rather than correctness.
 * - **Reporting the bytes.** The same `UploadStatus` `useWorkflowSubmit` reports,
 *   so `<UploadProgressBar>` renders either without knowing which hook it came from.
 *
 * ## A failed upload CANCELS the run
 *
 * An upload that dies stays in the store, incomplete, and `complete` never becomes
 * true — so a run left behind polls until its own abandonment bound and then fails,
 * minutes after the page has already reported the error. Cancelling is the honest
 * end to a submission that did not happen. The cost is that work already done is
 * thrown away with the run; a caller who wants to resume instead drives
 * `api.uploadStream` and `api.uploadInfo` directly.
 */

import { errorMessage } from "@alexkroman1/aai";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import type { UploadParallel } from "@alexkroman1/aai/workflow-api";
import { useCallback, useState } from "react";
import { useWorkflowApiRef } from "./_workflow-api-ref.ts";
import { filesOf } from "./_workflow-files.ts";
import type { UploadStatus } from "./use-workflow-form.ts";
import { useWorkflowRun } from "./use-workflow-run.ts";
import type { WorkflowApi, WorkflowRun } from "./workflow-client.ts";

/** Options for {@link useWorkflowStream}. */
export type UseWorkflowStreamOptions = {
  /** The client to start runs with. Defaults to one for the page's own agent. */
  api?: WorkflowApi;
  /** Correlation key recorded with the run, for finding it again without the id. */
  key?: string;
  /** How often the fallback poll re-reads a live run. */
  intervalMs?: number;
  /**
   * Send the file as concurrent parts instead of in one streaming request.
   *
   * It COMPOSES with what this hook is for rather than competing with it: the run
   * still starts before the bytes, and the store still publishes how far the file
   * is readable — that number is the CONTIGUOUS prefix, so a run reading ahead of
   * the uplink sees the same growing file whether one connection or four are
   * filling it. What changes is only how fast it grows.
   *
   * `true` for the defaults, or `{ partBytes, concurrency }` to tune them. See
   * `UploadOptions.parallel`.
   */
  parallel?: UploadParallel;
};

/** What {@link useWorkflowStream} returns. */
export type WorkflowStreamSubmission<R = unknown> = {
  /**
   * Start a run and stream this input's file into it.
   *
   * Resolves when the upload finishes, NOT when the run does — the run's own
   * progress arrives through `run`. It resolves rather than rejecting on a failed
   * upload; the failure is reported through `error`, the way a form expects.
   */
  submit: (input: unknown) => Promise<void>;
  /** Clear the run and any error, putting the form back to its initial state. */
  reset: () => void;
  /**
   * The run, from the moment it EXISTS — which here is before its bytes are in.
   *
   * That is the whole difference from `useWorkflowSubmit`, and what lets a page
   * render `<WorkflowProgress>` beside the upload bar rather than after it.
   */
  run: WorkflowRun<R> | undefined;
  /** True from `submit()` until the run reaches a terminal status. */
  pending: boolean;
  /** How far the upload has got, while it is still going. */
  upload: UploadStatus | undefined;
  /** The submit's own failure (a rejected input, or an upload that would not store). */
  error: string | undefined;
};

/**
 * Start a workflow run and stream a file into it while it works.
 *
 * The workflow declares which input property carries the upload
 * (`workflow({ uploads: ["recording"] })`) — the same declaration
 * `useWorkflowSubmit` reads, because what the property carries is an upload id
 * either way. What differs is only WHEN the id becomes valid.
 *
 * @typeParam R - The workflow's output type, which is what makes
 *   `run.status === "completed"` narrow to a typed `run.output`. Derive it with
 *   `WorkflowOutputOf<typeof myWorkflow>`.
 *
 * @example
 * ```tsx no-check
 * const { submit, run, upload, pending, error } = useWorkflowStream("transcribe");
 *
 * <Form onSubmit={(values) => submit(values)} error={error}>
 *   <WorkflowFields workflow="transcribe" />
 *   <UploadProgressBar upload={upload} />
 *   <SubmitButton pending={pending}>Transcribe</SubmitButton>
 * </Form>
 * ```
 *
 * @public
 */
export function useWorkflowStream<R = unknown>(
  workflow: string,
  opts: UseWorkflowStreamOptions = {},
): WorkflowStreamSubmission<R> {
  const { api, key, intervalMs, parallel } = opts;
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | undefined>(undefined);
  const [upload, setUpload] = useState<UploadStatus | undefined>(undefined);

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
      setRunId(undefined);
      let started: string | undefined;
      try {
        // The declaration decides which property is an upload, and it is READ here
        // rather than taken as an option so the page cannot disagree with the
        // workflow. One small GET per submit, deliberately: holding the listing in
        // state would make a submit before it landed a race, and the failure mode of
        // that race is a File reaching a run input.
        const field = await uploadField(client, workflow);
        const chosen = field === undefined ? undefined : fileAt(input, field);
        const id = randomUploadId();
        // No file to stream: start the run with the input exactly as given. A
        // workflow may declare an upload property and be handed something else (an
        // id from a previous submit, an empty optional), and refusing here would be
        // this hook deciding what its own declaration means.
        const payload = chosen && field ? { ...(input as object), [field]: id } : input;
        started = await client.start(workflow, payload, omitUndefined({ key }));
        setRunId(started);
        if (!chosen) return;
        await client.uploadStream(id, chosen, {
          name: chosen.name,
          onProgress: (progress) =>
            setUpload({ ...progress, name: chosen.name, index: 1, count: 1 }),
          ...omitUndefined({ parallel }),
        });
        // See the module doc: the run is asleep between polls, so without this it
        // learns the upload is complete a poll interval late. Best-effort.
        await client.wake(started).catch(() => undefined);
      } catch (err: unknown) {
        setStartError(errorMessage(err));
        // A run left behind waits for bytes that will never come, until its own
        // abandonment bound — failing long after the page said so. Best-effort: the
        // submission has already failed, and a failing cancel must not replace the
        // error that caused it.
        if (started) await client.cancel(started).catch(() => undefined);
      } finally {
        setStarting(false);
        setUpload(undefined);
      }
    },
    [workflow, key, parallel, getClient],
  );

  const reset = useCallback(() => {
    setRunId(undefined);
    setStartError(undefined);
    setUpload(undefined);
  }, []);

  return {
    submit,
    reset,
    run: tracked.run,
    pending: starting || tracked.polling,
    upload,
    error: startError ?? tracked.error,
  };
}

/** A fresh upload id: a capability, so it is random rather than derived. */
function randomUploadId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/**
 * Which input property this workflow says carries an upload id.
 *
 * `undefined` when the workflow declares none, which is not an error: the caller
 * may be using this hook against a workflow that takes no file at all, and the run
 * then starts with the input untouched.
 */
async function uploadField(client: WorkflowApi, workflow: string): Promise<string | undefined> {
  const summary = (await client.list()).find((one) => one.name === workflow);
  return summary?.uploads?.[0];
}

/** The `File` at `field`, if that is what the form put there. */
function fileAt(input: unknown, field: string): File | undefined {
  if (!isRecord(input)) return undefined;
  // The same predicate `useWorkflowSubmit` uses, so a value one hook reads as a file
  // cannot be something the other reads as a plain string.
  return filesOf(input[field])[0];
}
