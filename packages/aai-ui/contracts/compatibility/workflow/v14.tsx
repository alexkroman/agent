// Copyright 2026 the AAI authors. MIT license.

/**
 * Frozen authoring example: `aai-ui:workflow` epoch 14.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * **Epoch 14 ADDS `useDownloadUrl` (with its options and result),
 * `WORKFLOW_STATUS_LABELS` and `WorkflowRunStatus`, and widens two existing
 * shapes additively.** Nothing was removed, so every epoch from 1 to 13 is
 * RETAINED and compiles unchanged beside this file.
 *
 * Each addition is a page's hand-rolled copy moving into the package that owned
 * the rule it kept getting wrong:
 *
 * - **`useDownloadUrl`.** `api.download(id)` resolves a `Blob` — the byte route
 *   takes the same bearer every workflow route does, and neither `<audio src>`
 *   nor `<a href>` can send one — so two templates had written the same four
 *   lines, doc paragraph included. The two worth centralizing are the two those
 *   four are wrapped in: `URL.revokeObjectURL` on cleanup (an object URL pins
 *   its blob for the life of the DOCUMENT, so a miss keeps every completed run's
 *   audio resident until the tab closes) and a `cancelled` flag (a second run
 *   settling while the first download is in flight otherwise renders the first
 *   run's audio under the second run's output). Both copies also faked `pending`
 *   as "neither url nor error", which cannot tell a download in flight from no
 *   id at all; it is its own field here.
 * - **`wake` and `cancel` on the submission.** The hooks held a run id and would
 *   not give it back, so a page wanting "file it now" or "stop" kept a
 *   module-scope `api` purely to write `api.wake(runId)` — carrying the
 *   transport to make up for a hook withholding its own state. Both ANSWER
 *   rather than fail when there is no run (`0` sleeps ended, `false` this call
 *   did not end it), which is the SDK's own contract. `reset()` and `cancel()`
 *   stay distinct: `reset()` puts the FORM back and leaves the run running.
 * - **`lines` on `<WorkflowProgress>`.** `undefined` is the whole log, `1` the
 *   newest line, `0` the placeholder. Two pages had hand-rolled a newest-line
 *   version and each carried the same six-line comment about the `supported`
 *   check whose loss leaves the page blank forever against an older agent.
 *   Narrowing a window is not a reason to re-derive that rule.
 * - **`WORKFLOW_STATUS_LABELS`.** Two pages carried a byte-identical label map
 *   differing only in the `running` string, so the export is neutral
 *   (`"Working…"`) and a page spreads over it. The exhaustiveness argument both
 *   copies were written for survives and moves up: it is a
 *   `Record<WorkflowRunStatus, string>`, so a status added upstream is a compile
 *   error in ONE place every page inherits, and spreading a complete record
 *   cannot drop a key.
 */

import type { ReactNode } from "react";
import {
  Form,
  SubmitButton,
  UploadProgressBar,
  type UseDownloadUrlOptions,
  type UseDownloadUrlResult,
  type UseWorkflowStreamOptions,
  type UseWorkflowSubmitOptions,
  useDownloadUrl,
  useWorkflowStream,
  useWorkflowSubmit,
  WORKFLOW_STATUS_LABELS,
  WorkflowFields,
  WorkflowProgress,
  type WorkflowRunStatus,
  type WorkflowStreamSubmission,
  type WorkflowSubmission,
} from "../../../index.ts";

/** What this workflow answers with. A page names it; nothing here infers it. */
type Transcript = { transcript: string; words: number; audioId: string };

/** Unchanged from epoch 13: one options bag, handed to either hook. */
export const shared: UseWorkflowStreamOptions = { key: "desk", intervalMs: 2000 };
export const stored: UseWorkflowSubmitOptions = { ...shared, wait: 5000 };

/** Unchanged from epoch 13: one result type, whichever hook produced it. */
export function useEitherSubmission(streaming: boolean): WorkflowSubmission<Transcript> {
  const streamed: WorkflowStreamSubmission<Transcript> = useWorkflowStream<Transcript>(
    "transcribeStream",
    shared,
  );
  const submitted = useWorkflowSubmit<Transcript>("transcribe", stored);
  return streaming ? streamed : submitted;
}

/**
 * The labels, spread rather than restated. A page overriding one key keeps the
 * other five, and cannot invent a sixth status the SDK does not have.
 */
export const LABELS: Readonly<Record<WorkflowRunStatus, string>> = {
  ...WORKFLOW_STATUS_LABELS,
  running: "Writing…",
};

/** New at epoch 14: the object-URL lifecycle, owned by the hook. */
export function Playback({ audioId }: { audioId: string | undefined }): ReactNode {
  const options: UseDownloadUrlOptions = {};
  const { url, error, pending }: UseDownloadUrlResult = useDownloadUrl(audioId, options);

  if (pending) return <p>Fetching the audio…</p>;
  if (error !== undefined) return <p role="alert">{error}</p>;
  return url === undefined ? null : <audio controls src={url} />;
}

/** The form, now with the run controls the hook always had and never handed back. */
export function Desk({ streaming }: { streaming: boolean }): ReactNode {
  const { submit, reset, wake, cancel, run, upload, pending, error } =
    useEitherSubmission(streaming);

  return (
    <Form onSubmit={(values) => submit(values)} error={error}>
      <WorkflowFields workflow="transcribe" />
      <UploadProgressBar upload={upload} />
      <SubmitButton pending={pending}>Transcribe</SubmitButton>
      {run && <WorkflowProgress runId={run.runId} lines={1} />}
      {run && <p>{LABELS[run.status]}</p>}
      {run?.status === "completed" && <Playback audioId={run.output.audioId} />}
      <button type="button" onClick={() => void wake()}>
        File it now
      </button>
      <button type="button" onClick={() => void cancel()}>
        Stop
      </button>
      <button type="button" onClick={reset}>
        New run
      </button>
    </Form>
  );
}
