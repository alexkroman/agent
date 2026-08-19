// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:workflow-api` epoch 5.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are relative.
 *
 * Epoch 5 added `UploadOptions.parallel` — sending one file over several
 * connections at once instead of in a single request. Two things are frozen here
 * and both are about how a caller SPELLS it: `true` takes the defaults, and an
 * object tunes them, so a caller that only wants the speed never names a number.
 * It applies to both writers, which is the other half of the promise: the
 * caller-named `uploadStream` still starts its run first, and the fan-out only
 * changes how fast the file grows underneath it.
 */

import {
  createWorkflowApiClient,
  type UploadOptions,
  type UploadParallel,
  type UploadPartsSettings,
  type UploadRef,
} from "../../../sdk/workflow-api-client.ts";

/** The defaults, which is what a form passes. */
export const fanOut: UploadParallel = true;

/** And the tuned form, for a caller that knows its own link. */
export const tuned: UploadPartsSettings = { partBytes: 16 * 1024 * 1024, concurrency: 6 };

/** Store a recording as concurrent parts, drawing one bar over the whole file. */
export async function uploadInParallel(baseUrl: string, file: Blob): Promise<UploadRef> {
  const api = createWorkflowApiClient({ baseUrl });
  const options: UploadOptions = {
    name: "standup.wav",
    parallel: fanOut,
    // The reports still describe the FILE, not whichever part reported last.
    onProgress: (progress) => void progress.fraction,
  };
  return await api.upload(file, options);
}

/** The same option on the caller-named writer, which a run can be started on first. */
export async function streamInParallel(baseUrl: string, file: Blob): Promise<string> {
  const api = createWorkflowApiClient({ baseUrl });
  const id = crypto.randomUUID().replaceAll("-", "");
  const runId = await api.start("transcribe", { recording: id });
  await api.uploadStream(id, file, { name: "standup.wav", parallel: tuned });
  await api.wake(runId);
  return runId;
}
