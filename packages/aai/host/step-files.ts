// Copyright 2026 the AAI authors. MIT license.
/**
 * Moving bytes between the upload store and a local FILE — the plumbing an
 * ffmpeg step spends most of its lines on.
 *
 * `@alexkroman1/aai/ffmpeg` takes bytes as happily as a path, and for a short
 * clip bytes are the better call. Everything larger goes file → file, for two
 * reasons that are properties of real recordings rather than preferences:
 *
 * - **A pipe cannot seek.** An `.m4a` off a phone usually carries its `moov`
 *   index at the END of the file, so ffmpeg reading it from `pipe:0` fails with
 *   `moov atom not found`. That is the flagship input of every media pipeline
 *   anyone actually builds.
 * - **Piped output is capped**, at `DEFAULT_MAX_FFMPEG_OUTPUT_BYTES` (64 MiB),
 *   which is about half an hour of 16 kHz mono PCM. The pipelines that need
 *   ffmpeg at all exist for the two-hour call.
 *
 * So a step materializes the upload to a temp file, runs ffmpeg file → file,
 * and streams the result back into the store. Three functions, in that order:
 *
 * ```ts
 * import { join } from "node:path";
 * import { runFfmpeg, wavEncodeArgs } from "@alexkroman1/aai/ffmpeg";
 * import { readUploadToFile, withTempDir, writeUploadFromFile } from "@alexkroman1/aai/step-files";
 *
 * export async function toWav(uploadId: string): Promise<string> {
 *   return await withTempDir(async (dir) => {
 *     const source = join(dir, "source");
 *     const converted = join(dir, "converted.wav");
 *     await readUploadToFile(uploadId, source);
 *     await runFfmpeg(["-nostdin", "-y", "-i", source, ...wavEncodeArgs({ channels: 1 }), converted]);
 *     const stored = await writeUploadFromFile(converted, { name: "audio.wav", type: "audio/wav" });
 *     return stored.id;
 *   });
 * }
 * ```
 *
 * Nothing here holds a whole recording in memory at any point, which is the
 * property that makes a step written on it work on the input it was written for.
 * What the read direction DOES hold is {@link STEP_FILE_READ_CONCURRENCY}
 * windows — 32 MiB, a constant — because it reads them at once; see
 * {@link readUploadToFile} for why the remote read is what that buys.
 *
 * ## Why this is a subpath of its own, and not three more names on `/step`
 *
 * Same rule as `@alexkroman1/aai/ffmpeg`: this module imports
 * `node:fs/promises`, `node:os` and `node:path`, and `@alexkroman1/aai/step` is
 * an `sdk/` barrel, which is the half of this package that must stay runnable in
 * a browser and in Deno. `sdk/tsconfig.json` compiles with `types: []` so the
 * boundary is a compile error rather than a convention, and
 * `step-files.import-graph.test.ts` holds the `/step` barrel's whole transitive
 * graph free of `node:` — a `node:` import three modules below a name somebody
 * added to that barrel is how this regresses.
 *
 * These three names live in `host/` for the same reason and are reached by their
 * own subpath, so a `client.tsx` cannot pull them in by importing the step
 * vocabulary.
 *
 * ## A temp file may not outlive its step
 *
 * A step is journaled by its RETURN VALUE and may be dispatched into a different
 * process than its neighbours, so a path in a return value is a path that is
 * replayed after the file behind it is gone — and the failure mode is a resumed
 * run reading a directory another run is using. {@link withTempDir} makes the
 * lifetime a lexical scope: the directory is created on entry, removed on exit,
 * and what crosses the step boundary is an upload id.
 *
 * @module step-files
 */

import { type FileHandle, mkdtemp, open, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatBytes } from "../sdk/format.ts";
import { isRecord } from "../sdk/is-record.ts";
import { mapConcurrent } from "../sdk/map-concurrent.ts";
import { readUpload, type UploadInfo } from "../sdk/step-uploads.ts";
import { requireCompleteUpload } from "../sdk/step-uploads-complete.ts";
import { type WriteUploadOptions, writeUpload } from "../sdk/step-uploads-write.ts";

/**
 * Bytes moved per store round trip, in either direction.
 *
 * 8 MiB is large enough that a two-hour recording is a few hundred round trips
 * rather than tens of thousands, and small enough that a step's resident set is a
 * constant rather than a function of the recording. The number this must NOT be
 * is "the whole file", which is the shape every first draft has — and the reason
 * the window is nameable at all is that both functions below take it as an
 * option, which is what makes their multi-window paths reachable from a spec
 * without writing 16 MB to a disk.
 */
// 8 MiB, spelled as the literal rather than as `8 * 1024 * 1024`: an
// arithmetic initializer widens to `number` and drops the value out of the
// contract hash. See "Value-carrying constants carry a LITERAL type" in
// AGENTS.md.
export const STEP_FILE_WINDOW_BYTES = 8_388_608;

/**
 * Windows {@link readUploadToFile} reads at once, when the file is known to be
 * whole.
 *
 * What it costs is memory, and exactly this much: the width times
 * {@link STEP_FILE_WINDOW_BYTES}, i.e. **32 MiB** held while a copy is in flight,
 * because a window is buffered before its write starts. That is the same budget
 * the WRITE half of this round trip already accepts — `UPLOAD_WINDOW_CONCURRENCY`
 * (`aai-runtime/_upload-store.ts`) is 4 over the same 8 MiB window, and its doc
 * calls that "the number that decides whether the uplink and the bucket work at
 * the same time or take turns". Matching it is the whole argument for this value:
 * a step that pulls a recording in and pushes it back out should not hold two
 * different amounts of it, and 4 is a width the guest is already sized for.
 *
 * **It is UNMEASURED on the READ side, and that is stated rather than dressed up
 * in a table** — the write width was swept against a bucket and an uplink, and
 * nothing here has been swept against the brokered read path. What is known is
 * the shape of the cost it attacks: on a deployed guest each window is a brokered
 * `302` + `Range` GET against object storage
 * (`aai-runtime/_upload-blobs-brokered.ts`), which `UPLOAD_PART_BYTES`
 * (`sdk/upload-constants.ts`) measures at 1.9-4.3 MB/s per request, so a serial
 * walk cannot start window N+1 until window N has fully landed. Re-measure before
 * moving it; a wider default costs a guest's resident set linearly, and a metered
 * link takes back throughput that width alone tries to buy.
 */
export const STEP_FILE_READ_CONCURRENCY = 4;

/** Options for {@link withTempDir}. */
export type WithTempDirOptions = {
  /**
   * Prefix for the directory's name, under the OS temp directory.
   *
   * Defaults to `"aai-step-"`. Worth setting to something naming the pipeline
   * (`"aai-normalize-"`): the directory is gone by the time anyone looks, so the
   * prefix's real audience is a person reading `ls /tmp` during a run that hung,
   * and a spec asserting that nothing was left behind.
   */
  prefix?: string | undefined;
};

/**
 * Run `work` with a private temp directory, and remove it afterwards.
 *
 * `join(tmpdir(), …)` rather than a `/tmp` literal, which is this repo's rule
 * (`guard-invariants` rule 11) and not merely portability theatre: on Windows a
 * literal `/tmp/x` is DRIVE-RELATIVE, so it resolves somewhere that does not
 * exist and every write fails with ENOENT. A step runs in a Linux guest when it
 * is deployed and on the developer's own machine under `aai dev`, which is the
 * half that makes it matter.
 *
 * The removal is in a `finally`, so it also runs on the failure paths — a guest's
 * disk is small, and a step that leaves a copy of every recording it touched
 * fills it. `force`, so a run that never created its output does not fail HERE
 * and replace the real error with this one.
 *
 * @param work - Called with the directory. Its result is this call's result, so
 *   a step returns an upload id out of the scope rather than a path into it.
 * @param opts - See {@link WithTempDirOptions}.
 */
export async function withTempDir<T>(
  work: (dir: string) => Promise<T>,
  opts: WithTempDirOptions = {},
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), opts.prefix ?? "aai-step-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Options for {@link readUploadToFile}. */
export type ReadUploadToFileOptions = {
  /**
   * How many bytes the upload holds. Defaults to what `requireCompleteUpload`
   * reports — so with no size, an upload that is still ARRIVING is refused.
   *
   * Pass it only when you already have the record — a step that reported the
   * file's name and size before starting has one, and this saves a second look.
   * Passing a size LARGER than the store holds is not an error: `readUpload`
   * clamps its window to what has arrived, and this walk stops at what it was
   * actually given rather than at what it asked for.
   *
   * **Passing one moves the completeness judgement to the CALLER**, which is
   * what makes a polling body expressible: this option means "I have read the
   * record", and a caller who has read it can see `complete` for itself. It
   * therefore has to read it — `uploadInfo(id).size` threaded in here is the
   * whole bug this default now refuses, since that number IS the prefix.
   */
  size?: number | undefined;
  /** Bytes per read. Defaults to {@link STEP_FILE_WINDOW_BYTES}. */
  windowBytes?: number | undefined;
  /**
   * How many windows to read at once. Defaults to
   * {@link STEP_FILE_READ_CONCURRENCY}; rounded down and floored at 1, as
   * `mapConcurrent` does.
   *
   * **Read only when `size` is absent.** That option puts the completeness
   * judgement on the caller, and judging it means seeing the windows in order —
   * see {@link readUploadToFile}, which is where the two paths are cut apart.
   */
  concurrency?: number | undefined;
};

/**
 * Write an upload to a local path, a window at a time, and answer with the byte
 * count that landed.
 *
 * **The windows are read CONCURRENTLY, because the cost here is the REMOTE read
 * and not the local write.** This was a `for` loop, argued as *"the bytes land
 * in one file at one offset each, so concurrency buys nothing and costs exactly
 * the memory the windows are here to bound"* — which is true of the WRITE and
 * says nothing about the read. On a deployed guest every window is a brokered
 * `302` + `Range` GET against object storage
 * (`aai-runtime/_upload-blobs-brokered.ts`), measured at 1.9-4.3 MB/s per
 * request under `UPLOAD_PART_BYTES`, so window N+1's request did not start until
 * window N's bytes had fully landed and the whole leg was latency-bound. The
 * other half of the same round trip has always fanned out — `putWindows`
 * (`aai-runtime/_upload-store-blobs.ts`) runs `UPLOAD_WINDOW_CONCURRENCY` wide —
 * so a step normalizing a recording pulled it in one window at a time and pushed
 * it back out four at a time. See {@link STEP_FILE_READ_CONCURRENCY}, which is
 * that same 4 and the same 32 MiB held.
 *
 * **The walk advances by what was READ, not by the window it asked for, and that
 * contract only holds IN ORDER.** A `readUpload` window is clamped to the bytes
 * that have ARRIVED, so on a STREAMED upload — or on any stale `size` — a short
 * answer means the file ends there, and the returned count is how the caller
 * learns it. A fan-out cannot preserve that by itself: window 5 may land in full
 * while window 2 comes back short, and writing 5 leaves a HOLE the returned count
 * claims is not there — silent truncation, which is the failure this whole module
 * keeps being rewritten to refuse. So the two paths are cut on exactly that line:
 *
 * - **No `size`** — `requireCompleteUpload` has established the file is whole, so
 *   every window but the last is full BY CONSTRUCTION and landing order cannot
 *   change the result. This path fans out.
 * - **A `size`** — the caller is judging completeness itself, which is what makes
 *   a polling body expressible (see {@link ReadUploadToFileOptions.size}). This
 *   path stays serial, so it can stop at the first window the store came back
 *   short on rather than discovering it four windows later.
 *
 * **The concurrent path is still short-safe**, because a store may answer short
 * for reasons of its own. What it returns is the length of the CONTIGUOUS PREFIX
 * that landed — never the sum of the bytes it wrote — and it TRUNCATES the file to
 * that prefix, so a hole is neither reported as present nor left on disk in front
 * of bytes the count denies. That makes the two paths produce the same file, which
 * is what `step-files.test.ts` asserts rather than assumes.
 *
 * **With no `size`, an upload that is still arriving is REFUSED.** That count was
 * documented as how a caller learns the store came back short, and against a
 * defaulted size it could never say so: the default was `uploadInfo(id).size`,
 * the contiguous readable PREFIX, so the walk copied the prefix and returned a
 * number equal to it. What reached ffmpeg was a truncated recording with nothing
 * anywhere reporting it. See `sdk/step-uploads-complete.ts`.
 *
 * @param uploadId - The id a run input carried.
 * @param path - Where to write. Created, or truncated if it exists.
 * @param opts - See {@link ReadUploadToFileOptions}.
 * @returns Bytes written — equal to the upload's size unless the store came back
 *   short, which is the case a caller polling a streamed upload has to notice.
 * @throws {UploadIncompleteError} when no `size` was given and the upload is
 *   still arriving.
 */
export async function readUploadToFile(
  uploadId: string,
  path: string,
  opts: ReadUploadToFileOptions = {},
): Promise<number> {
  // Resolved BEFORE the handle is opened, which `open(path, "w")` makes
  // load-bearing: a refused incomplete upload must leave the destination alone
  // rather than truncate it to nothing on its way out.
  const size = opts.size ?? (await requireCompleteUpload(uploadId)).size;
  const windowBytes = opts.windowBytes ?? STEP_FILE_WINDOW_BYTES;
  const handle = await open(path, "w");
  try {
    // The presence of `size`, never its VALUE, is what picks the path — it is the
    // caller saying "I am judging completeness", and a caller who did that gets
    // the serial walk however whole the file happens to be.
    if (opts.size !== undefined)
      return await walkWindows(uploadId, handle, path, size, windowBytes);
    return await fanOutWindows(uploadId, handle, path, size, windowBytes, {
      width: opts.concurrency ?? STEP_FILE_READ_CONCURRENCY,
    });
  } finally {
    await handle.close();
  }
}

/**
 * The serial walk — for a caller judging completeness itself.
 *
 * Nothing here may be reordered, and that is the whole reason this survives
 * beside the fan-out: the contract is that the walk STOPS at the first window the
 * store could not fill, which is only observable in order. It advances by
 * `slice.end` rather than by the window it asked for, so a short answer ends the
 * walk instead of striding past it and leaving a hole mid-file.
 */
async function walkWindows(
  uploadId: string,
  handle: FileHandle,
  path: string,
  size: number,
  windowBytes: number,
): Promise<number> {
  let at = 0;
  while (at < size) {
    const slice = await readUpload(uploadId, {
      start: at,
      end: Math.min(at + windowBytes, size),
    });
    // Nothing more is there. `slice.end <= at` is the same finding by another
    // route and is here so a store that answers a window with no progress ends
    // the walk instead of spinning on it forever.
    if (slice.bytes.length === 0 || slice.end <= at) break;
    // `at` and `size` are only knowable here, and the capacity only from the
    // path — see `outOfSpace`.
    await handle.write(slice.bytes).catch(outOfSpace(path, at, size));
    at = slice.end;
  }
  return at;
}

/**
 * The fan-out — for a file `requireCompleteUpload` has established is whole.
 *
 * `mapConcurrent` rather than a pool of our own, and three of its documented
 * properties are what this rests on: it holds the width, its results come back in
 * ITEM order however the individual reads settle (so the prefix below is a walk
 * over windows in file order, not over completions), and a rejection is raised
 * only once the calls already in flight have SETTLED — so an `ENOSPC` on one
 * window cannot abandon a sibling mid-write against a handle the `finally` is
 * about to close.
 *
 * Positional writes are what make out-of-order landing legal: a window's offset is
 * its own and nothing depends on the file's cursor. What that buys has to be paid
 * for at the end, in the prefix walk.
 */
async function fanOutWindows(
  uploadId: string,
  handle: FileHandle,
  path: string,
  size: number,
  windowBytes: number,
  opts: { width: number },
): Promise<number> {
  const windows: Array<{ start: number; end: number }> = [];
  for (let at = 0; at < size; at += windowBytes) {
    windows.push({ start: at, end: Math.min(at + windowBytes, size) });
  }

  const landed = await mapConcurrent(windows, opts.width, async (window) => {
    const slice = await readUpload(uploadId, window);
    // How far this window really got, from the BYTES rather than from the `end`
    // the read echoes back: those agree for every well-behaved store, and where
    // they do not the bytes are the half that cannot over-claim. Clamped to the
    // window so a store answering with more than it was asked for cannot write
    // over its neighbour either.
    const reached = Math.min(window.start + slice.bytes.length, window.end);
    if (reached <= window.start) return { ...window, reached: window.start };
    // `window.start` rather than a running total: windows land out of order, so
    // there is no "how far the walk got" to report, and where this one sits is
    // the honest figure — see `outOfSpace`.
    await handle
      .write(slice.bytes, 0, reached - window.start, window.start)
      .catch(outOfSpace(path, window.start, size));
    return { ...window, reached };
  });

  // The prefix, and only the prefix: a window that came back short or empty ends
  // the file, whatever its successors managed to land. Summing what was written
  // instead is the silent-truncation bug written the other way up — it reports a
  // length the file's first N bytes do not back.
  let at = 0;
  for (const window of landed) {
    if (window.reached <= window.start) break;
    at = window.reached;
    if (window.reached < window.end) break;
  }
  // And the hole is not merely unreported — it is not on disk. A positional write
  // past the prefix leaves a sparse gap, so a caller that ignored the count would
  // read zeroes and then real bytes; cutting the file back makes it exactly what
  // was answered for, which is what the serial walk produces by construction.
  if (at < size) await handle.truncate(at);
  return at;
}

/**
 * Turn an `ENOSPC` into the sentence a run's failure should have carried.
 *
 * What a run recorded was `ENOSPC: no space left on device, write` and nothing
 * else — no directory, no capacity, no byte count — for a step that had just
 * reported the file's size two lines earlier. That took a live filesystem and a
 * shell inside the container to explain, and every fact needed to explain it was
 * in this frame: the PATH names the filesystem that filled, `at` is how far the
 * walk got, `size` is what it was asked for, and `statfs` is what the mount
 * actually holds.
 *
 * The capacity is worth the extra syscall because the number is the whole
 * finding. `os.tmpdir()` is a real disk on a laptop and a **512 MiB tmpfs** — RAM,
 * not disk — at `/tmp` in a guest microVM whose `/` had 3.9 GB free, so the
 * module's own promise one paragraph up ("nothing here holds a whole recording
 * in memory") is false there by way of the filesystem, and silently. Naming
 * both the free space and the total is what makes that legible in one line.
 *
 * `statfs` failing is not allowed to replace the real error: the whole point is
 * to say more about the ENOSPC, so a capacity nobody could read degrades to the
 * counts and the path.
 *
 * Anything that is not an `ENOSPC` is re-thrown UNCHANGED. This is enrichment,
 * not classification — the verdict stays the caller's (see
 * `throwFatalStepError` on `@alexkroman1/aai/step-errors`, which is what a step
 * should reach for once it has decided a full disk is terminal, as it is).
 */
function outOfSpace(path: string, written: number, size: number): (err: unknown) => Promise<never> {
  return async (err: unknown): Promise<never> => {
    if (!(isRecord(err) && err.code === "ENOSPC")) throw err;
    throw new Error(
      `Ran out of space writing ${formatBytes(size)} to ${path} — ` +
        `${formatBytes(written)} landed before the filesystem was full` +
        `${await capacityOf(dirname(path))}.`,
      { cause: err },
    );
  };
}

/** ` (the mount holding it is 512 MB, 0 B free)`, or nothing if it cannot be read. */
async function capacityOf(dir: string): Promise<string> {
  const stats = await statfs(dir).catch(() => undefined);
  if (!stats) return "";
  const total = Number(stats.blocks) * Number(stats.bsize);
  const free = Number(stats.bavail) * Number(stats.bsize);
  if (!(Number.isFinite(total) && Number.isFinite(free))) return "";
  return ` (the mount holding it is ${formatBytes(total)}, ${formatBytes(free)} free)`;
}

/** Options for {@link writeUploadFromFile} — {@link WriteUploadOptions}, plus the window. */
export type WriteUploadFromFileOptions = WriteUploadOptions & {
  /** Bytes per read. Defaults to {@link STEP_FILE_WINDOW_BYTES}. */
  windowBytes?: number | undefined;
};

/**
 * Store a local file as an upload, streaming it, and answer with the record.
 *
 * The composition rather than the generator, and that is the whole design of this
 * function: `writeUpload(fileChunks(path), { … })` is three lines a caller can
 * write, and one of the three is a trap that has to be re-explained every time it
 * is written (see below). Handing over the composition means the trap is tested
 * once, here, by `step-files.test.ts` — where deleting the `.slice()` fails a
 * spec — rather than being a warning comment in every template that copies it.
 *
 * A stream rather than `readFile` for the reason the windows above exist: the
 * converted audio is usually the largest thing a media step touches, and handing
 * the store an `AsyncIterable` is what keeps it off the heap.
 *
 * @param path - The file to store. Read to EOF; never modified or removed, so a
 *   {@link withTempDir} scope is still what owns its lifetime.
 * @param opts - `name` and `type` are stored verbatim and neither is inferred —
 *   pass both, since `type` is what the byte route serves as `Content-Type` and a
 *   browser will not play a file it was handed as bytes. See
 *   {@link WriteUploadFromFileOptions}.
 */
export async function writeUploadFromFile(
  path: string,
  opts: WriteUploadFromFileOptions = {},
): Promise<UploadInfo> {
  const { windowBytes, ...meta } = opts;
  return await writeUpload(fileChunks(path, windowBytes ?? STEP_FILE_WINDOW_BYTES), meta);
}

/**
 * A local file as the chunk stream `writeUpload` takes.
 *
 * Not exported, which is the point of {@link writeUploadFromFile} — see its doc.
 *
 * **The `.slice()` is load-bearing.** One buffer is reused across reads, so
 * yielding a view of it hands the consumer memory the next read overwrites — a
 * bug whose symptom is a stored file made of the LAST chunk repeated, and which
 * does not reproduce whenever the consumer happens to copy before the next
 * iteration. That last property is what makes it worth a copy rather than a
 * comment: it survives review, survives a mocked consumer, and shows up as
 * corrupt audio in production.
 */
async function* fileChunks(path: string, windowBytes: number): AsyncIterable<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(windowBytes);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return;
      yield buffer.subarray(0, bytesRead).slice();
    }
  } finally {
    await handle.close();
  }
}
