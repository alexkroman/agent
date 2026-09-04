// Copyright 2026 the AAI authors. MIT license.
/**
 * The upload store's CONTRACT: its types, its invariants, and the helpers the
 * store and its byte backend share.
 *
 * Split from `workflow-uploads.ts` because that module builds the store and the
 * store needs these names — an import cycle, and biome says so.
 *
 * ORIGINAL CONTEXT — where an uploaded file lives between the form that sent it and
 * the step that reads it.
 *
 * The problem it solves is the one `MAX_WORKFLOW_INPUT_BYTES` states: a run's
 * input is journaled and replayed on every resume, so bytes may not travel in
 * it. Before this the only answer was "put the file somewhere else and pass a
 * URL", which is fine for a recording that is already hosted and useless for a
 * person with a file on their laptop — the case every transcription and document
 * app opens on. So the app gets a place of its own.
 *
 * ## ONE store, and the bytes are OBJECTS
 *
 * There used to be two backends holding the bytes themselves — a `bytea` row per
 * megabyte in the app's own database, or a file per upload under `aai dev` — and
 * both are gone. There is one store (`_upload-store-blobs.ts`): a metadata row in
 * the app's database, and the bytes as objects in a bucket
 * (`_upload-blobs.ts`, which carries why they left Postgres and why the interface
 * mints no URLs).
 *
 * The old shape's whole argument was that the file backend was "a valid double for
 * the Postgres one", which is what two implementations of one contract buy — and it
 * was the wrong axis. What a double has to stand in for here is BYTES, not records:
 * every rule below is about the record, and the record is Postgres either way. So
 * the seam moved one level down, to {@link UploadBlobs}, whose contract is a window
 * read and a length and is small enough that `createMemoryUploadBlobs` really is
 * equivalent.
 *
 * ## Bytes are stored in WINDOWS, and read one window at a time
 *
 * A recording is not a value: a two-hour WAV is a couple of hundred megabytes,
 * and both halves of the naive shape — buffer it to store it, read it whole to
 * inspect 64 KB of header — are the memory this process does not have. So the body
 * streams into `UPLOAD_PART_BYTES` objects as it arrives, and a range read touches
 * only the objects the window overlaps. A header probe therefore moves 64 KB, not
 * the file.
 *
 * ## The metadata row is written LAST — for an ordinary upload
 *
 * There is no transaction spanning a multi-megabyte stream and a bucket, so "does
 * this upload exist" has to be answerable by one row that only appears when the
 * bytes are all in. An interrupted upload leaves orphan objects and no upload —
 * which reads correctly to every caller as "there is no such upload", rather than
 * as a file that is silently short.
 *
 * ## A STREAMED upload is the deliberate exception, and `complete` is the price
 *
 * `create` cannot serve a run that wants to start before the bytes are in: it
 * mints the id at the END, and there is nothing to put in the run input. `stream`
 * is the other shape — the CALLER names the id, the record appears at the first
 * byte, and its `size` grows as windows land.
 *
 * That is a real relaxation of the invariant above, so it is paid for explicitly
 * rather than quietly:
 *
 * - **The record carries `complete`.** For a streamed upload it is `false` until
 *   the last byte is stored; for a `create`d one it is `true` from the moment the
 *   record exists, because that is when the upload starts existing. So the two
 *   kinds are distinguishable by every reader, and a reader that does not care
 *   (the byte range routes, `stepReadUpload`) needs no change.
 * - **A short read is the honest answer, not an error.** `stepReadUpload` clamps its
 *   window to `size`, which for an in-flight upload is what has arrived. That
 *   behaviour predates streaming — it exists so a plan computed from a header can
 *   end one byte past the file — and it is exactly what a run reading ahead of the
 *   uplink needs.
 * - **An interrupted stream leaves an INCOMPLETE upload rather than none.** That
 *   is the part the old invariant was protecting against, and here it is the
 *   correct outcome: a run may already have transcribed the first half, and
 *   deleting it would throw that away. `complete` never becomes true, so nothing
 *   can mistake it for the whole file, and the caller's own abandonment bound is
 *   what ends the wait.
 * - **A chosen id may not collide.** `stream` refuses an id that already exists,
 *   so a second PUT cannot append to somebody else's upload.
 *
 * ## PARTS are the third write, and the one a browser gets its speed from
 *
 * `create` and `stream` are both ONE request carrying the whole file, so an upload
 * is exactly as fast as a single TCP connection to the agent — which on a link with
 * any real latency is a fraction of what the link can carry. {@link
 * UploadStore.beginParts} and {@link UploadStore.writePart} are the same upload
 * arriving over several connections at once: the caller declares the total up front,
 * then writes disjoint windows in whatever order they finish.
 *
 * It reuses the streamed upload's whole shape — the caller names the id, the record
 * exists from the beginning with `complete: false` — and adds exactly two rules:
 *
 * - **A part starts at a multiple of `UPLOAD_CHUNK_BYTES`.** This used to be a
 *   STORAGE requirement (a part's bytes were stored as ordinary chunk rows at their
 *   own offsets, and a misaligned one would have had to rewrite the row it landed
 *   in). With one object per window it is no longer that, and it is kept for a
 *   different reason worth stating so it is not mistaken for a leftover: it bounds
 *   the key space. A part's offset IS its object's name, so arbitrary offsets let a
 *   client scatter a million tiny objects across a prefix nothing can enumerate,
 *   and let two parts of different sizes overlap at addresses no reader can
 *   reconcile. A megabyte grid costs a client nothing — it cuts where it likes as
 *   long as it cuts on megabytes.
 * - **`size` is the CONTIGUOUS prefix, never the sum of what has arrived.** Parts
 *   land out of order, so a size that counted bytes would tell a reader it may read
 *   a window that is still a hole. Counting only from byte zero keeps `size`
 *   meaning exactly what it meant before parts existed — "you may read up to
 *   here" — so `stepReadUpload`, the range route and a polling run all need no change,
 *   and a run reading ahead of the uplink still works.
 *
 * `complete` becomes true when that prefix reaches the declared total, which is the
 * only moment every byte is present. Non-overlapping parts are the CALLER's
 * contract, the same way the chosen id is: overlapping ones corrupt an upload the
 * caller alone can read.
 *
 * {@link UploadStore.recordParts} is the same write with NO body — for a part whose
 * bytes went from the browser to the bucket without passing through this process at
 * all. It is the reason the two are separate methods rather than one with an
 * optional body: a part that arrived here is measured as it streams, and a part
 * that did not has to be measured by ASKING THE BUCKET, which is what stops a
 * client advancing `size` past a hole.
 */

import type { OpenUpload, UploadReader } from "@alexkroman1/aai/host-internal";
import {
  UPLOAD_CHUNK_BYTES,
  UPLOAD_CLAIM_BATCH,
  UPLOAD_ID_PREFIX,
} from "@alexkroman1/aai/host-internal";
import type { UploadInfo, UploadRange } from "@alexkroman1/aai/step";

/** The table one row per upload lives in. Prefixed so it cannot collide with an app's own. */
export const UPLOADS_TABLE = "aai_workflow_uploads";

/**
 * Window objects a whole-file write keeps in flight at once.
 *
 * The number that decides whether the uplink and the bucket work at the same time
 * or take turns — see `putWindows` in `_upload-store-blobs.ts`, which is the only
 * caller. What it costs is memory, and exactly this much: the window's width times
 * `UPLOAD_PART_BYTES`, i.e. 32 MiB held while a body is arriving, because a window
 * is buffered whole before its write starts and stays held until that write
 * acknowledges. That is the price of the write being RETRYABLE, and it is why this
 * is 4 rather than the 8 the browser's own fan-out uses: a page holds one upload's
 * windows and a guest holds every concurrent uploader's at once.
 *
 * It bounds the FALLBACK path rather than the common one. A browser sending a
 * large file cuts it into parts itself, and each of those arrives as its own
 * request carrying a single window; this is what a `POST`, a `curl --data-binary`,
 * or a client the parts path declined for gets instead.
 *
 * **It is not what bounds a claim's PROBES** — see
 * {@link UPLOAD_PROBE_CONCURRENCY}, which this used to be spent on as well.
 */
export const UPLOAD_WINDOW_CONCURRENCY = 4;

/**
 * Bucket probes a `recordParts` claim keeps in flight at once.
 *
 * **Its own number because a probe carries NO BYTES, and every cost that sized
 * {@link UPLOAD_WINDOW_CONCURRENCY} is a cost per byte.** That one is memory — a
 * window is buffered whole before its write starts, so four of them is 32 MiB
 * held — and the browser's `UPLOAD_PART_CONCURRENCY` answers to the same shape
 * from the other side, where the measured limit is BYTES IN FLIGHT (32 MiB clean,
 * 64 MiB slower, 128 MiB resetting). A `HEAD` asking how big an object is puts a
 * request header on the wire and nothing else, so it meets none of those limits.
 *
 * Spending the window number on it was costing a claim its ROUND COUNT, which is
 * the only thing a batch of probes has: `UPLOAD_CLAIM_BATCH` is 32, so 32 probes at
 * four wide is EIGHT sequential rounds of a request that moves no data. Measured on
 * a harness at the production log's own latencies (600 ms per record round trip,
 * 400 ms per probe) over the three changes that landed together:
 *
 * | claim | 3 reads, 4 wide | 1 read, 4 wide | 1 read, 32 wide, overlapped |
 * | --- | --- | --- | --- |
 * | 1 window | 2202 ms | 1602 ms | **1202 ms** |
 * | 8 windows | 2605 ms | 1602 ms | **1202 ms** |
 * | 32 windows | 5013 ms | 1605 ms | **1203 ms** |
 *
 * So it is {@link UPLOAD_CLAIM_BATCH}: the batch is already bounded, and matching
 * it is what makes a claim's probe cost ONE round by construction rather than a
 * number that grows as the cap does. Deriving it rather than writing 32 twice is
 * the point — a later change to the batch cap cannot silently reintroduce rounds.
 *
 * **The last column is flat, and that is the finding**: the probes now run
 * alongside the record read that `recordParts` was waiting for anyway, so a claim
 * costs what its record round trips cost and its width is free. What is left is one
 * read and one write, both load-bearing — `upload-record-round-trips.test.ts`
 * counts every operation's round trips and argues the two this one keeps.
 */
export const UPLOAD_PROBE_CONCURRENCY = UPLOAD_CLAIM_BATCH;

/** Raised by an upload store's `create` when the body ran past its cap. */
export class UploadTooLargeError extends Error {
  constructor(limit: number) {
    super(`upload exceeds ${limit} bytes`);
    this.name = "UploadTooLargeError";
  }
}

/**
 * Raised by `stream` when the caller's chosen id is already taken.
 *
 * Its own error because the ROUTE has to answer 409: the request is well formed and
 * the id is simply not available, which a client retrying a `PUT` after a lost
 * response needs to tell apart from having composed the request wrong.
 */
export class UploadIdTakenError extends Error {
  constructor(id: string, options?: { cause?: unknown }) {
    // The cause is optional because the store learns this from a conditional
    // `insert` returning no row, which carries nothing worth attaching. It stays in
    // the signature for a caller that DOES have one — a bucket refusing a key, say —
    // rather than making that caller drop the only evidence it holds.
    super(`upload ${id} already exists`, options);
    this.name = UploadIdTakenError.name;
  }
}

/**
 * Raised when a write would change an upload that is already FINISHED.
 *
 * A finished upload is IMMUTABLE, and this says so. Its own class for the reason
 * {@link UploadIdTakenError} is — the route answers **409**, which a client has to
 * tell apart from a malformed request (400) and from a 5xx it should retry.
 *
 * **Why an upload freezes.** A part write is keyed by its OFFSET and the merge
 * replaces whatever window was there, so `PUT …/parts?offset=` against a completed
 * upload used to answer 200 and rewrite the bytes under it. Measured, all three
 * ways: `size` and `complete` were unchanged, so a step reading that window got the
 * new bytes with nothing to notice; a SHORTER replacement collapsed `size` and
 * flipped `complete` back to `false` on a file a run had been told was whole; and a
 * LONGER one recorded two overlapping windows, after which a `read` of two
 * megabytes returned three. Upload ids are the caller's to choose and the workflow
 * API is unauthenticated unless `AAI_WORKFLOW_API_TOKEN` is set, so none of it
 * needs a credential.
 *
 * {@link UploadStore.stream} has always refused a taken id; this is the same rule
 * one method over — an upload's bytes are written once.
 */
export class UploadCompleteError extends Error {
  constructor(id: string) {
    super(
      `Upload ${id} is complete; its bytes may not be rewritten. Store a new upload under ` +
        "a new id instead.",
    );
    this.name = UploadCompleteError.name;
  }
}

/**
 * Raised when a part does not fit the upload it names.
 *
 * Its own error because the ROUTE has to answer 400: a misaligned offset, or one
 * that runs past the declared total, is a client that composed the request wrong,
 * and it has to be told which — a part silently stored at the wrong place would be
 * read back as corruption at transcription time, minutes later and nowhere near
 * the cause.
 */
export class UploadPartError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = UploadPartError.name;
  }
}

/**
 * Raised when a part names an upload that was never begun.
 *
 * Distinct from {@link UploadPartError} because the route answers 404 rather than
 * 400: the request is well formed and the upload is simply not there, which is what
 * a client whose `beginParts` failed (or whose upload was cleaned up) has to see.
 */
export class UnknownUploadError extends Error {
  constructor(id: string) {
    super(`No upload with id ${id}`);
    this.name = UnknownUploadError.name;
  }
}

/**
 * Raised by every method of the store a deployment with no upload backend gets.
 *
 * Its own error for the reason the four above are, and the case for it is the
 * strongest of the five: this is the only one whose message is addressed to an
 * OPERATOR rather than to a client, and it is the only one that was being thrown
 * away. Untyped, it fell through the route's `sendUploadFailure` to
 * `answerHandlerFailure`, which is written to be opaque on purpose — "a rejection
 * that reached here is not the caller's fault to describe" — and that rule is
 * right for a crash and wrong for a named configuration condition whose whole
 * content is the remedy. The symptom is `{"error":"Internal server error"}` on
 * every upload route of a deployed agent, with `aai storage enable` sitting in a
 * string nobody ever sees.
 *
 * **The status is 501, and 500 or 503 would both be worse.** `RETRYABLE_STATUS`
 * (`sdk/_upload-retry.ts`) holds 500, 502, 503 and 504, so under either of those a
 * client spends its whole `UPLOAD_PART_ATTEMPTS` budget — four attempts, ~4-11s of
 * backoff, per part — re-asking a deployment that cannot ever answer differently,
 * and the message arrives last and looks like a flaky link. 501 says what is
 * actually true: this server does not implement uploads.
 */
export class UploadsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = UploadsUnavailableError.name;
  }
}

/** What an uploader declares about the file it is sending. */
export type UploadMeta = {
  /** Filename, as the browser reported it. Stored, never interpreted. */
  name?: string | undefined;
  /** MIME type the uploader declared. Stored, never sniffed. */
  type?: string | undefined;
};

/** The store, as the API routes and `stepReadUpload` use it. */
export type UploadStore = UploadReader & {
  /** {@link UploadReader.open}, REQUIRED here — the byte route has no fallback. */
  open(id: string): Promise<OpenUpload | undefined>;
  /**
   * Store one file, streaming it in.
   *
   * @throws {UploadTooLargeError} once more than `limit` bytes have arrived —
   *   raised as the stream runs, so an oversized body is never held.
   */
  create(
    meta: UploadMeta,
    body: AsyncIterable<Uint8Array>,
    opts?: { limit?: number },
  ): Promise<UploadInfo>;
  /**
   * Store one file under an id the CALLER chose, readable as it arrives.
   *
   * The record exists from the first byte with `complete: false`, so a run can be
   * started on this id before the upload finishes and read whatever has landed —
   * see the module doc for what that relaxes and how it is paid for.
   *
   * Resolves with the FINISHED record. A failure leaves the upload in place and
   * incomplete, deliberately: a reader may already have used the first half.
   *
   * @throws {UploadIdTakenError} when `id` already names an upload.
   * @throws {UploadTooLargeError} once more than `limit` bytes have arrived.
   */
  stream(
    id: string,
    meta: UploadMeta,
    body: AsyncIterable<Uint8Array>,
    opts?: { limit?: number },
  ): Promise<UploadInfo>;
  /**
   * Claim an id for an upload whose bytes arrive as PARTS, declaring its total.
   *
   * The record exists from this call with `size: 0` and `complete: false`, so this
   * is `stream`'s claim without the body — see the module doc for what parts buy
   * and the two rules they come with.
   *
   * @throws {UploadIdTakenError} when `id` already names an upload.
   * @throws {UploadTooLargeError} when `total` is past `limit`.
   */
  beginParts(
    id: string,
    meta: UploadMeta,
    total: number,
    opts?: { limit?: number },
  ): Promise<UploadInfo>;
  /**
   * Store one window of a parts upload, at a byte offset the caller chose.
   *
   * Resolves the record AS IT NOW STANDS — a `size` that is the contiguous prefix
   * and a `complete` that is true only once that prefix is the whole declared
   * total. So the caller writing the last part learns the upload is finished from
   * its own response, and every other part's response is the progress a page draws.
   *
   * {@link UploadInfo.ranges} rides along, which it deliberately did not before: it
   * used to mean a statement whose result set the CALLER sized — one row per island,
   * against `MAX_DB_RESULT_ROWS` — so a finely-cut sparse upload became a record
   * nothing could read again, and keeping the list off this path was the fix. The
   * boundary list is one `jsonb` column this write already reads and merges, so there
   * is nothing left to pay.
   *
   * @throws {UnknownUploadError} when nothing has begun under `id`.
   * @throws {UploadCompleteError} when the upload is already finished — its bytes
   *   are immutable from then on, whoever asks.
   * @throws {UploadPartError} when `offset` is not a multiple of
   *   `UPLOAD_CHUNK_BYTES`, or the part would run past the declared total.
   */
  writePart(id: string, offset: number, body: AsyncIterable<Uint8Array>): Promise<UploadInfo>;
  /**
   * Record parts whose bytes are ALREADY stored, without carrying them.
   *
   * The write for the direct path: the browser sent each window to the bucket
   * itself, so there is no body here and nothing for this process to stream.
   * Answers the same record `writePart` above does, so a client cannot tell which
   * route it took from the response.
   *
   * The size of each window is asked of the STORE, never taken from the caller. A
   * client that named a part it never uploaded would otherwise advance `size` past
   * a hole, and a step reading there gets silence rather than an error — a gap in a
   * transcript with nothing anywhere reporting one.
   *
   * **Several offsets, because the CLAIM is what an upload spends its time
   * on.** This takes a list rather than one offset, and that is the whole shape
   * of it: a claim carries no bytes and cost 1604-1969 ms against a deployed
   * agent, per PART, which was about half of an upload's wall clock
   * (`UPLOAD_CLAIM_BATCH` carries the measurement). Batching collapses the
   * network toll for the client and three per-part costs here — the declared-total
   * read, the record lock, and the whole-array write of `parts` — into one of each,
   * however many windows the request names.
   *
   * **All or nothing, and the order of the checks is what makes that true.** Every
   * named window is measured against the bucket BEFORE anything is written, so a
   * batch holding one bad offset records none of it. The alternative — recording
   * the good ones and reporting the bad — would leave a client that retries the
   * whole batch unable to tell which half it is repeating, against a store whose
   * one job here is that a hole never becomes a readable byte.
   *
   * **A claim on a FINISHED upload is a no-op unless it would CHANGE something**,
   * and the retry vocabulary is why. A claim is re-sent on a 5xx or a dropped
   * response (`_upload-retry.ts`), so the request that COMPLETED an upload is
   * exactly the one whose answer can be lost, and a bare 409 would fail an upload
   * whose every byte is stored. This path measures every named window before it
   * writes anything, so it tells the two apart for free: a claim naming windows the
   * record already holds at the same lengths answers with the record unchanged, and
   * one that would rewrite a window raises {@link UploadCompleteError}.
   *
   * @throws {UnknownUploadError} when nothing has begun under `id`.
   * @throws {UploadCompleteError} when the upload is finished and this claim would
   *   change a window of it.
   * @throws {UploadPartError} when `offsets` is empty or names the same byte twice,
   *   when an offset is misaligned, when no bytes are stored for one, or when what
   *   is stored runs past the declared total.
   */
  recordParts(id: string, offsets: readonly number[]): Promise<UploadInfo>;
};

/**
 * A half-open window of an upload's bytes, `[start, end)` like every other here.
 *
 * The SDK's own name for it, aliased rather than restated: these ranges reach a
 * caller as {@link UploadInfo.ranges}, so two structurally identical declarations
 * would be one rename away from disagreeing about what the store publishes.
 */
export type ByteRange = UploadRange;

/**
 * Refuse an offset a part may not start at.
 *
 * The offset IS the object's name, so the grid is what bounds the key space — see
 * the module doc, which also records that this used to be a storage requirement and
 * why it is kept now that it is not. A client cuts where it likes as long as it cuts
 * on megabytes.
 *
 * **A REASON PER CONDITION**, the way {@link assertPartTotal} below already does it.
 * Three different things are refused here and one message used to report all three
 * as "not a multiple of `UPLOAD_CHUNK_BYTES`" — which is FALSE for two of them:
 * `-1048576` and `1e20` are both exact multiples, and `PUT …/parts?offset=-1048576`
 * is a request anyone can send. A developer told their aligned offset is misaligned
 * re-checks the arithmetic they got right and has nowhere left to look; the offsets
 * that really are misaligned are still told so.
 */
export function assertPartOffset(offset: number): void {
  if (!Number.isSafeInteger(offset)) {
    throw new UploadPartError(
      `A part starts at a whole number of bytes this runtime can count exactly; ${offset} is not one.`,
    );
  }
  if (offset < 0) {
    throw new UploadPartError(`A part starts at or after byte zero; ${offset} is negative.`);
  }
  if (offset % UPLOAD_CHUNK_BYTES !== 0) {
    throw new UploadPartError(
      `A part starts at a multiple of ${UPLOAD_CHUNK_BYTES} bytes; ${offset} does not.`,
    );
  }
}

/** Refuse a declared total that is not a size. */
export function assertPartTotal(total: number, limit: number): void {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new UploadPartError(`A parts upload declares its total in bytes; ${total} is not one.`);
  }
  if (total > limit) throw new UploadTooLargeError(limit);
}

/**
 * How many bytes are present from byte ZERO — the `size` a parts upload publishes.
 *
 * Deliberately not the sum: see the module doc. A file whose first part has not
 * landed reports 0 however much of the rest has, because 0 is how much of it a
 * reader may read.
 */
export function contiguousBytes(ranges: readonly ByteRange[]): number {
  const first = ranges[0];
  return first && first.start === 0 ? first.end : 0;
}

/** A fresh upload id. Prefixed so a stray value in a log reads as what it is. */
export function newUploadId(): string {
  return `${UPLOAD_ID_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
}
