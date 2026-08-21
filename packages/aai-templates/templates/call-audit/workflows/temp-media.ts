// Copyright 2026 the AAI authors. MIT license.
/**
 * Moving bytes between the upload store and a local file, which is what an
 * ffmpeg step spends most of its lines on.
 *
 * No directive, so it sits under `workflows/` untransformed and is called FROM
 * steps, inheriting their environment. It exists because both ffmpeg steps in
 * this template need the same three things and the third one is the one that is
 * easy to get wrong.
 *
 * ## Why a temp file at all
 *
 * `@alexkroman1/aai/ffmpeg` takes bytes as happily as a path, and for a short
 * clip bytes are the better call. This desk uses paths, for two reasons that are
 * both properties of real recordings rather than preferences:
 *
 * - **A pipe cannot seek.** An `.m4a` off a phone usually carries its `moov`
 *   index at the END of the file, so ffmpeg reading it from `pipe:0` fails with
 *   `moov atom not found`. That is the flagship input.
 * - **Piped output is capped**, at `DEFAULT_MAX_FFMPEG_OUTPUT_BYTES` (64 MiB),
 *   which is about half an hour of this desk's 16 kHz mono PCM. The desk exists
 *   for the two-hour call.
 *
 * ## A temp file may not outlive its step
 *
 * A step is journaled by its RETURN VALUE and may be dispatched into a different
 * process than its neighbours, so a path in a return value is a path that is
 * replayed after the file behind it is gone — and the failure mode is a resumed
 * run reading a directory that another run is using. {@link withTempDir} makes
 * the lifetime a lexical scope: the directory is created on entry, removed on
 * exit, and what crosses the step boundary is an upload id.
 */

import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUpload } from "@alexkroman1/aai/utils";

/**
 * Bytes moved per `readUpload`, and per write.
 *
 * Large enough that a two-hour recording is a few hundred round trips rather
 * than tens of thousands, and small enough that a step's resident set is a
 * constant rather than a function of the recording. The number this must NOT be
 * is "the whole file", which is the shape every first draft has.
 */
export const WINDOW_BYTES = 8 * 1024 * 1024;

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
 * fills it. `force` so a run that never created its output does not fail HERE and
 * replace the real error with this one.
 */
export async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "aai-call-audit-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Write an upload to a local path, a window at a time.
 *
 * A `for` loop rather than a fan-out deliberately: the bytes land in one file at
 * one offset each, so concurrency buys nothing and costs exactly the memory the
 * windows are here to bound.
 */
export async function materializeUpload(
  uploadId: string,
  size: number,
  path: string,
): Promise<void> {
  const handle = await open(path, "w");
  try {
    for (let at = 0; at < size; at += WINDOW_BYTES) {
      const slice = await readUpload(uploadId, {
        start: at,
        end: Math.min(at + WINDOW_BYTES, size),
      });
      await handle.write(slice.bytes);
    }
  } finally {
    await handle.close();
  }
}

/**
 * A local file as the stream `writeUpload` takes.
 *
 * A generator rather than `readFile`, for the same reason the windows above
 * exist: the normalized PCM is the largest thing this desk touches, and handing
 * the store an `AsyncIterable` is what keeps it off the heap.
 *
 * **The `.slice()` is load-bearing.** One buffer is reused across reads, so
 * yielding a view of it hands the consumer memory the next read overwrites — a
 * bug whose symptom is a stored file made of the LAST chunk repeated, and which
 * does not reproduce whenever the consumer happens to copy before the next
 * iteration.
 */
export async function* fileChunks(path: string): AsyncIterable<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(WINDOW_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return;
      yield buffer.subarray(0, bytesRead).slice();
    }
  } finally {
    await handle.close();
  }
}
