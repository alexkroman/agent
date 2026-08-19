// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:workflow-api` epoch 6.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are relative.
 *
 * Epoch 6 added `UploadOptions.resume` — continuing an upload already begun under
 * an id, sending only the windows the store does not have. What is frozen is the
 * shape of a caller that uses it, and that shape is a SECOND attempt: a first
 * upload never carries the flag, because a fresh id has nothing to resume and
 * saying otherwise waives the refusal that makes a caller-chosen id safe.
 */

import {
  createWorkflowApiClient,
  type UploadOptions,
  type UploadRef,
} from "../../../sdk/workflow-api-client.ts";

/** What a resume asks for, on top of whatever the first attempt asked for. */
export const resuming: UploadOptions = { name: "standup.wav", resume: true };

/**
 * Send a recording, and finish it rather than start it over if the link drops.
 *
 * The id is the caller's, which is what makes the second call reach the same
 * upload; `resume` is what makes the store's refusal of a second claim mean
 * "continue this one" instead of "that id is taken".
 */
export async function uploadResumably(baseUrl: string, file: Blob): Promise<UploadRef> {
  const api = createWorkflowApiClient({ baseUrl });
  const id = crypto.randomUUID().replaceAll("-", "");
  try {
    return await api.uploadStream(id, file, { name: "standup.wav" });
  } catch {
    return await api.uploadStream(id, file, resuming);
  }
}

/** How much of it is already stored, which is what a resume would skip. */
export async function alreadyStored(baseUrl: string, id: string): Promise<number> {
  const api = createWorkflowApiClient({ baseUrl });
  const info = await api.uploadInfo(id);
  return (info.ranges ?? []).reduce((bytes, range) => bytes + (range.end - range.start), 0);
}
