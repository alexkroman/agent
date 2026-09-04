// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading — and writing — a file from inside a step.
 *
 * A workflow's input is journaled and replayed on every resume, so a file's
 * BYTES cannot live in it: they would be re-read for the life of the run, and
 * `MAX_WORKFLOW_INPUT_BYTES` (64 KB) caps the request that carries them besides.
 * That is why a form used to have to ask for a URL — the bytes had to already be
 * somewhere, and the app had nowhere to put them.
 *
 * Uploads are that somewhere. The browser (or `curl`, or the CLI) POSTs the file
 * to `POST /workflows/uploads`, the run input carries the returned **id**, and a
 * step reads exactly the window it needs:
 *
 * ```ts no-check
 * import { stepReadUpload } from "@alexkroman1/aai/step";
 *
 * export async function readHeader(uploadId: string) {
 *   const { bytes, info } = await stepReadUpload(uploadId, { end: 64 * 1024 });
 *   return parseHeader(bytes, info.size);
 * }
 * ```
 *
 * So sixty steps move the recording once between them rather than sixty times,
 * and a resumed run re-reads only the window its own step asked for.
 *
 * ## Ranges are `[start, end)`, like every other JS slice
 *
 * HTTP's `Range` header is inclusive and the store converts; nothing here is. A
 * caller that already has `{ start, end }` byte offsets — which is what planning
 * a fan-out over a file produces — passes them unchanged, and the off-by-one
 * that an inclusive API invites cannot be written.
 *
 * ## An upload can be read WHILE it is still arriving
 *
 * Everything above describes a finished file, and it forces a strict order —
 * store all the bytes, then start the run — because for a long recording the
 * upload is most of the wall clock. A STREAMED upload inverts that: the client
 * names the id itself and `PUT`s the file in one request, the record appears
 * immediately with `complete: false`, and its `size` grows as bytes land.
 *
 * The reader needs almost nothing for this, which is the point:
 *
 * - {@link stepUploadInfo} reports `size` — what has ARRIVED — and `complete`.
 * - {@link stepReadUpload} already clamps its window to `size`, so a step asking for
 *   bytes that have not arrived yet gets what has, and says so in the `end` it
 *   returns. That was true before streaming existed and is what makes it work.
 *
 * So a body polls `stepUploadInfo` in a step and transcribes whatever windows are
 * fully present, exactly as it would over a finished file:
 *
 * ```ts
 * import { stepReadUpload, stepUploadInfo } from "@alexkroman1/aai/step";
 * import type { WorkflowContext } from "@alexkroman1/aai/workflow-api";
 *
 * export async function transcribeStream(input: { recording: string }, ctx: WorkflowContext) {
 *   for (;;) {
 *     // In a step, so each poll's answer is journaled rather than re-read on
 *     // every replay — `arrived#0`, `arrived#1`, … one per round of the loop.
 *     const { size, complete } = await ctx.step("arrived", () => stepUploadInfo(input.recording));
 *     // … work on every segment whose `end` is inside `size` …
 *     if (complete) break;
 *     await ctx.sleep("poll", 5000);
 *   }
 * }
 * ```
 *
 * **`complete` is the field to branch on, never `size`.** A size that stopped growing
 * means "nothing arrived recently", which is what a slow link and a dead client both
 * look like; only `complete` says the file is all there. A body that treated a stalled
 * size as the end would return a transcript of most of a recording and report success.
 *
 * Two rules a body written on this has to keep, and neither is enforceable here:
 *
 * - **Poll in a STEP, loop in the body.** `stepUploadInfo` is I/O, so a body may not
 *   call it; and the result must be journaled, because what the body does next is
 *   derived from it. A body reading it directly would take a different branch on
 *   every replay.
 * - **A `sleep` between polls is what a wake shortens.** `POST /workflows/runs/
 *   :id/wake` ends a pending `sleep`, so a client that wakes the run when its
 *   upload finishes gets the tail for free — and one that does not still works,
 *   one poll interval behind.
 *
 * ## The store is also where a step PUTS a file
 *
 * {@link stepWriteUpload} is the other direction, and it is the same rule arriving at
 * the other end of the run: an OUTPUT is journaled and read back as JSON, so audio, an
 * image or a PDF cannot travel in one either. A step writes the bytes here, the output
 * carries the id, and a page turns it back into a file with `api.download(id)`. Its own
 * doc carries what that obliges — chiefly that the write belongs in the step that MAKES
 * the file, so a resumed run replays an id rather than redoing the work.
 *
 * ## Why a published slot rather than an HTTP call
 *
 * A step runs in the SAME process as the server that stored the upload: the engine
 * walks the body in the process serving the run. So the reader is handed over
 * in-process through a `Symbol.for` slot — the mechanism {@link stepEnv} uses and
 * for the same reason (the agent bundle carries its own copy of this module, so
 * publisher and reader are two instances in one realm). Going out over HTTP
 * instead would mean a loopback port to discover, a bearer to present, and on the
 * platform a round trip through the broker for bytes that are already local.
 */

import { UPLOAD_TOKEN_RE } from "./upload-constants.ts";

/** What a stored upload is, minus its bytes. */
export type UploadInfo = {
  /**
   * The handle a run input carries.
   *
   * Minted by the store for an ordinary upload, and CHOSEN BY THE CALLER for a
   * streamed one — see `UPLOAD_TOKEN_RE`, which is what a chosen id has to satisfy.
   */
  id: string;
  /** Filename the uploader gave, or `""` when it named none. */
  name: string;
  /** MIME type the uploader declared, or `""`. Never sniffed from the bytes. */
  type: string;
  /**
   * Bytes STORED so far.
   *
   * The whole file for a finished upload, and a growing number for one still
   * arriving — which is why {@link stepReadUpload} clamps to it rather than to
   * anything the uploader declared. Never trust it as a total: see
   * {@link UploadInfo.complete}.
   */
  size: number;
  /**
   * Whether every byte is in.
   *
   * The one field a body waiting on a streamed upload may branch on. `false` means
   * more may arrive; a `size` that has stopped growing means only that nothing
   * arrived recently, which a slow link and a dead client both produce. An
   * ordinary upload is `true` from the moment it exists, because it does not exist
   * until it is finished.
   */
  complete: boolean;
  /**
   * Which windows have LANDED, for an unfinished upload that arrived as parts.
   *
   * Absent for every other upload, and that absence is the honest answer rather
   * than an omission: a whole-file write has no windows (its bytes are one
   * contiguous prefix, which {@link UploadInfo.size} already states), and a
   * finished parts upload is covered end to end by construction.
   *
   * **A READER may act on it, and {@link stepReadUpload} already does.** This used to
   * say `size` was the only field a reader could trust, on the ground that a range
   * past the prefix names bytes with a hole in front of them. The bytes are still
   * there — the store maps a window onto the objects covering it and never
   * consults the prefix — so what the rule really protected was a read STRADDLING
   * a hole, and clamping to the containing run protects that exactly while making
   * a landed window readable. Without it a parts upload publishes nothing a run
   * can use until its first window lands, which under a fan-out is the end of the
   * upload; `readableEnd` carries the measurement.
   *
   * The other reader is the UPLOADER: a client re-sending a parts upload can skip
   * the windows that are already stored instead of sending the file again, which
   * is the difference between resuming a recording and starting it over.
   *
   * Sorted, non-overlapping, and half-open like every other range here.
   *
   * **A LIST rather than a single offset, and that is the whole of what it buys.**
   * The obvious cheaper shape is one number — "everything up to here has landed" —
   * which is what a sequential append protocol reports (tus's `Upload-Offset`,
   * where a `PATCH` at any other offset is a 409). A single cursor cannot represent
   * a GAP at all, so under it an upload whose second part was lost has to re-send
   * everything after the first, and a fan-out that lands parts out of order has
   * nothing to report until they happen to join up. {@link UploadInfo.size} already
   * IS that number. This is the strictly larger fact.
   *
   * Absent also means "cannot say", not "nothing landed" — the store may decline
   * to report windows, and an agent too old to have this field says nothing
   * either. A reader's answer to an absent list is therefore to assume nothing
   * about what is stored, which for an uploader means sending the file.
   */
  ranges?: readonly UploadRange[];
};

/** A half-open window of an upload's bytes, `[start, end)`. */
export type UploadRange = { start: number; end: number };

/** One window of an upload, as {@link stepReadUpload} resolves it. */
export type UploadSlice = {
  /** The upload this came from — `size` is the WHOLE file, not this window. */
  info: UploadInfo;
  /** The requested bytes, clamped to the file. */
  bytes: Uint8Array;
  /** First byte offset returned, after clamping. */
  start: number;
  /** One PAST the last byte offset returned, after clamping. */
  end: number;
};

/**
 * Options for {@link stepReadUpload}.
 *
 * Both bounds admit `undefined` explicitly rather than being merely optional:
 * a step computes them from a plan, and under `exactOptionalPropertyTypes` a
 * `{ start: maybe }` would otherwise be a compile error at every call site that
 * has one — which is most of them, since "no start" and "start 0" mean the same
 * thing here.
 */
export type ReadUploadOptions = {
  /** First byte to read. Defaults to 0. */
  start?: number | undefined;
  /** One past the last byte to read. Defaults to the end of the file. */
  end?: number | undefined;
};

/**
 * One upload OPENED: its record, and a reader over the windows THAT record named.
 *
 * The shape exists because {@link UploadReader.info} and {@link UploadReader.read}
 * each resolve the record for themselves, and every caller needs both — so the
 * obvious composition costs TWO look-ups of one row for one logical read, and the
 * byte route costs one per CHUNK. Measured against a counting record backend, a
 * `stepReadUpload` was 2 and a range download of an N-window upload was N+1; both are
 * 1 through here. On a deployed guest a look-up is a `POST /:slug/upload-records`
 * across the platform, so those are round trips rather than map reads.
 *
 * **It also PINS the window map for the operation, which is the correctness
 * half.** A read resolved its ceiling from one record and then fetched its bytes
 * against a possibly newer one, and the byte route wrote a `Content-Length` from a
 * record it then read N chunks against — so a part landing mid-download could
 * answer bytes the header had already promised were something else. One record,
 * one answer.
 *
 * @public
 */
export type OpenUpload = {
  /** The record every window below was resolved against. */
  info: UploadInfo;
  /** Bytes `[start, end)` of this upload. The caller has already clamped them. */
  read(start: number, end: number): Promise<Uint8Array>;
};

/**
 * The half of an upload store a step needs: metadata, and a byte range.
 *
 * Declared here rather than in `host/` because this module is the reader and
 * `sdk/` may not import `host/`. `createUploadStore` implements it.
 *
 * @public
 */
export type UploadReader = {
  /** One upload's metadata, or `undefined` when there is no such upload. */
  info(id: string): Promise<UploadInfo | undefined>;
  /** Bytes `[start, end)` of one upload. The caller has already clamped them. */
  read(id: string, start: number, end: number): Promise<Uint8Array>;
  /**
   * The record and a reader over it, from ONE look-up — see {@link OpenUpload}.
   *
   * **OPTIONAL, and the fallback is exactly the pair above.** A fake holds its
   * bytes in memory, where a second look-up costs nothing; a REAL store's is a
   * database row or an HTTP round trip, which is the whole reason this exists.
   * So requiring it would break every two-method fake to buy nothing on the one
   * path that has nothing to save. `UploadStore` (`aai-runtime`) requires it.
   */
  open?(id: string): Promise<OpenUpload | undefined>;
};

/** What an uploader may declare about a file it is storing. */
export type UploadWriteMeta = {
  /** Filename to store. Stored, never interpreted. */
  name?: string | undefined;
  /** MIME type to store. Stored, never sniffed from the bytes. */
  type?: string | undefined;
};

/**
 * The half of an upload store {@link stepWriteUpload} needs: minting a new file.
 *
 * Separate from {@link UploadReader} rather than an optional method on it, and the
 * reason is mechanical as well as tidy. `UploadStore` in `host/` already declares
 * its own `create` with a third `{ limit }` parameter — an INTERSECTION with a
 * second declaration of the same method makes an overloaded type its own
 * implementation no longer satisfies, which is a compile error in the store rather
 * than at any call site. Keeping the two halves apart and intersecting them only
 * at the SLOT leaves each declaration the single one for its method.
 *
 * @internal
 */
export type UploadWriter = {
  /** Store a file, minting its id, and answer with the finished record. */
  create(meta: UploadWriteMeta, body: AsyncIterable<Uint8Array>): Promise<UploadInfo>;
};

/**
 * What may be published: a reader, and OPTIONALLY a writer.
 *
 * The write half is optional and that is not an oversight — a store that only
 * reads is a legitimate thing to publish (a spec supplying its own bytes is
 * the common one), and {@link stepWriteUpload} naming what is missing beats every
 * stub in the repo having to grow a writer it does not use.
 *
 * @internal
 */
export type UploadAccess = UploadReader & Partial<UploadWriter>;

/** The registry-wide slot — see the module doc for why it is not a module-level `let`. */
const UPLOAD_READER_SLOT = Symbol.for("@alexkroman1/aai.uploadReader");

/** The shape stored in the slot. `undefined` means nothing has published. */
type UploadReaderSlot = { [UPLOAD_READER_SLOT]?: UploadAccess };

/**
 * Publish the upload store for this process's steps.
 *
 * `createRuntimeServer` does this, which is what makes uploads work identically under
 * `aai dev`, on a self-hosted server and in a deployed guest. Pass `undefined`
 * to unpublish.
 *
 * @internal — a host concern, exported from `@alexkroman1/aai-runtime`.
 */
export function publishUploadReader(reader: UploadAccess | undefined): void {
  if (reader === undefined) delete (globalThis as UploadReaderSlot)[UPLOAD_READER_SLOT];
  else (globalThis as UploadReaderSlot)[UPLOAD_READER_SLOT] = reader;
}

/**
 * The sentence a step gets when no store was published.
 *
 * It names both causes, because they are not distinguishable from here: a
 * process that serves no workflow API at all (a bare script), and a spec that
 * called the step directly.
 *
 * @internal
 */
export const UPLOADS_UNAVAILABLE_MESSAGE =
  "No upload store in this process. Uploads are served by `createRuntimeServer`, which every " +
  "deployed agent, every self-hosted server and `aai dev` go through. In a test, publish " +
  "a reader of your own with the `publishUploadReader` helper on the runtime subpath.";

/**
 * The published store, or a failure naming why there is none.
 *
 * Exported so the WRITE half (`step-uploads-write.ts`, split out for the file
 * cap) resolves the same slot rather than a second copy of the lookup — two
 * would be one rename away from disagreeing about which store a process has.
 *
 * @internal
 */
export function requireUploadAccess(): UploadAccess {
  const reader = (globalThis as UploadReaderSlot)[UPLOAD_READER_SLOT];
  if (!reader) throw new Error(UPLOADS_UNAVAILABLE_MESSAGE);
  return reader;
}

/**
 * Read one upload's metadata: its name, what has ARRIVED, and whether that is all
 * of it.
 *
 * The poll a body waiting on a streamed upload runs.
 *
 * **`complete` is the field to branch on, never `size`.** A size that stopped
 * growing means "nothing arrived recently", which is what a slow link and a dead
 * client both look like; only `complete` says the file is all there. A body that
 * treated a stalled size as the end would return a transcript of most of a
 * recording and report success.
 *
 * @throws when the id names no upload — a step that reaches for one and finds
 *   nothing has been handed a stale or invented id, which no retry fixes. Note a
 *   streamed upload EXISTS from its first byte, so this answers for one that is
 *   still arriving.
 * @public
 */
export async function stepUploadInfo(id: string): Promise<UploadInfo> {
  const info = await requireUploadAccess().info(id);
  if (!info) throw new Error(`No upload with id ${id}`);
  return info;
}

/**
 * Read a window of an uploaded file.
 *
 * Omitting both bounds reads the whole file, which is the right call only when
 * the file is small: everything else names the window it needs, so a fan-out
 * over a large file moves each byte once.
 *
 * Bounds are CLAMPED rather than rejected — a plan computed from a file's own
 * header can legitimately end one byte past it, and the returned `start`/`end`
 * say what was actually read. That is also exactly what makes a STREAMED upload
 * readable: the clamp is to what has ARRIVED, so a window that runs past the
 * bytes stored so far comes back short rather than failing, and `end` is how a
 * caller learns which it got.
 *
 * @example
 * Write in one step, read a window back in another — an id crosses the journal,
 * bytes never do.
 * ```ts
 * import { stepReadUpload, stepWriteUpload } from "@alexkroman1/aai/step";
 *
 * export async function store(bytes: Uint8Array): Promise<string> {
 *   const { id } = await stepWriteUpload(bytes, { name: "summary.wav" });
 *   return id;
 * }
 *
 * export async function firstSecond(uploadId: string): Promise<Uint8Array> {
 *   const { bytes } = await stepReadUpload(uploadId, { start: 44, end: 44 + 32_000 });
 *   return bytes;
 * }
 * ```
 *
 * @public
 */
export async function stepReadUpload(
  id: string,
  options: ReadUploadOptions = {},
): Promise<UploadSlice> {
  // ONE look-up of the record, not two — see {@link OpenUpload}. The clamp below
  // is unchanged and still runs HERE rather than in the store: it is the reader's
  // contract (a plan may end one byte past the file) and there is one copy of it.
  const held = await openUpload(id);
  if (!held) throw new Error(`No upload with id ${id}`);
  const { info } = held;
  const ceiling = readableEnd(info, options.start ?? 0);
  const start = clamp(options.start ?? 0, 0, ceiling);
  const end = clamp(options.end ?? info.size, start, ceiling);
  // An empty window is answered without touching the store: it is a legal ask
  // (a zero-length trailing segment) and every backend would have to special
  // case it anyway.
  const bytes = end > start ? await held.read(start, end) : new Uint8Array(0);
  return { info, bytes, start, end };
}

/**
 * The published store's record for `id` and a reader bound to it, or `undefined`.
 *
 * The one place {@link UploadReader.open}'s absence is answered, so a two-method
 * fake behaves exactly as it did and a real store pays one look-up.
 */
async function openUpload(id: string): Promise<OpenUpload | undefined> {
  const reader = requireUploadAccess();
  if (reader.open) return await reader.open(id);
  const info = await reader.info(id);
  if (!info) return undefined;
  return { info, read: async (start, end) => await reader.read(id, start, end) };
}

/**
 * How far a read starting at `start` may go: the end of the stored run it falls in.
 *
 * {@link UploadInfo.size} is the CONTIGUOUS PREFIX, and clamping to it alone is
 * why a window that is fully stored can still read as empty. That is the ordinary
 * case for a parts upload rather than an edge one: the browser sends
 * `UPLOAD_PART_CONCURRENCY` windows of `UPLOAD_PART_BYTES` at once, so they share
 * the uplink and land together — the prefix is 0 until the FIRST part completes,
 * which is within a second of the last one. Measured on a deployed agent, a 27 MB
 * recording at 0.9 MB/s: `size` was 0 for 45 of 45 seconds, then the whole file.
 * A run watching that upload sees nothing to work on until it is over, which is
 * exactly the wait streaming exists to remove.
 *
 * So the ceiling is the end of the run CONTAINING `start`, never `end`'s own run:
 * a window that begins inside stored bytes and runs into a hole must still stop at
 * the hole. `Math.max` with `size` keeps every prefix read byte-identical to what
 * it was — the prefix IS a run, and a `start` in no run at all clamps to the
 * prefix and reads nothing, as before.
 *
 * `ranges` is absent for every upload that is not an unfinished parts upload
 * (a whole-file write has no windows; a finished one is covered end to end), so
 * this is a no-op everywhere else.
 */
function readableEnd(info: UploadInfo, start: number): number {
  const run = info.ranges?.find((range) => range.start <= start && start < range.end);
  return Math.max(info.size, run?.end ?? 0);
}

/**
 * `value` held between `low` and `high`.
 *
 * `NaN` reads as `low` — it carries no intent at all, so the safest reading is
 * the smallest window. An infinity is left to the arithmetic, which resolves it
 * to the bound it is running at: `end: Infinity` means "to the end of the file",
 * which is exactly what a caller writing it meant.
 */
function clamp(value: number, low: number, high: number): number {
  if (Number.isNaN(value)) return low;
  return Math.min(Math.max(Math.trunc(value), low), high);
}

/**
 * Refuse an id no store may be handed.
 *
 * Here rather than in `host/` because everything that touches a CHOSEN id needs the
 * same answer and one of them is a browser-safe module: the HTTP route, both store
 * backends, and any test reaching a backend directly. A token one of them accepts
 * and another refuses is an upload that can be written and never read — or, in the
 * file backend, a filename outside the store.
 *
 * @internal
 */
export function assertUploadToken(id: string): void {
  if (!UPLOAD_TOKEN_RE.test(id)) {
    throw new Error(
      `Invalid upload id ${JSON.stringify(id)}. A caller-chosen id is 1-64 characters of ` +
        "letters, digits, `-` and `_` — a `crypto.randomUUID()` already qualifies.",
    );
  }
}
