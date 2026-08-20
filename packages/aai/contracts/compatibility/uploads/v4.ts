// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:uploads` epoch 4.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are relative.
 *
 * What epoch 4 added is the store's OTHER DIRECTION: `writeUpload`. Every epoch
 * before it describes a file a person sent IN, and the rule that made uploads
 * necessary — a run's input is journaled and replayed, so bytes may not travel
 * in one — applies just as hard to a run's OUTPUT, which is read back as JSON.
 * So a step that produces a file stores it here and returns the ID.
 *
 * The `"use step"` directives are inert here — nothing compiles this through the
 * Workflow DevKit's builder — which is the point: what is frozen is the way an author
 * WRITES against the store, and the only thing this must keep doing is compile.
 */

import {
  readUpload,
  type UploadInfo,
  uploadInfo,
  type WriteUploadOptions,
  writeUpload,
} from "../../../sdk/utils.ts";

/** What a step reports for a file it made: the handle, never the bytes. */
export type Produced = {
  /** The id a caller reads back with `api.download(id)`. */
  id: string;
  /** How big it turned out, from the record the store answered with. */
  size: number;
};

/**
 * Store a file this step produced.
 *
 * The whole shape epoch 4 introduced: bytes in, a RECORD out, and what crosses
 * the queue to the next step is the id — a step is journaled by its return
 * value, so an id is replayed and bytes are not.
 */
export async function store(bytes: Uint8Array, opts: WriteUploadOptions): Promise<Produced> {
  "use step";

  const record: UploadInfo = await writeUpload(bytes, opts);
  return { id: record.id, size: record.size };
}

/**
 * The same write from a producer that must not be held whole.
 *
 * A list and an async iterable are both accepted, which is what lets a step
 * concatenate many utterances — or stream a large result — without ever
 * materializing the file.
 */
export async function storeStreamed(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  "use step";

  const record = await writeUpload(chunks, {
    name: "output.bin",
    type: "application/octet-stream",
  });
  return record.id;
}

/** What was written is an ordinary upload, so every reader from epoch 1 works on it. */
export async function verify(id: string): Promise<boolean> {
  "use step";

  const info = await uploadInfo(id);
  const head = await readUpload(id, { end: 4 });
  return info.complete && head.bytes.length <= 4;
}
