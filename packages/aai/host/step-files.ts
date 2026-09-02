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

import { mkdtemp, open, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatBytes } from "../sdk/format.ts";
import { isRecord } from "../sdk/is-record.ts";
import { readUpload, type UploadInfo, uploadInfo } from "../sdk/step-uploads.ts";
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
   * How many bytes the upload holds. Defaults to what `uploadInfo` reports.
   *
   * Pass it only when you already have the record — a step that reported the
   * file's name and size before starting has one, and this saves a second look.
   * Passing a size LARGER than the store holds is not an error: `readUpload`
   * clamps its window to what has arrived, and this walk stops at what it was
   * actually given rather than at what it asked for.
   */
  size?: number | undefined;
  /** Bytes per read. Defaults to {@link STEP_FILE_WINDOW_BYTES}. */
  windowBytes?: number | undefined;
};

/**
 * Write an upload to a local path, a window at a time, and answer with the byte
 * count that landed.
 *
 * A `for` loop rather than a fan-out deliberately: the bytes land in one file at
 * one offset each, so concurrency buys nothing and costs exactly the memory the
 * windows are here to bound.
 *
 * **The walk advances by what was READ, not by the window it asked for.** A
 * `readUpload` window is clamped to the bytes that have arrived, so on a STREAMED
 * upload — or on any stale `size` — a fixed `at += windowBytes` stride writes a
 * short chunk and then resumes a whole window later, silently leaving a hole in
 * the middle of the file. Advancing by `slice.end` cannot: a short answer ends
 * the walk, and the returned count is how the caller learns it was short.
 *
 * @param uploadId - The id a run input carried.
 * @param path - Where to write. Created, or truncated if it exists.
 * @param opts - See {@link ReadUploadToFileOptions}.
 * @returns Bytes written — equal to the upload's size unless the store came back
 *   short, which is the case a caller polling a streamed upload has to notice.
 */
export async function readUploadToFile(
  uploadId: string,
  path: string,
  opts: ReadUploadToFileOptions = {},
): Promise<number> {
  const size = opts.size ?? (await uploadInfo(uploadId)).size;
  const windowBytes = opts.windowBytes ?? STEP_FILE_WINDOW_BYTES;
  const handle = await open(path, "w");
  try {
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
  } finally {
    await handle.close();
  }
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
