// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepWriteUpload()` — storing a file a step PRODUCED.
 *
 * The write half of `step-uploads.ts`, split out because that module reached
 * the 500-line cap and this is the seam a split falls on: everything there is
 * about READING a file somebody sent in, and everything here is the other
 * direction. The slot, the store contract and the invariants are all next door;
 * this module is one function and the shape it accepts.
 *
 * @module step-uploads-write
 */

import { requireUploadAccess, type UploadInfo } from "./step-uploads.ts";

/**
 * Options for {@link stepWriteUpload}.
 *
 * @public
 */
export type WriteUploadOptions = {
  /**
   * Filename to store, e.g. `"summary.wav"`.
   *
   * Worth passing even though nothing reads it: it is what
   * {@link UploadInfo.name} answers, so it is the name a page puts on a
   * download link and the string a person sees instead of an opaque id.
   */
  name?: string | undefined;
  /**
   * MIME type to store, e.g. `"audio/wav"`.
   *
   * This one IS read — the byte route serves it as `Content-Type`, so a
   * browser given an upload with none downloads a file it will not play
   * inline. There is no sniffing anywhere in the store, by design.
   */
  type?: string | undefined;
};

/**
 * Store a file a step PRODUCED, and answer with the record naming it.
 *
 * The other direction of {@link stepReadUpload}, and the half a workflow app needs
 * the moment its output is not text. A run's output is journaled and read back
 * as JSON, so audio, an image or a PDF cannot travel in one — the same rule
 * that keeps a recording's bytes out of a run's INPUT, arriving at the other
 * end of the run. So the bytes go to the store and the output carries the id,
 * which a page turns back into a file with `api.download(id)`.
 *
 * ```ts
 * import { stepSpeak, stepWriteUpload } from "@alexkroman1/aai/step";
 *
 * export async function narrate(summary: string) {
 *   const spoken = await stepSpeak(summary);
 *   const stored = await stepWriteUpload(spoken.audio, { name: "summary.wav", type: "audio/wav" });
 *   return { audio: stored.id, durationMs: spoken.durationMs };
 * }
 * ```
 *
 * **Write it in the step that MAKES it, and return the id.** A step is
 * journaled by what it returns, so an id is replayed and bytes are not: a
 * resumed run re-reads the same file rather than re-synthesizing it. The
 * corollary is that a RETRIED step writes a second upload and abandons the
 * first, which is the cost of the store having no way to know two calls meant
 * one file — worth knowing, and cheap next to the alternative of a step that
 * cannot retry at all.
 *
 * @param bytes - The file. A LIST is stored in order and an async iterable is
 *   streamed, so a step producing something large — a long recording, a
 *   concatenation of many utterances — never has to hold it whole.
 * @param opts - What to declare about it. Both fields are stored verbatim and
 *   neither is inferred; see {@link WriteUploadOptions}.
 *
 * @throws when the process published no store, or published a READ-ONLY one —
 *   two different sentences, because the remedies differ and the call site
 *   cannot tell them apart. Also when the deployment has nowhere durable to put
 *   bytes at all, which the store reports by naming the variable that is
 *   missing.
 *
 * @public
 */
export async function stepWriteUpload(
  bytes: Uint8Array | readonly Uint8Array[] | AsyncIterable<Uint8Array>,
  opts: WriteUploadOptions = {},
): Promise<UploadInfo> {
  const { create } = requireUploadAccess();
  if (!create) throw new Error(UPLOAD_WRITES_UNAVAILABLE_MESSAGE);
  return await create({ name: opts.name, type: opts.type }, toChunks(bytes));
}

/**
 * The sentence a step gets when the published store cannot write.
 *
 * Distinct from {@link UPLOADS_UNAVAILABLE_MESSAGE} because the remedy is
 * different and the two are indistinguishable from the call site: nothing
 * published at all is a process serving no agent, and a store without `create`
 * is a stub that was given bytes to read and never asked to keep any.
 *
 * @internal
 */
export const UPLOAD_WRITES_UNAVAILABLE_MESSAGE =
  "The upload store in this process is read-only, so `stepWriteUpload` has nowhere to put the " +
  "bytes. Every deployed agent, every self-hosted server and `aai dev` publish a writable " +
  "store through `createServer`; in a test, pass `{ writable: true }` to `stubUploads` from " +
  "`@alexkroman1/aai/testing`.";

/**
 * Whatever a caller passed, as the chunk stream the store consumes.
 *
 * One shape rather than three branches inside the store: a buffer and a list
 * are both already-in-memory and become a one-shot iterable, and an iterable
 * passes through untouched so a streaming producer is never collected.
 */
async function* toChunks(
  bytes: Uint8Array | readonly Uint8Array[] | AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (bytes instanceof Uint8Array) {
    yield bytes;
    return;
  }
  if (Array.isArray(bytes)) {
    // A zero-length chunk is dropped rather than forwarded: several stores
    // treat one as a window boundary, and a producer that emitted one meant
    // nothing by it.
    for (const chunk of bytes as readonly Uint8Array[]) if (chunk.length > 0) yield chunk;
    return;
  }
  yield* bytes as AsyncIterable<Uint8Array>;
}
