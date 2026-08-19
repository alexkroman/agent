// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:workflow` epoch 10.
 *
 * See `../client/v1.tsx` for what "frozen" obliges. `pnpm typecheck` is what runs
 * this, so a break in this package's types surfaces as a compile error inside this
 * file, naming the epoch it broke.
 *
 * Epoch 10 added `parallel` to both submit hooks — the option that splits the
 * chosen file across several connections instead of sending it in one request.
 * What is frozen is that it is an ORDINARY option on both, taking the same values
 * (`true`, or the settings), so a page turns it on without changing anything else
 * about how it submits: same `<Form>`, same bar, same run.
 */

/** @jsxImportSource react */

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
} from "../../../index.ts";

/** What this workflow answers with. A page names it; nothing here infers it. */
type Transcript = { transcript: string; words: number };

/** Both options bags take it, which is what makes the two hooks still swappable. */
export const submitOptions: UseWorkflowSubmitOptions = { parallel: true };
export const streamOptions: UseWorkflowStreamOptions = {
  intervalMs: 2000,
  parallel: { partBytes: 16 * 1024 * 1024, concurrency: 6 },
};

/**
 * A page that lets the reader choose how the file travels.
 *
 * The option is a piece of page STATE handed to the hook, rather than something
 * decided at module scope — which is the shape the transcription template ships
 * and the one worth freezing, since it is what proves the option may change
 * between renders.
 */
export function ParallelDesk({ parallel }: { parallel: boolean }): ReactNode {
  const { submit, upload, pending, error } = useWorkflowSubmit<Transcript>("transcribe", {
    parallel,
  });

  return (
    <Form onSubmit={(values) => submit(values)} error={error}>
      <WorkflowFields workflow="transcribe" />
      <UploadProgressBar upload={upload} />
      <SubmitButton pending={pending}>Transcribe</SubmitButton>
    </Form>
  );
}

/**
 * And on the streaming hook, where it composes with starting the run first.
 *
 * Both are called unconditionally — a hook may not be conditional — so a page
 * offering both paths over one form reads whichever result it wants.
 */
export function useEitherParallelFlow(streaming: boolean): { pending: boolean } {
  const streamed = useWorkflowStream<Transcript>("transcribeStream", streamOptions);
  const stored = useWorkflowSubmit<Transcript>("transcribe", submitOptions);
  return { pending: (streaming ? streamed : stored).pending };
}
