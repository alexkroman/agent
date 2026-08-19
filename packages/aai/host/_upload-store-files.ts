// Copyright 2026 the AAI authors. MIT license.
/**
 * The file upload backend: one file of bytes, one of metadata, beside the Local
 * World's own state.
 */

import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertUploadToken, type UploadInfo } from "../sdk/step-uploads.ts";
import { ensureOnce } from "./_ensure-once.ts";
import { chunked, newUploadId, UploadIdTakenError, type UploadStore } from "./_upload-store.ts";
export function createFileUploadStore(dir: string, maxBytes: number): UploadStore {
  const ensureDir = ensureOnce(async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  });
  const bytesPath = (id: string): string => join(dir, `${id}.bin`);
  const metaPath = (id: string): string => join(dir, `${id}.json`);

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

    async info(id): Promise<UploadInfo | undefined> {
      try {
        const stored = JSON.parse(await readFile(metaPath(id), "utf-8")) as UploadInfo;
        // A sidecar written before `complete` existed describes a finished upload,
        // because that is the only kind `create` produced — same reasoning as the
        // Postgres column's `default true`.
        return { ...stored, complete: stored.complete !== false };
      } catch {
        // A missing (or half-written) sidecar IS "no such upload" — the same
        // answer the Postgres backend gives for a missing row.
        return undefined;
      }
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
