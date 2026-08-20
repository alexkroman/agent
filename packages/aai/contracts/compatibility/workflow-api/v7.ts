// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:workflow-api` epoch 7.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are relative.
 *
 * Epoch 7 changes no export NAME — it adds a method to `WorkflowApi`:
 * `download(id)`, the read half of an upload's bytes and the other end of a run
 * that PRODUCED a file. A run's output is read back as JSON, so a step stores
 * audio, an image or a PDF with `writeUpload` and returns the id; this is how a
 * caller turns that id back into something to play, show or save.
 *
 * It answers a `Blob` rather than a URL, and that is the part worth freezing: the
 * byte route takes the same `Authorization` header every other route here does,
 * and neither `<audio src>` nor `<a href>` can send one — so a page built on a
 * URL works against an agent with no token and 401s against one with a token.
 */

import { createWorkflowApiClient, type WorkflowApi } from "../../../sdk/workflow-api-client.ts";

/** The client, built once — a fresh one per render is a fresh `fetch` closure. */
const api: WorkflowApi = createWorkflowApiClient({ baseUrl: "https://agent.example/" });

/** Start a run over an uploaded file and answer with its id. */
export async function summarize(file: Blob): Promise<string> {
  const stored = await api.upload(file, { name: "recording.wav", type: "audio/wav" });
  return await api.start("spokenSummary", { recording: stored.id });
}

/**
 * Read a file the RUN produced, as something a browser element takes.
 *
 * The caller owns the object URL: it pins its blob for the life of the
 * document, so a page that made several holds every one of them.
 */
export async function playable(uploadId: string, signal?: AbortSignal): Promise<string> {
  const blob = await api.download(uploadId, signal === undefined ? {} : { signal });
  return URL.createObjectURL(blob);
}

/** The record beside the bytes, for a caller that wants the name or the size. */
export async function describe(uploadId: string): Promise<{ name: string; size: number }> {
  const info = await api.uploadInfo(uploadId);
  return { name: info.name, size: info.size };
}
