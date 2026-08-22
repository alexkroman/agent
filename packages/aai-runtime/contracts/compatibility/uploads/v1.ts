// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:uploads` epoch 1.
 *
 * **"Frozen" means this file must keep compiling against current source for as
 * long as epoch 1 is advertised as supported.** A compile error here is the
 * finding, not something to edit away. Imports are RELATIVE
 * (`../../../runtime-barrel.ts`) because the package cannot resolve itself by
 * name, and `contracts/` is excluded from the declaration emit and from the
 * tarball.
 *
 * The shape a HOST embedding this runtime writes it in: say where an upload's
 * bytes live, hand the store a body as it arrives, read a window back out, and
 * — the part this capability exists to make possible — **tell the two refusals
 * apart**. `UploadTooLargeError` is the CALLER's, and its remedy is a smaller
 * file. `UploadsUnavailableError` is the OPERATOR's, and its whole content is
 * the configuration that is missing. Collapsing them is how a deployment with
 * no bucket answers `Internal server error` on every upload route while the
 * remedy sits in a string nobody ever sees, so an embedder that catches one and
 * not the other has caught the wrong half.
 *
 * What is NOT here, deliberately: the store's own factory. `createUploadStore`
 * and `resolveUploadBlobs` are `@internal`, so an embedder supplies the BLOBS
 * half and RECEIVES an `UploadStore` from whichever server assembled one — which
 * is why every function below takes the store as a parameter rather than
 * building it.
 */

import {
  createHttpUploadBlobs,
  createMemoryUploadBlobs,
  type HttpUploadBlobsOptions,
  partKey,
  partsOf,
  UPLOAD_KEY_PREFIX,
  UPLOAD_STORAGE_BUCKET_ENV,
  UPLOAD_STORAGE_KEY_ENV,
  UPLOAD_STORAGE_URL_ENV,
  UPLOADS_TABLE,
  type UploadBlobs,
  type UploadMeta,
  type UploadPart,
  type UploadStore,
  UploadsUnavailableError,
  UploadTooLargeError,
} from "../../../runtime-barrel.ts";

/**
 * Where a self-hosted deployment's bytes go, read off its own environment.
 *
 * All three variables or none: two of three is a half-configured store, and
 * letting that resolve turns a typo into a 500 on the first upload instead of a
 * refusal that names the key. `undefined` is the honest answer for a deployment
 * that never configured one — the server it is handed to is what decides
 * whether that means "no uploads" or "keep them locally".
 */
export function bucketBlobs(env: Record<string, string | undefined>): UploadBlobs | undefined {
  const url = env[UPLOAD_STORAGE_URL_ENV]?.trim();
  const serviceKey = env[UPLOAD_STORAGE_KEY_ENV]?.trim();
  const bucket = env[UPLOAD_STORAGE_BUCKET_ENV]?.trim();
  if (!(url && serviceKey && bucket)) return undefined;
  const opts: HttpUploadBlobsOptions = { url, serviceKey, bucket };
  return createHttpUploadBlobs(opts);
}

/**
 * The double a spec stands the same store up on.
 *
 * A valid substitute because the contract here is entirely about bytes — a
 * window read, a length, an idempotent write. What it cannot stand in for is
 * durability, which is why it is never a deployment's answer: an upload has to
 * be at least as durable as the runs that read it.
 */
export function specBlobs(): UploadBlobs {
  return createMemoryUploadBlobs();
}

/**
 * What one upload route answers.
 *
 * Three arms rather than "ok or 500", because the status IS the classification:
 * 413 tells a client to send less, and 501 tells it to stop asking. 500, 502,
 * 503 and 504 are all retryable, so answering an unconfigured deployment with
 * one of those spends the client's whole retry budget per part before the
 * message that matters arrives last, looking like a flaky link.
 */
export type UploadOutcome =
  | { status: 201; id: string; size: number }
  | { status: 413; message: string }
  | { status: 501; message: string };

/** Store one file, streaming it in, and classify the two ways that is refused. */
export async function receive(
  store: UploadStore,
  meta: UploadMeta,
  body: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<UploadOutcome> {
  try {
    // The cap is enforced as the stream RUNS, so an oversized body is never
    // held whole — which is also why the failure can arrive after some of the
    // file has already been written.
    const info = await store.create(meta, body, { limit });
    return { status: 201, id: info.id, size: info.size };
  } catch (err: unknown) {
    if (err instanceof UploadTooLargeError) return { status: 413, message: err.message };
    if (err instanceof UploadsUnavailableError) return { status: 501, message: err.message };
    throw err;
  }
}

/**
 * The parts arm, where this process never sees the bytes at all.
 *
 * `beginParts` claims the id and declares the total, so the record exists at
 * `size: 0` before anything is sent; the client then puts each window straight
 * at the bucket and `recordParts` is the bodyless receipt naming the offsets
 * that landed. The store asks the bucket how big each one really is rather than
 * taking the caller's word, which is what stops a claimed part becoming a
 * readable hole.
 *
 * `complete` is the only field to exit on: `size` is the CONTIGUOUS prefix, so
 * parts landing out of order leave it behind what has arrived, and a `size`
 * that stopped growing is what a slow link and a dead client both look like.
 */
export async function recordDirectParts(
  store: UploadStore,
  id: string,
  meta: UploadMeta,
  total: number,
  landed: readonly number[],
): Promise<boolean> {
  await store.beginParts(id, meta, total);
  const info = await store.recordParts(id, landed);
  return info.complete;
}

/**
 * Read a window back out, clamped to what is actually stored.
 *
 * A reader may act on `size` and on nothing else — it is the contiguous prefix,
 * so it is exactly how far the bytes can be read, and a range past it is a hole
 * whatever the record's `ranges` say. `undefined` means there is no such
 * upload, which for a whole-file write is the same answer as "not finished
 * yet": it does not exist until its last byte is stored.
 */
export async function serveRange(
  store: UploadStore,
  id: string,
  start: number,
  end: number,
): Promise<Uint8Array | undefined> {
  const info = await store.info(id);
  if (!info) return undefined;
  const stop = Math.min(end, info.size);
  if (stop <= start) return new Uint8Array(0);
  return await store.read(id, start, stop);
}

/**
 * The one query shape an operator needs against the record table.
 *
 * `UPLOADS_TABLE` is spelled once, here, for the reason every other shared
 * table name in this package is: a second copy is a rename away from a
 * diagnostic that reads a table nothing writes.
 */
export const AUDIT_ROW_SQL = `select id, parts from ${UPLOADS_TABLE} where id = $1`;

/**
 * Name the objects one upload's windows live in.
 *
 * `parts` is a `jsonb` column in the TENANT's own database on the tenant's own
 * role, so it is a value they can write anything into — hence `partsOf` taking
 * `unknown` and DROPPING an entry that is not two byte counts rather than
 * trusting it. It also means this code has no opinion about whether the driver
 * handed back a string or an array, which is the thing not to have an opinion
 * about.
 *
 * The offset IS the object's name, which is why a part may only start on an
 * `UPLOAD_CHUNK_BYTES` boundary: a grid nothing can scatter is what lets a
 * reader derive a key instead of looking one up.
 */
export function objectKeysOf(row: { id: string; parts: unknown }): string[] {
  const parts: UploadPart[] = partsOf(row.parts);
  return parts.map((part) => partKey(UPLOAD_KEY_PREFIX, row.id, part.at));
}
