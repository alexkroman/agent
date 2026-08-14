// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `workflow-api` epoch 2.
 *
 * Epoch 2 adds `upload()` — the call that puts bytes somewhere a run can reach
 * them, which is the half `start()` cannot do: an input is journaled and
 * replayed, so it carries the id this resolves and never the file. Epoch 1's
 * ten calls are unchanged and `./v1.ts` is retained, so this file demonstrates
 * only what is new.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  createWorkflowApiClient,
  type UploadBody,
  type UploadOptions,
  type UploadRef,
  type WorkflowApi,
} from "../../../sdk/workflow-api-client.ts";

const api: WorkflowApi = createWorkflowApiClient({
  baseUrl: "https://agents.example/my-agent",
});

/** Every option the call takes, written out rather than inferred. */
const options: UploadOptions = {
  name: "standup.wav",
  type: "audio/wav",
  signal: AbortSignal.timeout(10 * 60_000),
};

/** A `File` needs no options at all: its own name and type are what get stored. */
export async function storeChosenFile(file: File): Promise<UploadRef> {
  return await api.upload(file);
}

/** Anything else says what it is, since the name is all a step will ever see. */
export async function storeBytes(bytes: Uint8Array): Promise<UploadRef> {
  const body: UploadBody = bytes;
  return await api.upload(body, options);
}

/** The two halves together: store the file, then start the run that reads it. */
export async function transcribe(file: File): Promise<string> {
  const stored = await api.upload(file);
  return await api.start("transcribe", { recording: stored.id, languageCode: "en" });
}
