// Copyright 2026 the AAI authors. MIT license.
/**
 * The file upload backend: one file of bytes, one of metadata, beside the Local
 * World's own state.
 */

import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createKeyedLock, withLock } from "../sdk/keyed-lock.ts";
import { assertUploadToken, type UploadInfo } from "../sdk/step-uploads.ts";
import { ensureOnce } from "./_ensure-once.ts";
import {
  assertPartOffset,
  assertPartTotal,
  type ByteRange,
  chunked,
  contiguousBytes,
  mergeRanges,
  newUploadId,
  partChunks,
  UnknownUploadError,
  UploadIdTakenError,
  UploadPartError,
  type UploadStore,
} from "./_upload-store.ts";

/**
 * What the sidecar holds for an upload whose bytes arrive as PARTS.
 *
 * The two extra fields are the ones Postgres keeps in columns and derives in SQL:
 * the declared total, and which windows have landed. They stay OUT of `UploadInfo`
 * — `info` rebuilds the record field by field rather than spreading the file — so
 * an implementation detail of this backend cannot reach an API response and become
 * something a client depends on.
 */
type StoredUpload = UploadInfo & {
  expected?: number;
  ranges?: ByteRange[];
};
export function createFileUploadStore(dir: string, maxBytes: number): UploadStore {
  const ensureDir = ensureOnce(async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  });
  const bytesPath = (id: string): string => join(dir, `${id}.bin`);
  const metaPath = (id: string): string => join(dir, `${id}.json`);
  // Parts land CONCURRENTLY, and each one finishes by reading the sidecar, merging
  // its own window in and writing it back — the read-modify-write that interleaves
  // at every `await` and silently drops a part's arrival. Postgres needs no
  // equivalent because there the ranges are derived from the chunk rows themselves;
  // here the sidecar is the record, so it is serialized per upload.
  const sidecars = createKeyedLock();

  /** The sidecar as stored, or undefined when there is none. */
  async function stored(id: string): Promise<StoredUpload | undefined> {
    try {
      return JSON.parse(await readFile(metaPath(id), "utf-8")) as StoredUpload;
    } catch {
      return undefined;
    }
  }

  return {
    async create(meta, body, options): Promise<UploadInfo> {
      await ensureDir();
      const id = newUploadId();
      const file = await open(bytesPath(id), "w");
      let size = 0;
      try {
        for await (const chunk of chunked(body, options?.limit ?? maxBytes)) {
          await file.write(chunk);
          size += chunk.length;
        }
      } catch (err: unknown) {
        await file.close();
        await rm(bytesPath(id), { force: true });
        throw err;
      }
      await file.close();
      const info: UploadInfo = {
        id,
        name: meta.name ?? "",
        type: meta.type ?? "",
        size,
        complete: true,
      };
      // Written last, for the reason the Postgres backend writes its row last.
      await writeFile(metaPath(id), JSON.stringify(info), "utf-8");
      return info;
    },

    async stream(id, meta, body, options): Promise<UploadInfo> {
      await ensureDir();
      // Validated here as well as at the route: this id becomes a FILENAME, so a
      // token that escaped the check would address a path outside the store.
      assertUploadToken(id);
      // `wx` — exclusive create, so a chosen id that is already taken fails HERE
      // rather than truncating somebody else's upload. That is the whole safety
      // argument for letting a caller pick the id, and it is one flag.
      let file: FileHandle;
      try {
        file = await open(bytesPath(id), "wx");
      } catch (err: unknown) {
        throw new UploadIdTakenError(id, { cause: err });
      }
      const info = (size: number, complete: boolean): UploadInfo => ({
        id,
        name: meta.name ?? "",
        type: meta.type ?? "",
        size,
        complete,
      });
      // The sidecar goes FIRST here, which is the exact opposite of `create` and
      // the point of this method: the record has to exist before the bytes do, so
      // a run can be started on it and read what has arrived.
      await writeFile(metaPath(id), JSON.stringify(info(0, false)), "utf-8");
      let size = 0;
      try {
        for await (const chunk of chunked(body, options?.limit ?? maxBytes)) {
          await file.write(chunk);
          size += chunk.length;
          // Republished per chunk: this is what a polling run reads to learn how
          // far it may go.
          await writeFile(metaPath(id), JSON.stringify(info(size, false)), "utf-8");
        }
      } finally {
        // The handle closes whatever happened. The upload is deliberately NOT
        // removed on failure — it stays incomplete and readable, because a reader
        // may already have used the part that did arrive.
        await file.close();
      }
      const done = info(size, true);
      await writeFile(metaPath(id), JSON.stringify(done), "utf-8");
      return done;
    },

    async beginParts(id, meta, total, options): Promise<UploadInfo> {
      await ensureDir();
      // Validated here as well as at the route, for the reason `stream` is: this id
      // becomes a FILENAME.
      assertUploadToken(id);
      assertPartTotal(total, options?.limit ?? maxBytes);
      // `wx` again, and it is the same safety argument: an id that is already taken
      // fails here rather than truncating somebody else's upload.
      let file: FileHandle;
      try {
        file = await open(bytesPath(id), "wx");
      } catch (err: unknown) {
        throw new UploadIdTakenError(id, { cause: err });
      }
      await file.close();
      const info: UploadInfo = {
        id,
        name: meta.name ?? "",
        type: meta.type ?? "",
        size: 0,
        // An upload of NO bytes is finished the moment it is declared: no part can
        // ever arrive to close it, so anything else is a record that waits forever.
        complete: total === 0,
      };
      await writeFile(
        metaPath(id),
        JSON.stringify({ ...info, expected: total, ranges: [] } satisfies StoredUpload),
        "utf-8",
      );
      return info;
    },

    async writePart(id, offset, body): Promise<UploadInfo> {
      await ensureDir();
      assertPartOffset(offset);
      const begun = await stored(id);
      if (!begun) throw new UnknownUploadError(id);
      const total = begun.expected;
      if (total === undefined) {
        throw new UploadPartError(`Upload ${id} was not begun as a parts upload.`);
      }
      if (offset > total) {
        throw new UploadPartError(`A part at ${offset} starts past this upload's ${total} bytes.`);
      }
      // `r+` — the file exists from `beginParts`, and a part writes INTO it at its
      // own position. Opening it `w` (or `a`) is how a backend that looked right
      // would truncate every other part that had already landed.
      const file = await open(bytesPath(id), "r+");
      let end = offset;
      try {
        for await (const { bytes, at } of partChunks(body, offset, total)) {
          await file.write(bytes, 0, bytes.length, at);
          end = at + bytes.length;
        }
      } finally {
        await file.close();
      }
      // Serialized per upload: see `sidecars`. Re-read INSIDE the lock, because the
      // copy read before the bytes went is stale by exactly the parts that landed
      // while they did.
      return await withLock(sidecars, id, async () => {
        const current = (await stored(id)) ?? begun;
        const ranges = mergeRanges(current.ranges ?? [], { start: offset, end });
        const size = contiguousBytes(ranges);
        const next: StoredUpload = {
          ...current,
          size,
          complete: size >= total,
          expected: total,
          ranges,
        };
        await writeFile(metaPath(id), JSON.stringify(next), "utf-8");
        return { id, name: next.name, type: next.type, size, complete: next.complete };
      });
    },

    async info(id): Promise<UploadInfo | undefined> {
      // A missing (or half-written) sidecar IS "no such upload" — the same answer
      // the Postgres backend gives for a missing row.
      const record = await stored(id);
      if (!record) return undefined;
      return {
        id: record.id,
        name: record.name,
        type: record.type,
        size: record.size,
        // A sidecar written before `complete` existed describes a finished upload,
        // because that is the only kind `create` produced — same reasoning as the
        // Postgres column's `default true`.
        complete: record.complete !== false,
      };
    },

    async read(id, start, end): Promise<Uint8Array> {
      const file = await open(bytesPath(id), "r");
      try {
        const bytes = new Uint8Array(end - start);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
        return bytes.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
    },
  };
}
