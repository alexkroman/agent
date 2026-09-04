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
 * ## A failed upload is RESUMED, and only a spent budget cancels the run
 *
 * An upload that dies stays in the store, incomplete, and `complete` never becomes
 * true — so a run left behind polls until its own abandonment bound and then fails,
 * minutes after the page has already reported the error.
 *
 * That used to be the whole story, and it threw away a run and a file together for
 * what is usually one dropped connection near the end. **The resume lives in the
 * SDK now** (`aai/sdk/_upload-resume.ts`): a round that fails for a reason that
 * looks like an outage is re-entered with `resume: true`, sending only the windows
 * the store does not already have, on a budget sized to outlast a redeploy. The run
 * is still waiting on the same id, so a resume that succeeds is invisible to it.
 *
 * This hook used to hand-roll one such retry and no longer does — one resume with
 * no wait in front of it covers a dropped connection and cannot cover the case that
 * actually strands people, which is the agent restarting underneath the upload.
 * Cancelling the run is what happens when the whole budget is spent, and it is the
 * honest end to a submission that did not happen.
 *
 * ## Pausing is the same mechanism, asked for
 *
 * `pauseUpload()` aborts the bytes in flight and holds the uploader;
 * `resumeUpload()` sends what is missing. The store cannot tell that from an
 * outage, because there is nothing to tell apart — see `_upload-session.ts`. The
 * RUN is untouched either way: it goes on polling the id it was started with, and
 * `stream.ts`'s idle bound (five minutes of no new bytes) is what decides that a
 * pause has become an abandonment.
 */

import { errorMessage } from "@alexkroman1/aai";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import type {
  AnyWorkflowDef,
  UploadParallel,
  WorkflowOutputOf,
} from "@alexkroman1/aai/workflow-api";
import { useCallback, useState } from "react";
import { useRunControls } from "./_run-controls.ts";
import { type SubmissionToken, useSubmissionState } from "./_submission-state.ts";
import { coalesceUploadReports } from "./_upload-report.ts";
import {
  createUploadGate,
  randomUploadId,
  sendThroughGate,
  type UploadGate,
} from "./_upload-session.ts";
import { useWorkflowApiRef } from "./_workflow-api-ref.ts";
import { fileFields, filesOf } from "./_workflow-files.ts";
import type {
  UploadStatus,
  UseWorkflowSubmitOptions,
  WorkflowSubmission,
} from "./use-workflow-form.ts";
import { useWorkflowRun } from "./use-workflow-run.ts";
import type { WorkflowApi } from "./workflow-client.ts";
import type { SubmitInputOf } from "./workflow-def-types.ts";

/**
 * Options for {@link useWorkflowStream}.
 *
 * {@link UseWorkflowSubmitOptions} without `wait`, which is the synchronous
 * mode: it holds the `POST` open until the run settles, and here the run is
 * started before its bytes are, so there is nothing left to hold it for.
 *
 * Without `recover` either, and REFUSED rather than ignored: an option a hook
 * accepts and does nothing with is the silent-no-op failure this repo keeps
 * paying for. Adopting an earlier run by key would hand this hook a run whose
 * input names an upload id it did not mint and is not filling — so the run
 * would sit waiting for bytes nobody is sending until its own abandonment
 * bound. That is the same reason `_upload-recall.ts` deliberately does not
 * recall for this hook, one layer up: here the id is part of a run's INPUT.
 * `key` itself still works, and still makes the run findable — but it is NOT
 * defaulted here the way `useWorkflowSubmit` defaults it, because the whole
 * value of that default is the lookup this hook refuses, and minting a key
 * nothing will ever read back is a slot left in storage for no one.
 *
 * `parallel` COMPOSES with what this hook is for rather than competing with it.
 * The run still starts before the bytes, and the store still publishes how far
 * the file is readable — that number is the CONTIGUOUS prefix, so a run reading
 * ahead of the uplink sees the same growing file whether one connection or four
 * are filling it. What changes is only how fast it grows.
 */
export type UseWorkflowStreamOptions = Omit<UseWorkflowSubmitOptions, "wait" | "recover">;

/**
 * What {@link useWorkflowStream} returns: a {@link WorkflowSubmission}, exactly.
 *
 * The same eight fields `useWorkflowSubmit` returns, of which this hook is a
 * drop-in sibling — same `<Form>`, same `<UploadProgressBar>`, same
 * `<WorkflowProgress>`. An ALIAS rather than a second declaration of the eight:
 * the two have to agree field for field to be drop-in, and two copies of a type
 * that have to agree are two copies that can stop agreeing.
 *
 * Exactly two of the fields mean something different here, and both differences
 * follow from WHEN the run is created — it exists before its bytes do:
 *
 * - `submit()` resolves when the UPLOAD finishes, not when the run is accepted;
 *   the run's own progress arrives through `run`. It still resolves rather than
 *   rejecting on a failed upload — the failure is reported through `error`, the
 *   way a form expects.
 * - `run` is set from the moment the run EXISTS, which here is before the bytes
 *   are in. That is what lets a page render `<WorkflowProgress>` beside the
 *   upload bar rather than after it.
 */
export type WorkflowStreamSubmission<R = unknown, I = unknown> = WorkflowSubmission<R, I>;

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
export function useWorkflowStream<D extends AnyWorkflowDef>(
  workflow: string,
  opts: UseWorkflowStreamOptions = {},
): WorkflowStreamSubmission<WorkflowOutputOf<D>, SubmitInputOf<D>> {
  const { api, key, intervalMs, parallel } = opts;
  // The four states, the live-submission ref, the supersede rule, `reset` and
  // the pause pair — shared with `useWorkflowSubmit`. See
  // `_submission-state.ts`.
  const state = useSubmissionState<SubmissionToken>();
  const { runId, actions } = state;

  const getClient = useWorkflowApiRef(api);

  const tracked = useWorkflowRun<WorkflowOutputOf<D>>(runId, omitUndefined({ api, intervalMs }));
  // Same two controls as `useWorkflowSubmit` — this hook returns an ALIAS of
  // that hook's type, so a field missing here is a lie in the shared type.
  const { wake, cancel } = useRunControls(runId, getClient);

  // This hook REFUSES `recover` (see `UseWorkflowStreamOptions`), so every run
  // it reports is one this mount started — but the flag still has to move with
  // `submit`/`reset` rather than being a constant `true`, because it is false
  // before the first submission and again after a clear, and a page shares its
  // markup with `useWorkflowSubmit` pages that read the same field.
  const [startedHere, setStartedHere] = useState(false);

  const submit = useCallback(
    async (input: unknown) => {
      const client = getClient();
      const current: SubmissionToken = { gate: createUploadGate() };
      const { gate } = current;
      setStartedHere(true);
      actions.begin(current);
      let started: string | undefined;
      try {
        // The declaration decides which property is an upload, and it is READ
        // rather than taken as an option so the page cannot disagree with the
        // workflow — see `beginRun`.
        const id = randomUploadId();
        const begun = await beginRun({ client, workflow, input, id, ...omitUndefined({ key }) });
        started = begun.runId;
        const chosen = begun.file;
        actions.setRunId(started);
        if (!chosen) return;
        // Coalesced for the reason `useWorkflowSubmit` coalesces — see
        // `_upload-report.ts`.
        await streamFile({
          client,
          gate,
          id,
          file: chosen,
          parallel,
          report: coalesceUploadReports(actions.setUpload),
        });
        // See the module doc: the run is asleep between polls, so without this it
        // learns the upload is complete a poll interval late. Best-effort.
        await client.wake(started).catch(() => undefined);
      } catch (err: unknown) {
        // An abandoned upload is not a failure to report — `reset()` and the next
        // `submit()` both cancel — but the RUN still has to go, for the reason
        // below: it is waiting on bytes that are not coming either way.
        if (!gate.cancelled) actions.setStartError(errorMessage(err));
        // A run left behind waits for bytes that will never come, until its own
        // abandonment bound — failing long after the page said so. Best-effort: the
        // submission has already failed, and a failing cancel must not replace the
        // error that caused it.
        if (started) await client.cancel(started).catch(() => undefined);
      } finally {
        actions.end(current);
      }
    },
    [workflow, key, parallel, getClient, actions],
  );

  const reset = useCallback(() => {
    setStartedHere(false);
    actions.reset();
  }, [actions]);

  return {
    submit,
    submitForm: submit,
    reset,
    wake,
    cancel,
    pauseUpload: actions.pauseUpload,
    resumeUpload: actions.resumeUpload,
    run: tracked.run,
    startedHere,
    pending: state.starting || tracked.polling,
    upload: state.upload,
    error: state.startError ?? tracked.error,
  };
}

/**
 * Read the declaration, substitute the id, and start the run.
 *
 * Everything that has to happen BEFORE a byte moves, which is the inversion this
 * hook exists for. One small `list()` per submit, deliberately: holding the
 * listing in state would make a submit before it landed a race, and the failure
 * mode of that race is a `File` reaching a run input.
 */
async function beginRun(opts: {
  client: WorkflowApi;
  workflow: string;
  input: unknown;
  id: string;
  key?: string;
}): Promise<{ runId: string; file: File | undefined }> {
  const { client, workflow, input, id } = opts;
  const field = await uploadField(client, workflow);
  const chosen = field === undefined ? undefined : fileAt(input, field);
  // No file to stream: start the run with the input exactly as given. A workflow
  // may declare an upload property and be handed something else (an id from a
  // previous submit, an empty optional), and refusing here would be this hook
  // deciding what its own declaration means.
  const payload = chosen && field ? { ...(input as object), [field]: id } : input;
  // Checked on the PAYLOAD, so the substitution above is what clears it.
  assertSendable(workflow, payload, field);
  const runId = await client.start(workflow, payload, omitUndefined({ key: opts.key }));
  return { runId, file: chosen };
}

/**
 * Send the file, waiting out however many pauses the person takes.
 *
 * Its own function rather than a block inside `submit` because `submit` is
 * already carrying the ORDER this hook exists for — read the declaration, mint
 * the id, start the run, then the bytes, then the wake — and the sending is the
 * one step of that list with a loop in it.
 */
async function streamFile(opts: {
  client: WorkflowApi;
  gate: UploadGate;
  id: string;
  file: File;
  parallel: UploadParallel | undefined;
  report: (status: UploadStatus) => void;
}): Promise<void> {
  const { client, gate, id, file, parallel, report } = opts;
  await sendThroughGate(gate, async (resume) => {
    await client.uploadStream(id, file, {
      name: file.name,
      signal: gate.signal,
      onProgress: (progress) =>
        report({
          ...progress,
          name: file.name,
          index: 1,
          count: 1,
          // Read off the gate rather than fixed at `false`: an XHR can deliver one
          // more progress event between the abort and its rejection, which would
          // otherwise unpause the bar.
          paused: gate.paused,
        }),
      // The SDK re-enters a failed round on its own; this flag is for the round
      // after a PAUSE, which unwound all the way out to here.
      ...omitUndefined({ parallel, resume: resume ? true : undefined }),
    });
  });
}

/**
 * Refuse a payload carrying a `File`, before a run is started over it.
 *
 * A File cannot be SENT: a run input is JSON and `JSON.stringify(new File(…))` is
 * `{}` (see `fileFields`). So without this the run starts, rejects its own input,
 * and reports a type error about a property the user filled in correctly — which is
 * what production did, five times: `Invalid input for workflow "transcribe":
 * recording: Invalid input`, from a page whose file picker was working.
 *
 * The reachable cause is a workflow whose listing declares no `uploads` for the
 * property the form put a file in — one built before the declaration existed, or a
 * page pointing at the wrong workflow — so the message names BOTH halves: the
 * property that carries a file, and the one (if any) the workflow says is its
 * upload. A message naming only one of them leaves the reader guessing which end
 * to change.
 *
 * A throw rather than a silent repair: this hook cannot know whether the right fix
 * is to declare the property or to stop sending the file, and guessing either way
 * would start a run the caller did not mean.
 */
function assertSendable(workflow: string, payload: unknown, field: string | undefined): void {
  const unsendable = fileFields(payload);
  if (unsendable.length === 0) return;
  const carries = unsendable.length === 1 ? "carries a file" : "carry files";
  const declares = field === undefined ? "" : ` (it declares "${field}")`;
  throw new Error(
    `Cannot start "${workflow}": ${unsendable.join(", ")} ${carries} the workflow does not ` +
      `declare as an upload${declares}. Add the property to \`workflow({ uploads: [...] })\`, ` +
      "or submit an upload id.",
  );
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
