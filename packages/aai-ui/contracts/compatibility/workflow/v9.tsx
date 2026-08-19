// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:workflow` epoch 9.
 *
 * See `../client/v1.tsx` for what "frozen" obliges. `pnpm typecheck` is what runs
 * this, so a break in this package's types surfaces as a compile error inside this
 * file, naming the epoch it broke.
 *
 * Epoch 9 added `useWorkflowStream` — the submit hook that starts a run BEFORE its
 * file has finished uploading. What is frozen here is how a page is written against
 * it, and the shape worth freezing is that it is a drop-in sibling of
 * `useWorkflowSubmit`: same return fields, same `<Form>`, same bar, same progress
 * component. A page swaps one call for the other and nothing else moves.
 */

/** @jsxImportSource react */

import type { ReactNode } from "react";
import {
  Form,
  SubmitButton,
  UploadProgressBar,
  type UseWorkflowStreamOptions,
  useWorkflowStream,
  useWorkflowSubmit,
  WorkflowFields,
  WorkflowProgress,
  type WorkflowStreamSubmission,
} from "../../../index.ts";

/** What this workflow answers with. A page names it; nothing here infers it. */
type Transcript = { transcript: string; words: number };

/**
 * The streaming page: one hook, one form, no upload code.
 *
 * `upload` and `run` are BOTH live here, which is the epoch's whole point — the run
 * exists while the bytes are still moving, so a page can render its progress beside
 * the upload bar rather than after it.
 */
export function StreamingDesk(): ReactNode {
  const { submit, run, upload, pending, error }: WorkflowStreamSubmission<Transcript> =
    useWorkflowStream<Transcript>("transcribe");

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

/** The options bag, so a page can hold one and pass it through. */
export const streamOptions: UseWorkflowStreamOptions = { intervalMs: 2000 };

/**
 * The two hooks are interchangeable at the call site.
 *
 * Not decoration: it is what lets a page offer both paths over one form, which is what
 * the transcription template does. If these two return types ever diverge, this
 * function stops compiling — which is the assertion.
 *
 * Named `use…` because it CALLS hooks unconditionally, which is what a page swapping
 * between the two has to do — a hook may not be conditional, so both run and the
 * choice is which result is read.
 */
export function useEitherFlow(streaming: boolean): { pending: boolean; error: string | undefined } {
  const streamed = useWorkflowStream<Transcript>("transcribeStream", streamOptions);
  const stored = useWorkflowSubmit<Transcript>("transcribe");
  const active = streaming ? streamed : stored;
  return { pending: active.pending, error: active.error };
}
