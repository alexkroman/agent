// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:workflow` epoch 11.
 *
 * See `../client/v1.tsx` for what "frozen" obliges. `pnpm typecheck` is what runs
 * this, so a break in this package's types surfaces as a compile error inside this
 * file, naming the epoch it broke.
 *
 * Epoch 11 made a long upload interruptible. Three things are frozen here, and
 * they are the three a page has to write:
 *
 * - **Both hooks return `pauseUpload`/`resumeUpload`**, and they return the SAME
 *   pair — so a page choosing between the two flows at runtime destructures one
 *   shape, which is what `useEitherFlow` below proves.
 * - **`<UploadProgressBar>` takes them as `onPause`/`onResume`**, both optional,
 *   so every epoch-10 page that passes neither still compiles.
 * - **`UploadStatus` carries `paused`**, which is what lets a page render its own
 *   chrome instead of the component's.
 */

/** @jsxImportSource react */

import type { ReactNode } from "react";
import {
  Form,
  SubmitButton,
  UploadProgressBar,
  type UploadStatus,
  useWorkflowStream,
  useWorkflowSubmit,
  WorkflowFields,
} from "../../../index.ts";

/** What this workflow answers with. A page names it; nothing here infers it. */
type Transcript = { transcript: string; words: number };

/** The bar draws the control when it is handed both handlers, and only then. */
export function PausableDesk(): ReactNode {
  const { submit, upload, pending, error, pauseUpload, resumeUpload } =
    useWorkflowSubmit<Transcript>("transcribe", { parallel: true });

  return (
    <Form onSubmit={(values) => submit(values)} error={error}>
      <WorkflowFields workflow="transcribe" />
      <UploadProgressBar upload={upload} onPause={pauseUpload} onResume={resumeUpload} />
      <SubmitButton pending={pending}>Transcribe</SubmitButton>
    </Form>
  );
}

/**
 * A page drawing its own control off the status.
 *
 * `paused` is a plain boolean on `UploadStatus`, so this needs nothing from the
 * component — which is the property that makes the component's own control a
 * convenience rather than the only way to reach the feature.
 */
export function ownChrome(upload: UploadStatus | undefined): string {
  if (!upload) return "idle";
  return upload.paused ? `paused at ${upload.loaded} bytes` : "uploading";
}

/**
 * Both flows expose the same pair, so a page may switch between them.
 *
 * Called unconditionally — a hook may not be conditional — and the result of
 * whichever one the page is showing is what its controls are wired to.
 */
export function useEitherFlow(streaming: boolean): {
  pending: boolean;
  pause: () => void;
  resume: () => void;
} {
  const streamed = useWorkflowStream<Transcript>("transcribeStream", { parallel: true });
  const stored = useWorkflowSubmit<Transcript>("transcribe", { parallel: true });
  const active = streaming ? streamed : stored;
  return { pending: active.pending, pause: active.pauseUpload, resume: active.resumeUpload };
}
