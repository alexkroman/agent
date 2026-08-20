// Copyright 2026 the AAI authors. MIT license.
/**
 * `stubUploads` — the upload store a spec publishes so a `"use step"` body that
 * reads or writes a file is testable without a server.
 *
 * Its own module beside `testing-gateway.ts`, `testing-generate.ts` and
 * `testing-speech.ts`, and for the same reason each of those has one: a fake
 * plus the shape of what it holds, with `testing.ts` as the assembly point.
 * The split also kept that module inside the 500-line cap once the store grew
 * a write half.
 *
 * @module testing-uploads
 */

import { publishUploadReader } from "./step-uploads.ts";

/**
 * One file a {@link stubUploads} store answers for.
 *
 * A bare `Uint8Array` is the common case and means "these bytes, no name".
 *
 * @public
 */
export type StubUpload =
  | Uint8Array
  | {
      bytes: Uint8Array;
      name?: string;
      type?: string;
      /**
       * Whether every byte is in. Defaults to `true`.
       *
       * `false` stages a STREAMED upload that is still arriving, which is the state
       * a step polling one has to handle and the only one where `readUpload`
       * legitimately comes back short. Being able to write that down is most of why
       * this field exists: a body that treats a stalled size as the end returns a
       * transcript of most of a recording and reports success, and a spec cannot
       * catch that without an incomplete upload to hand it.
       */
      complete?: boolean;
    };

/**
 * What {@link stubUploads} may be told beyond the files themselves.
 *
 * @public
 */
export type StubUploadsOptions = {
  /**
   * Accept WRITES, so a step calling `writeUpload` can be tested.
   *
   * Off by default, and deliberately: a store that silently accepts writes it
   * was not asked for cannot fail a spec whose step wrote a file nobody meant
   * it to, and `writeUpload` naming a read-only store is a better failure than
   * an upload appearing from nowhere. What a step writes is readable through
   * `readUpload`/`uploadInfo` on the id it was given, like any other upload.
   */
  writable?: boolean | undefined;
  /**
   * Prefix for the ids writes are given. Defaults to `"upl_stub_"`, with a
   * 1-based counter after it — `upl_stub_1`, `upl_stub_2` — so the id a step
   * returned is a value a spec can assert on rather than a fresh UUID.
   */
  idPrefix?: string | undefined;
};

/**
 * Publish an in-memory upload store, so a `"use step"` function that calls
 * `readUpload` can be tested without a server.
 *
 * A step reads uploads through a process-wide slot rather than dialling
 * anything (see `sdk/step-uploads.ts`), which is what makes this possible at
 * all: a spec supplies its own bytes and the step under test is unchanged.
 *
 * Returns the UNPUBLISH function, and calling it in an `afterEach` is not
 * optional — a store left published makes the next file's steps read this
 * one's bytes, which is the kind of cross-file leak that presents as a passing
 * test somewhere else.
 *
 * @example
 * ```ts
 * import { stubUploads } from "@alexkroman1/aai/testing";
 *
 * const restore = stubUploads({ upl_1: new Uint8Array([1, 2, 3]) });
 * // … call the step …
 * restore();
 *
 * // A streamed upload mid-flight: `readUpload` comes back short and
 * // `uploadInfo(...).complete` is false, which is what a polling body sees.
 * const firstHalf = new Uint8Array([1, 2]);
 * stubUploads({ upl_2: { bytes: firstHalf, complete: false } });
 * ```
 *
 * @param files - Keyed by upload id — the same string a run input would carry.
 * @public
 */
export function stubUploads(
  files: Readonly<Record<string, StubUpload>>,
  options: StubUploadsOptions = {},
): () => void {
  const stored = new Map<
    string,
    { bytes: Uint8Array; name?: string; type?: string; complete?: boolean }
  >(
    Object.entries(files).map(([id, file]) => [
      id,
      file instanceof Uint8Array ? { bytes: file } : file,
    ]),
  );
  // Minted rather than random, so a spec can assert on the id a step returned
  // — which is exactly what a run whose output names a file has to be checked
  // for, and `crypto.randomUUID()` would make unassertable.
  let minted = 0;
  const create = async (
    meta: { name?: string | undefined; type?: string | undefined },
    body: AsyncIterable<Uint8Array>,
  ) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of body) {
      chunks.push(chunk);
      size += chunk.length;
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    minted += 1;
    const id = `${options.idPrefix ?? "upl_stub_"}${minted}`;
    stored.set(id, { bytes, name: meta.name ?? "", type: meta.type ?? "" });
    return { id, name: meta.name ?? "", type: meta.type ?? "", size, complete: true };
  };
  publishUploadReader({
    ...(options.writable === true ? { create } : {}),
    info: (id) => {
      const file = stored.get(id);
      return Promise.resolve(
        file
          ? {
              id,
              name: file.name ?? "",
              type: file.type ?? "",
              size: file.bytes.length,
              complete: file.complete !== false,
            }
          : undefined,
      );
    },
    read: (id, start, end) =>
      Promise.resolve(stored.get(id)?.bytes.subarray(start, end) ?? new Uint8Array(0)),
  });
  return () => publishUploadReader(undefined);
}
