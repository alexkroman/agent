// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading an uploaded file from inside a `"use step"` function.
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
 * import { readUpload } from "@alexkroman1/aai/utils";
 *
 * export async function readHeader(uploadId: string) {
 *   "use step";
 *   const { bytes, info } = await readUpload(uploadId, { end: 64 * 1024 });
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
 * ## Why a published slot rather than an HTTP call
 *
 * A step runs in the SAME process as the server that stored the upload: the
 * DevKit's queue dispatches it to that server's own `/step` route. So the
 * reader is handed over in-process through a `Symbol.for` slot — the mechanism
 * {@link stepEnv} uses and for the same reason (the step artifact bundles its
 * own copy of this module, so publisher and reader are two instances in one
 * realm). Going out over HTTP instead would mean a loopback port to discover, a
 * bearer to present, and on the platform a round trip through the broker for
 * bytes that are already local.
 */

/** What a stored upload is, minus its bytes. */
export type UploadInfo = {
  /** The handle a run input carries. Opaque; mint one only by uploading. */
  id: string;
  /** Filename the uploader gave, or `""` when it named none. */
  name: string;
  /** MIME type the uploader declared, or `""`. Never sniffed from the bytes. */
  type: string;
  /** Total size in bytes. */
  size: number;
};

/** One window of an upload, as {@link readUpload} resolves it. */
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
 * Options for {@link readUpload}.
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
 * The half of an upload store a step needs: metadata, and a byte range.
 *
 * Declared here rather than in `host/` because this module is the reader and
 * `sdk/` may not import `host/`. `createUploadStore` implements it.
 *
 * @internal
 */
export type UploadReader = {
  /** One upload's metadata, or `undefined` when there is no such upload. */
  info(id: string): Promise<UploadInfo | undefined>;
  /** Bytes `[start, end)` of one upload. The caller has already clamped them. */
  read(id: string, start: number, end: number): Promise<Uint8Array>;
};

/** The registry-wide slot — see the module doc for why it is not a module-level `let`. */
const UPLOAD_READER_SLOT = Symbol.for("@alexkroman1/aai.uploadReader");

/** The shape stored in the slot. `undefined` means nothing has published. */
type UploadReaderSlot = { [UPLOAD_READER_SLOT]?: UploadReader };

/**
 * Publish the upload store for this process's `"use step"` functions.
 *
 * `createServer` does this, which is what makes uploads work identically under
 * `aai dev`, on a self-hosted server and in a deployed guest. Pass `undefined`
 * to unpublish.
 *
 * @internal — a host concern, exported from `@alexkroman1/aai/runtime`.
 */
export function publishUploadReader(reader: UploadReader | undefined): void {
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
  "No upload store in this process. Uploads are served by `createServer`, which every " +
  "deployed agent, every self-hosted server and `aai dev` go through. In a test, publish " +
  "a reader of your own with the `publishUploadReader` helper on the runtime subpath.";

/** The published store, or a failure naming why there is none. */
function requireReader(): UploadReader {
  const reader = (globalThis as UploadReaderSlot)[UPLOAD_READER_SLOT];
  if (!reader) throw new Error(UPLOADS_UNAVAILABLE_MESSAGE);
  return reader;
}

/**
 * Read one upload's metadata.
 *
 * @throws when the id names no upload — a step that reaches for one and finds
 *   nothing has been handed a stale or invented id, which no retry fixes.
 * @public
 */
export async function uploadInfo(id: string): Promise<UploadInfo> {
  const info = await requireReader().info(id);
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
 * say what was actually read.
 *
 * @public
 */
export async function readUpload(id: string, opts: ReadUploadOptions = {}): Promise<UploadSlice> {
  const reader = requireReader();
  const info = await reader.info(id);
  if (!info) throw new Error(`No upload with id ${id}`);
  const start = clamp(opts.start ?? 0, 0, info.size);
  const end = clamp(opts.end ?? info.size, start, info.size);
  // An empty window is answered without touching the store: it is a legal ask
  // (a zero-length trailing segment) and every backend would have to special
  // case it anyway.
  const bytes = end > start ? await reader.read(id, start, end) : new Uint8Array(0);
  return { info, bytes, start, end };
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
