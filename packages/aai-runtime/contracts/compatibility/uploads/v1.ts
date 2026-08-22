// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 TEMPLATE for `aai-runtime:uploads` — the upload starter as it was
 * written at epoch 1. Copy this file into your own host and edit the marked
 * points; it is meant to be taken, not read.
 *
 * **FROZEN.** This copy must keep compiling against current source for as long
 * as epoch 1 is supported, so a compile error here is the finding — never
 * something to edit away. Changing the API means a NEW epoch carrying a new
 * template, never an edit to this one. Imports are relative
 * (`../../../runtime-barrel.ts`) because the package cannot resolve itself by
 * name.
 *
 * ## What this is
 *
 * The two upload routes a host serves, front to back: pick the byte backend
 * from the environment, hand a request body to the store as it arrives, read a
 * window back out, and map the store's two refusals to the statuses a client
 * can act on.
 *
 * ## What to change
 *
 * - {@link MAX_UPLOAD_BYTES} — your per-file cap.
 * - {@link uploadBlobsFor} — point it at your own bucket.
 * - The route results — reshape the bodies to whatever your framework sends.
 *
 * ## What not to change
 *
 * The status mapping in {@link uploadRefusal}. 413 is the CALLER's fault and its
 * remedy is a smaller file; 501 is the OPERATOR's and its whole content is the
 * configuration that is missing. Collapsing either into 500/502/503/504 makes
 * both retryable, so a client spends its full retry budget before the message
 * that matters arrives last — and an unconfigured deployment then looks like a
 * flaky link instead of a missing bucket.
 *
 * The store arrives as a PARAMETER. An embedder is handed one by the server it
 * embeds; do not try to build one here.
 */

import {
  createHttpUploadBlobs,
  createMemoryUploadBlobs,
  UPLOAD_STORAGE_BUCKET_ENV,
  UPLOAD_STORAGE_KEY_ENV,
  UPLOAD_STORAGE_URL_ENV,
  type UploadBlobs,
  type UploadMeta,
  type UploadStore,
  UploadsUnavailableError,
  UploadTooLargeError,
} from "../../../runtime-barrel.ts";

/** Per-file cap this host accepts. ← your limit. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Where this deployment's bytes go, read off its own environment.
 *
 * ← your bucket: the three `AAI_UPLOAD_STORAGE_*` variables are all-or-nothing
 * on purpose, so a typo in one is a refusal that names the missing key rather
 * than a 500 on the first upload.
 *
 * The result is what you hand to whatever assembles your `UploadStore`.
 * `undefined` means this deployment stores no uploads, and the store then
 * refuses every write with `UploadsUnavailableError` — which is the 501 below.
 */
export function uploadBlobsFor(env: Record<string, string | undefined>): UploadBlobs | undefined {
  const url = env[UPLOAD_STORAGE_URL_ENV]?.trim();
  const serviceKey = env[UPLOAD_STORAGE_KEY_ENV]?.trim();
  const bucket = env[UPLOAD_STORAGE_BUCKET_ENV]?.trim();
  if (url && serviceKey && bucket) return createHttpUploadBlobs({ url, serviceKey, bucket });
  // Local development only. These bytes live in this process and go away with
  // it, so never let this arm answer for a deployment that serves real runs.
  if (env.NODE_ENV !== "production") return createMemoryUploadBlobs();
  return undefined;
}

/** What one upload route answers. Reshape the bodies; keep the statuses. */
export type UploadRouteResult =
  | { status: 201; json: { id: string; size: number } }
  | { status: 200; type: string; bytes: Uint8Array }
  | { status: 404 | 413 | 501; json: { error: string } };

/**
 * Turn a store refusal into a status, or `undefined` for anything else.
 *
 * Anything this declines is a real fault: re-throw it and let your error
 * handler answer 500. Do not widen this to catch everything.
 */
export function uploadRefusal(err: unknown): UploadRouteResult | undefined {
  // The caller's fault: they sent more than MAX_UPLOAD_BYTES.
  if (err instanceof UploadTooLargeError) return { status: 413, json: { error: err.message } };
  // The operator's fault: no byte backend is configured. The message names the
  // missing configuration, so pass it through rather than replacing it.
  if (err instanceof UploadsUnavailableError) return { status: 501, json: { error: err.message } };
  return undefined;
}

/**
 * The receive route: store one file, streaming it in.
 *
 * The cap is enforced as the stream RUNS, so an oversized body is never held
 * whole — and the refusal can therefore arrive after part of the file has
 * already been written. Send the response, do not try to unwind.
 */
export async function receiveUpload(
  store: UploadStore,
  meta: UploadMeta,
  body: AsyncIterable<Uint8Array>,
): Promise<UploadRouteResult> {
  try {
    const info = await store.create(meta, body, { limit: MAX_UPLOAD_BYTES });
    return { status: 201, json: { id: info.id, size: info.size } };
  } catch (err: unknown) {
    const refusal = uploadRefusal(err);
    if (refusal) return refusal;
    throw err;
  }
}

/**
 * The serve route: read a window back out, clamped to what is actually stored.
 *
 * Clamp against `info.size` and nothing else — it is the contiguous prefix, so
 * it is exactly how far the bytes can be read. `undefined` from `info` is a 404,
 * which for a whole-file write also covers "not finished yet": an upload does
 * not exist until its last byte is stored.
 */
export async function serveUpload(
  store: UploadStore,
  id: string,
  start: number,
  end: number,
): Promise<UploadRouteResult> {
  try {
    const info = await store.info(id);
    if (!info) return { status: 404, json: { error: `no such upload: ${id}` } };
    const stop = Math.min(end, info.size);
    const from = Math.max(0, Math.min(start, stop));
    const bytes = stop > from ? await store.read(id, from, stop) : new Uint8Array(0);
    return { status: 200, type: info.type, bytes };
  } catch (err: unknown) {
    const refusal = uploadRefusal(err);
    if (refusal) return refusal;
    throw err;
  }
}

/**
 * Wire the pair into your router.
 *
 * ← your framework. The point of the shape is that both routes go through
 * {@link uploadRefusal}, including the read: `store.info` is exactly the call a
 * person reaches for to ask why the writes are failing, so leaving it outside
 * the `try` is how an unconfigured deployment answers 500 to the one request
 * that would have explained itself.
 *
 * Uploads that go straight to the bucket are a separate arm of the store
 * (`beginParts` / `writePart` / `recordParts`); add those routes here if your
 * clients need them, on the same refusal mapping.
 */
export function uploadRoutes(store: UploadStore): {
  receive: (meta: UploadMeta, body: AsyncIterable<Uint8Array>) => Promise<UploadRouteResult>;
  serve: (id: string, start: number, end: number) => Promise<UploadRouteResult>;
} {
  return {
    receive: (meta, body) => receiveUpload(store, meta, body),
    serve: (id, start, end) => serveUpload(store, id, start, end),
  };
}
