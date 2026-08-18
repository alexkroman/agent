// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `workflow-api` epoch 3.
 *
 * Epoch 3 adds `UploadOptions.onProgress` and the {@link UploadProgress} it
 * reports — the only call on this surface slow enough that a caller has to say
 * how far it has got. Every earlier call is unchanged and `./v2.ts` is retained,
 * so this file demonstrates only what is new.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  createWorkflowApiClient,
  type UploadProgress,
  type UploadRef,
} from "../../../sdk/workflow-api-client.ts";

const api = createWorkflowApiClient({ baseUrl: "https://agents.example/my-agent" });

/** The whole of it: a callback taking one report. */
export async function storeWithProgress(
  file: File,
  onProgress: (progress: UploadProgress) => void,
): Promise<UploadRef> {
  return await api.upload(file, { onProgress });
}

/**
 * What a bar reads off a report: the fraction, or nothing when the total is not
 * knowable — which is the case a caller has to render as indeterminate.
 */
export function barWidth(progress: UploadProgress): string {
  if (progress.fraction === undefined) return "100%";
  return `${Math.round(progress.fraction * 100)}%`;
}

/** The counts are there too, for a caller that would rather show bytes. */
export function sizeLine(progress: UploadProgress): string {
  const { loaded, total }: { loaded: number; total: number | undefined } = progress;
  return total === undefined ? `${loaded} B` : `${loaded} of ${total} B`;
}

/** It composes with the options epoch 2 already took. */
export async function storeNamedWithProgress(
  bytes: Uint8Array,
  onProgress: (progress: UploadProgress) => void,
): Promise<UploadRef> {
  return await api.upload(bytes, {
    name: "standup.wav",
    type: "audio/wav",
    signal: AbortSignal.timeout(10 * 60_000),
    onProgress,
  });
}
