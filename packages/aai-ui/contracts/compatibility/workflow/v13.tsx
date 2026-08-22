// Copyright 2026 the AAI authors. MIT license.

/**
 * Frozen authoring example: `aai-ui:workflow` epoch 13.
 *
 * **Nothing a page writes changed**, which is why epoch 12 is RETAINED and
 * `./v12.tsx` compiles unchanged beside this file. The epoch moved because two
 * of the streaming hook's types stopped being hand-copied declarations and
 * became what they had always described: `WorkflowStreamSubmission<R>` is now
 * an alias of `WorkflowSubmission<R>`, and `UseWorkflowStreamOptions` is
 * `Omit<UseWorkflowSubmitOptions, "wait">`. Both were identical field for field
 * to the thing they now name, so the rolled-up `.d.ts` records a changed type
 * expression and no changed shape.
 *
 * What is worth freezing is the property that made the copies pointless and
 * that the aliases now hold by construction: the two hooks are
 * INTERCHANGEABLE at the call site, options and result alike. `./v9.tsx`
 * asserts the result half and keeps doing so; this file adds the options half,
 * which the copy could never guarantee.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 */

import type { ReactNode } from "react";
import {
  Form,
  SubmitButton,
  UploadProgressBar,
  type UseWorkflowStreamOptions,
  type UseWorkflowSubmitOptions,
  useWorkflowStream,
  useWorkflowSubmit,
  WorkflowFields,
  WorkflowProgress,
  type WorkflowStreamSubmission,
  type WorkflowSubmission,
} from "../../../index.ts";

/** What this workflow answers with. A page names it; nothing here infers it. */
type Transcript = { transcript: string; words: number };

/**
 * One options bag, handed to either hook.
 *
 * Everything the streaming hook takes, the storing one takes too — `wait` is
 * the single field going the other way, and it has nothing to hold open here
 * because the run is started before its bytes are.
 */
export const shared: UseWorkflowStreamOptions = { key: "desk", intervalMs: 2000 };
export const stored: UseWorkflowSubmitOptions = { ...shared, wait: 5000 };

/**
 * One result type, whichever hook produced it.
 *
 * A page that renders the two flows over one form holds the submission in a
 * single binding, which is what the alias makes expressible — `streamed` and
 * `submitted` are the same type, so this compiles without a cast or a union.
 */
export function useEitherSubmission(streaming: boolean): WorkflowSubmission<Transcript> {
  const streamed: WorkflowStreamSubmission<Transcript> = useWorkflowStream<Transcript>(
    "transcribeStream",
    shared,
  );
  const submitted = useWorkflowSubmit<Transcript>("transcribe", stored);
  return streaming ? streamed : submitted;
}

/** And the form under it, written once for both. */
export function Desk({ streaming }: { streaming: boolean }): ReactNode {
  const { submit, run, upload, pending, error } = useEitherSubmission(streaming);

  return (
    <Form onSubmit={(values) => submit(values)} error={error}>
      <WorkflowFields workflow="transcribe" />
      <UploadProgressBar upload={upload} />
      <SubmitButton pending={pending}>Transcribe</SubmitButton>
      {run && <WorkflowProgress runId={run.runId} />}
      {run?.status === "completed" && <p>{run.output.words} words</p>}
    </Form>
  );
}
