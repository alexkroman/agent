// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:workflow-api` epoch 4.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are relative.
 *
 * Epoch 4 added the two calls that let a caller START A RUN BEFORE ITS FILE IS IN:
 * `uploadStream`, which PUTs a file under an id the caller chose, and `uploadInfo`,
 * which reports how much of it has landed. The ORDER below is the contract — the id
 * exists first, so it can go in a run input.
 */

import {
  createWorkflowApiClient,
  type UploadInfo,
  type UploadRef,
  type WorkflowApi,
} from "../../../sdk/workflow-api-client.ts";

/** Start a run on an id the caller picked, then stream the file into it. */
export async function streamIntoRun(
  baseUrl: string,
  file: Blob,
): Promise<{ runId: string; stored: UploadRef }> {
  const api: WorkflowApi = createWorkflowApiClient({ baseUrl });
  // The caller's own id: valid before a byte has been sent, which is what makes the
  // next line possible at all.
  const id = crypto.randomUUID().replaceAll("-", "");
  const runId = await api.start("transcribe", { recording: id });
  const stored = await api.uploadStream(id, file, {
    name: "standup.wav",
    onProgress: (progress) => void progress.fraction,
  });
  // The run sleeps between polls, so telling it the file has landed is what saves the
  // last interval.
  await api.wake(runId);
  return { runId, stored };
}

/** Watch an upload that is still arriving, from outside the run. */
export async function watchUpload(baseUrl: string, id: string): Promise<boolean> {
  const api = createWorkflowApiClient({ baseUrl });
  const info: UploadInfo = await api.uploadInfo(id);
  return info.complete;
}
