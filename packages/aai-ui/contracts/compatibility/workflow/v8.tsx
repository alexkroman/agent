// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:workflow` epoch 8.
 *
 * Epoch 8 adds `WorkflowSubmission.upload` and `<UploadProgressBar>` — the bar
 * over the one wait a run cannot describe, since no run exists until its input
 * is stored. Everything epoch 7 could express still compiles (see `./v7.tsx`,
 * retained for that reason); this file covers only what is new.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 */

import { UploadProgressBar, type UploadStatus, useWorkflowSubmit } from "../../../index.ts";

/** The whole of it: pass what the hook reports, unguarded. */
export function Uploading() {
  const { submit, upload, pending } = useWorkflowSubmit("transcribe");
  return (
    <form onSubmit={() => void submit({})}>
      <UploadProgressBar upload={upload} />
      <button type="submit" disabled={pending}>
        Transcribe
      </button>
    </form>
  );
}

/** Styled by the caller, replacing the default classes. */
export function StyledBar({ upload }: { upload: UploadStatus | undefined }) {
  return <UploadProgressBar upload={upload} className="flex flex-col gap-1" />;
}

/** The report is readable on its own, for a page drawing its own chrome. */
export function statusLine(upload: UploadStatus): string {
  const { name, index, count, loaded, total, fraction }: UploadStatus = upload;
  const share = fraction === undefined ? "…" : `${Math.round(fraction * 100)}%`;
  const size = total === undefined ? `${loaded} B` : `${loaded}/${total} B`;
  return `${name} (${index} of ${count}): ${share} — ${size}`;
}
