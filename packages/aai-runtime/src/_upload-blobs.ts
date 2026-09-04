// Copyright 2026 the AAI authors. MIT license.
/**
 * Where an upload's BYTES live, as the store addresses them.
 *
 * The store used to hold the bytes itself — a `bytea` row per megabyte in the
 * app's own database, or a file per upload under `aai dev`. Both are gone. Bytes
 * are objects in the platform's private bucket now, and this is the two-method
 * surface the store reaches them through.
 *
 * ## Why the bytes left the database
 *
 * Postgres charged for them four ways, and only the last one is a tuning problem:
 *
 * - **Cost.** Supabase database disk is $0.125/GB-month against $0.0213 for file
 *   storage — 6x, on the largest objects in the system by orders of magnitude.
 * - **Write amplification.** Every byte went to the WAL *and* the heap, then into
 *   every base backup and the whole PITR window. A 2 GiB recording was well over
 *   4 GiB of durable writes and permanently inflated backups.
 * - **The pool.** Upload bytes flowed through the same connection pool as the
 *   app's own queries: measured in production, every non-upload request on a guest
 *   ran at p50 1.34s while a part was in flight against 0.43s when none was.
 * - **The forward.** Bytes crossed the platform to reach the guest, and the
 *   forward measures that drain to decide whether a guest is alive — so an upload
 *   that was storing perfectly well looked like a stall and was aborted.
 *
 * The last two are not fixed by writing to Postgres faster. They are fixed by the
 * bytes not going that way, which is what this interface is for: a part goes from
 * the BROWSER to the bucket, and the guest is told about it afterwards.
 *
 * ## One object per WINDOW, and the store records the boundaries
 *
 * A part is one object, keyed by the byte it starts at. Nothing concatenates them
 * and no upload has a single whole-file object — `create` and `stream` cut their
 * body into windows as it streams, so there is exactly ONE byte layout whatever
 * route an upload arrived by, and {@link stepReadUpload} maps a window onto objects
 * the same way in every case. The alternative (one object for a whole-file write,
 * N for a parts upload) is two layouts and a reader that has to ask which.
 *
 * That is also why the record keeps the raw part boundaries rather than only the
 * merged {@link UploadInfo.ranges}: merging joins two adjacent parts into one
 * range, which is the right answer for a resume and loses exactly the information
 * a READ needs — which object holds a given byte.
 *
 * ## Signing is NOT here
 *
 * No method mints a URL. The guest runs tenant code and the bucket is
 * platform-wide, so the guest must never hold the credential that could sign for
 * another app's keys — and an interface with a `sign` method is one an
 * implementation is expected to have that capability for.
 *
 * So there are two implementations and the SPLIT is the security boundary:
 *
 * - **`_upload-blobs-brokered.ts`** is what a deployed guest gets. Every operation
 *   is one request to the agent's own public platform surface, which holds the
 *   credential — the guest carries no key and could not name another app's prefix
 *   if it tried, because the prefix is the slug in the URL it was given.
 * - **`_upload-blobs-http.ts`** talks to a bucket directly with a service key, for
 *   `aai dev` and a self-hosted server. There the operator and the agent author are
 *   the same person and the bucket is theirs, so there is no boundary to cross.
 *
 * `createMemoryUploadBlobs` is the third, for specs.
 */

import { isRecord, safeJsonParse } from "@alexkroman1/aai/utils";
import { collectCapped } from "./_upload-byte-util.ts";
import type { ByteRange } from "./_upload-store.ts";

/** One window of an upload, and the object holding it. */
export type UploadPart = {
  /** The byte this window starts at, which is also the object's key suffix. */
  at: number;
  /** How many bytes the object holds. */
  bytes: number;
};

/**
 * The byte operations the upload store performs, and only those.
 *
 * Deliberately not a general blob store: no listing, no copy, no metadata beyond
 * a length. `aai-server`'s `BlobStorage` made the same choice for deploy blobs and
 * its doc states the rule — anything wanting more should ask whether it really
 * wants a Postgres row.
 */
export type UploadBlobs = {
  /**
   * Write one object from a stream, answering how many bytes it holds.
   *
   * Replaces whatever is at `key`. A part is RETRIED whenever a connection dies
   * mid-flight — the ordinary failure of the thing parts exist for — so a repeat
   * has to be the same object rather than a second one, and the offset in the key
   * is what makes that true by construction.
   *
   * @throws {UploadTooLargeError} once more than `limit` bytes have arrived, so an
   *   oversized body is refused as it streams rather than buffered and measured.
   */
  put(
    key: string,
    body: AsyncIterable<Uint8Array>,
    opts?: { type?: string | undefined; limit?: number | undefined },
  ): Promise<number>;
  /**
   * Read `[start, end)` of one object.
   *
   * A window rather than the whole object, because the reader is a fan-out: sixty
   * steps each want their own slice, and a header probe wants 64 KB of an 8 MiB
   * part. Answers SHORT rather than throwing when the object holds less than was
   * asked for — the same clamp `stepReadUpload` has always applied, which is what lets
   * a plan computed from a header end one byte past the file.
   */
  read(key: string, start: number, end: number): Promise<Uint8Array>;
  /**
   * How many bytes the object holds, or `undefined` when there is no such object.
   *
   * This is what makes a part's arrival a FACT rather than a claim. The bytes go
   * from the browser to the bucket without passing through the guest, so the guest
   * learns a part landed by being told — and a client that is buggy or hostile
   * could say so about a part that is not there. `size` never over-reports what is
   * in the bucket, so verifying against it before recording the range is what
   * stops a hole becoming a readable byte. Skipping it would put silence in a
   * transcript with nothing anywhere reporting an error.
   */
  size(key: string): Promise<number | undefined>;
};

/**
 * An in-memory {@link UploadBlobs}, for specs and for a platform with no bucket.
 *
 * A valid double for the real one because the CONTRACT here is small and entirely
 * about bytes: a window read, a length, an idempotent write. What it cannot stand
 * in for is durability, which is why nothing ships it as a deployment's answer —
 * `aai dev` resolves a real bucket or refuses uploads by name.
 */
export function createMemoryUploadBlobs(): UploadBlobs {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(key, body, opts): Promise<number> {
      const bytes = await collectCapped(body, opts?.limit);
      objects.set(key, bytes);
      return bytes.length;
    },
    async read(key, start, end): Promise<Uint8Array> {
      const held = objects.get(key);
      if (!held) return new Uint8Array(0);
      // Clamped rather than refused — see `UploadBlobs.read`.
      return held.subarray(Math.max(0, start), Math.min(end, held.length));
    },
    async size(key): Promise<number | undefined> {
      return objects.get(key)?.length;
    },
  };
}

/**
 * A stored boundary list, whatever the driver handed back.
 *
 * **Accepting BOTH a string and an array is load-bearing, and it was learned twice
 * against a real database in one afternoon.** Measured on Postgres 16 with
 * postgres.js:
 *
 * ```text
 * $2::jsonb        → jsonb_typeof = string  ← the column holds JSON inside a JSON string
 * $2::text::jsonb  → jsonb_typeof = array
 * ```
 *
 * The first is what this store did, and the missing `::text` is not a read problem —
 * it is DATA CORRUPTION. `JSON.stringify(parts)` reaches postgres.js as a JSON
 * parameter, so `::jsonb` stores the *string* `"[{\"at\":0,…}]"` rather than the
 * array. Everything downstream that treats the column as a list — an operator's query,
 * a `jsonb_array_elements`, an index — sees a scalar. The write is `::text::jsonb` now,
 * which is the same shape `session-state-postgres.ts` uses for its own `jsonb` column.
 *
 * The read then gets a real array (postgres.js parses `jsonb`), and the first attempt
 * at fixing this reached for `parts::text as parts` instead — on the theory that the
 * driver hands back a string — which was true only BECAUSE of the corrupt write, and
 * which double-encoded the correct one. So the shape a driver returns is exactly the
 * thing not to have an opinion about: `partsOf` takes either and the store stops
 * caring, which is what makes the next change to the query safe.
 *
 * It also VALIDATES, which would be reason enough on its own: the row lives in the
 * tenant's own database on the tenant's own role, so `parts` is a value they can write
 * anything into. An entry that is not two byte counts is DROPPED rather than trusted —
 * a `NaN` offset would make `contiguousBytes` answer nonsense and a negative one would
 * have a read ask for a window before the file starts.
 */
export function partsOf(value: unknown): UploadPart[] {
  const raw = typeof value === "string" ? safeJsonParse(value) : value;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPart);
}

/** Whether one entry really describes a window. */
function isPart(value: unknown): value is UploadPart {
  if (!isRecord(value)) return false;
  const { at, bytes } = value;
  return (
    typeof at === "number" &&
    typeof bytes === "number" &&
    Number.isSafeInteger(at) &&
    Number.isSafeInteger(bytes) &&
    at >= 0 &&
    bytes >= 0
  );
}

/** Where one upload's objects live, under a prefix the deployment owns. */
export function partKey(prefix: string, id: string, at: number): string {
  return `${prefix}/${id}/${at}`;
}

/** The objects a window overlaps, in read order, with the slice wanted from each. */
export function partsCovering(
  parts: readonly UploadPart[],
  start: number,
  end: number,
): { part: UploadPart; from: number; to: number }[] {
  return parts
    .filter((part) => part.at < end && part.at + part.bytes > start)
    .toSorted((a, b) => a.at - b.at)
    .map((part) => ({
      part,
      from: Math.max(start - part.at, 0),
      to: Math.min(end - part.at, part.bytes),
    }));
}

/** The merged windows a part list covers — {@link UploadInfo.ranges}'s value. */
export function rangesOf(parts: readonly UploadPart[]): ByteRange[] {
  const merged: ByteRange[] = [];
  for (const part of parts.toSorted((a, b) => a.at - b.at)) {
    const last = merged.at(-1);
    if (last && part.at <= last.end) last.end = Math.max(last.end, part.at + part.bytes);
    else merged.push({ start: part.at, end: part.at + part.bytes });
  }
  return merged;
}

/**
 * Headers that ask for the response EXACTLY as stored.
 *
 * A `HEAD` here carries one number and carries it in `Content-Length`, which is a
 * header any hop is free to rewrite — and one did. Node's `fetch` advertises `zstd`
 * (Node 22.15+), Modal's proxy honoured it on a body-less 200, and a
 * `content-encoding: zstd` response has no `Content-Length` at all: measured
 * against a deployed agent, `identity`, `gzip` and `gzip, deflate, br` all answered
 * `content-length: 8388608` where `zstd` answered nothing. So the request opts out
 * of encoding rather than trusting every future proxy not to apply one.
 *
 * `contentLength` below is what makes the loss SAFE; this is what makes it rare.
 */
export const IDENTITY_ENCODING: Readonly<Record<string, string>> = {
  "Accept-Encoding": "identity",
};

/**
 * `Content-Length` as a byte count, or `undefined` when the response did not state
 * one — which is NOT the same as zero, and conflating them corrupted every upload
 * on the platform.
 *
 * `res.headers.get()` answers `null` for an absent header and `Number(null)` is
 * **0**, a perfectly safe non-negative integer — so the obvious
 * `Number.isSafeInteger(length) && length >= 0` guard, written in both blob
 * implementations under a comment promising that an unmeasurable answer reads as
 * absent, returned `0` for the one case that comment was about.
 *
 * What that cost: `UploadStore.recordParts` asks this before recording a window, and
 * `undefined` is the answer it refuses on. `0` it accepts — so every part of every
 * parts upload was recorded as a ZERO-LENGTH window, the contiguous prefix never
 * advanced past byte 0, and the record stayed `size: 0, complete: false` while the
 * bytes sat correctly in the bucket. A run then read nothing: the transcription
 * desk's header probe came back empty and reported "That is not a WAV file", and
 * its streaming flow never reached the 64 KB it plans from, so the page showed an
 * empty progress panel for the whole upload. The single-request path was unaffected
 * because it counts bytes as they stream through and never asks a bucket.
 *
 * So the missing header is read as missing, and the caller's refusal does its job.
 */
export function contentLength(res: Response): number | undefined {
  const header = res.headers.get("content-length");
  // The absent case FIRST — see the doc. Everything below is about a header that
  // is present and might still be nonsense.
  if (header === null) return undefined;
  const length = Number(header);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}
