// Copyright 2026 the AAI authors. MIT license.
/**
 * The LOCAL world's upload home: records as JSON files, bytes as window files,
 * both under the directory the DevKit's local world keeps its run state in.
 *
 * ## This is not the deleted file backend, and the difference is the whole point
 *
 * There used to be a file store and it was removed for a good reason
 * (`_upload-blobs.ts`): it stored a dev upload perfectly well and lost it by the
 * time a resumed run read it, with nothing reporting a thing. That failure was not
 * caused by files. It was caused by a MISMATCH — the runs lived in Postgres and
 * outlived every process, the bytes lived in a directory and did not, and nothing
 * in the system knew the two were supposed to agree.
 *
 * The invariant that was missing is: **an upload must be at least as durable as
 * the runs that read it.** Here it holds by construction rather than by care,
 * because `dir` is the local world's OWN data directory (`workflow-world.ts`), so
 * the record, the bytes and the run are one filesystem lifetime:
 *
 * - In a guest the directory is per-process (`aai-workflow-data-<pid>` under
 *   `tmpdir()`) and the queue is in memory, so all three die with the container.
 * - Under `aai dev` it is the project's `.workflow-data`, so a restart re-enqueues
 *   the runs it finds there AND finds the uploads they read.
 *
 * Which means the case the old backend could not serve — a resumed run reading an
 * upload that is gone — is not reachable from here without deleting the runs too.
 *
 * ## Why a directory and not memory
 *
 * Memory would satisfy the guest arm and break the `aai dev` one, where the local
 * world really does resume runs across restarts. It also caps an upload at
 * whatever the container has left of its heap, against a default limit of 2 GiB
 * (`MAX_WORKFLOW_UPLOAD_BYTES`) — so the honest reading is that a store which
 * cannot stream to disk is not a store, it is a buffer.
 *
 * ## Path safety
 *
 * Every id and every key segment is checked before it reaches `join`. An upload id
 * arrives from a route and reaches a table as a PARAMETER in the Postgres home,
 * which makes it harmless there and a path traversal here; `UPLOAD_TOKEN_RE`
 * (letters, digits, `-`, `_`) is what makes `..` unrepresentable, and
 * {@link safeSegments} is the same check for the key a blob is addressed by.
 *
 * @internal
 */

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertUploadToken } from "@alexkroman1/aai/host-internal";
import { isRecord } from "@alexkroman1/aai/utils";
import { ensureOnce } from "./_ensure-once.ts";
import { partsOf, type UploadBlobs } from "./_upload-blobs.ts";
import { concat } from "./_upload-byte-util.ts";
import type { UploadRecord, UploadRecords } from "./_upload-records.ts";
import { UploadIdTakenError, UploadTooLargeError } from "./_upload-store.ts";

/** Where the records go, under the caller's directory. */
const RECORDS_DIR = "records";
/** Where the window objects go, under the caller's directory. */
const OBJECTS_DIR = "objects";

/**
 * A key's segments, refusing anything that could climb out of `dir`.
 *
 * `.` and `..` are the traversal, and everything outside the id grammar plus `.`
 * is refused with them rather than sanitized: a key this store did not expect is a
 * caller bug, and rewriting it would store the bytes somewhere the next read does
 * not look.
 */
function safeSegments(key: string): string[] {
  const segments = key.split("/");
  for (const segment of segments) {
    if (!/^[A-Za-z0-9_.-]+$/.test(segment) || segment === "." || segment === "..") {
      throw new Error(`Unsafe upload object key ${JSON.stringify(key)}.`);
    }
  }
  return segments;
}

/**
 * A temp path for ONE write attempt, unique to it.
 *
 * Both stores below write to a temp file and rename it over the target, which is
 * what makes a write atomic to every reader and what makes a re-sent part the
 * same object rather than a torn one. That is only true while the temp path
 * belongs to a single writer: both used a fixed `<target>.tmp`, so two writers
 * on one key shared the file, the first rename moved it out from under the rest,
 * and every other writer failed `ENOENT` on its own rename.
 *
 * It is reachable exactly where this store's own doc says a repeat comes from —
 * "a part is re-sent whenever a connection dies mid-flight" — because the retry
 * can land before this process has finished draining the attempt it replaces.
 * Measured against `aai dev`: six concurrent PUTs of one offset answered five
 * 500s, each an `ENOENT` renaming the shared `0.tmp`. The bytes were never
 * corrupted (one writer's window won whole, which is the intended outcome of a
 * repeat); what was wrong was that five legitimate callers were told the server
 * had failed.
 *
 * `randomUUID` rather than a counter, because the writers can be in different
 * processes over the same directory — `aai dev` restarts onto the project's
 * `.workflow-data`, and nothing stops two hosts pointing at one.
 */
function tempPathFor(target: string): string {
  return `${target}.${randomUUID()}.tmp`;
}

/**
 * Records as one JSON file per upload.
 *
 * The claim is `flag: "wx"`, which is an atomic create-if-absent on every
 * platform this runs on — the same guarantee the Postgres home gets from
 * `on conflict (id) do nothing returning id`, and the reason a caller-chosen id
 * cannot be stolen by a second declaration here either.
 *
 * Every other write is temp-then-rename. A record is read while parts are landing
 * (that is what a streamed upload IS), and a reader must never see half a file;
 * the store serializes writes per id with its own keyed lock, so one temp name per
 * id is enough.
 *
 * @internal
 */
export function createFileUploadRecords(opts: { dir: string }): UploadRecords {
  const dir = join(opts.dir, RECORDS_DIR);
  const ensure = ensureOnce(async () => {
    await mkdir(dir, { recursive: true });
  });
  const path = (id: string): string => {
    assertUploadToken(id);
    return join(dir, `${id}.json`);
  };

  /** Overwrite `id`'s record whole, so no read ever sees part of one. */
  async function write(id: string, record: UploadRecord): Promise<void> {
    const target = path(id);
    const temp = tempPathFor(target);
    await writeFile(temp, JSON.stringify(record), "utf-8");
    await rename(temp, target);
  }

  /** The record under `id`, or `undefined` when there is no usable file for it. */
  async function read(id: string): Promise<UploadRecord | undefined> {
    const raw = await readFile(path(id), "utf-8").catch(() => undefined);
    return raw === undefined ? undefined : parseRecord(raw);
  }

  return {
    ensure,
    read,

    async claim(id, record): Promise<void> {
      await writeFile(path(id), JSON.stringify(record), { encoding: "utf-8", flag: "wx" }).catch(
        (err: unknown) => {
          if (isRecord(err) && err.code === "EEXIST") throw new UploadIdTakenError(id);
          throw err;
        },
      );
    },

    async insert(id, record): Promise<void> {
      await write(id, record);
    },

    async update(id, state): Promise<void> {
      const held = await read(id);
      // Absent means the record was deleted under us, which in this home means the
      // directory went — a no-op is then the truthful answer, and the store's own
      // read is what reports `UnknownUploadError` to the caller.
      if (!held) return;
      await write(id, { ...held, ...state });
    },

    async finish(id, size): Promise<void> {
      const held = await read(id);
      if (!held) return;
      await write(id, { ...held, size, complete: true });
    },
  };
}

/**
 * One record out of its file, or `undefined` for anything unreadable.
 *
 * VALIDATED rather than cast, for the same reason `partsOf` is: this file is
 * written by us but read after a restart, so a half-written or hand-edited one is
 * representable — and a `NaN` size would make `contiguousBytes` answer nonsense.
 * An unusable file reads as "no such upload", which is the answer the store
 * already knows how to report.
 */
function parseRecord(raw: string): UploadRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const size = Number(value.size);
  if (!Number.isFinite(size) || size < 0) return undefined;
  const expected = Number(value.expected);
  return {
    name: typeof value.name === "string" ? value.name : "",
    type: typeof value.type === "string" ? value.type : "",
    size,
    complete: value.complete !== false,
    ...(value.expected === undefined || !Number.isFinite(expected) ? {} : { expected }),
    parts: partsOf(value.parts),
  };
}

/**
 * Bytes as one file per window, keyed exactly as the bucket keys them.
 *
 * The key layout is `partKey`'s — `<prefix>/<id>/<offset>` — so the store maps a
 * window onto objects identically in both homes and nothing above this line knows
 * which one it has.
 *
 * `put` streams to disk through a temp file and renames, which is what makes a
 * retried part the SAME object rather than a torn one: a part is re-sent whenever
 * a connection dies mid-flight, and the offset in the key is what makes the repeat
 * addressable.
 *
 * @internal
 */
export function createFileUploadBlobs(opts: { dir: string }): UploadBlobs {
  const root = join(opts.dir, OBJECTS_DIR);
  const pathOf = (key: string): string => join(root, ...safeSegments(key));

  return {
    async put(key, body, options): Promise<number> {
      const target = pathOf(key);
      await mkdir(dirname(target), { recursive: true });
      const temp = tempPathFor(target);
      let size = 0;
      const handle = await open(temp, "w");
      try {
        // Counted as it arrives rather than from a declared length, the same rule
        // `chunked` follows: a client controls that header independently of what it
        // really sends. Refused AS IT STREAMS, so an oversized body is not written
        // whole and then measured.
        await pipeline(
          body,
          new Writable({
            write(piece: Uint8Array, _encoding, done): void {
              size += piece.length;
              if (options?.limit !== undefined && size > options.limit) {
                done(new UploadTooLargeError(options.limit));
                return;
              }
              handle.write(piece).then(() => done(), done);
            },
          }),
        );
      } finally {
        await handle.close();
      }
      await rename(temp, target);
      return size;
    },

    async read(key, start, end): Promise<Uint8Array> {
      const from = Math.max(0, start);
      if (end <= from) return new Uint8Array(0);
      const pieces: Uint8Array[] = [];
      let held = 0;
      // A stream rather than one `read` into a buffer sized from the request: `end`
      // is a plan computed from a header and may sit past the file, which is
      // legitimate (see `UploadBlobs.read`) — and a 2 GiB allocation for a window
      // nobody stored is not.
      try {
        for await (const piece of createReadStream(pathOf(key), { start: from, end: end - 1 })) {
          const bytes = piece as Uint8Array;
          pieces.push(bytes);
          held += bytes.length;
        }
      } catch (err: unknown) {
        // No such object is SHORT, never an error — the same clamp the bucket
        // implementations apply, and what lets a plan end one byte past the file.
        if (!(isRecord(err) && err.code === "ENOENT")) throw err;
      }
      return concat(pieces, held);
    },

    async size(key): Promise<number | undefined> {
      const stats = await stat(pathOf(key)).catch(() => undefined);
      return stats?.isFile() === true ? stats.size : undefined;
    },
  };
}
