// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for `step-files.ts` — the upload ↔ local-file plumbing.
 *
 * **These touch a real filesystem**, which the unit tier otherwise avoids, and
 * the exception is deliberate rather than a slip. A temp directory is hermetic,
 * costs milliseconds, and is the only way to exercise the one bug this module
 * exists to absorb: the chunk generator behind {@link writeUploadFromFile}
 * reuses a single buffer across reads, so yielding a VIEW of it rather than a
 * copy hands the consumer memory the next read overwrites. That failure stores
 * a file made of the last chunk repeated, and it does not reproduce whenever the
 * consumer happens to copy before the next iteration — so a mocked consumer
 * would not see it and only real bytes will. Verified to catch it: deleting the
 * `.slice()` in `fileChunks` fails "stores the file's real bytes".
 *
 * The upload store is the other seam that makes this testable at all —
 * `readUpload`/`writeUpload` read a process-wide slot rather than dialling
 * anything, so a spec supplies its own bytes and the code under test is
 * unchanged. `stubUploads` is imported from its own module rather than from
 * `sdk/testing.ts`; the barrel would work equally well and this is the narrower
 * graph.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { uploadInfo } from "../sdk/step-uploads.ts";
import { stubUploads } from "../sdk/testing-uploads.ts";
import {
  readUploadToFile,
  STEP_FILE_WINDOW_BYTES,
  withTempDir,
  writeUploadFromFile,
} from "./step-files.ts";

const UPLOAD_ID = "upl_recording";

/**
 * Unpublishing the store is not optional — one left published makes the next
 * file's steps read this one's bytes, which presents as a passing test somewhere
 * else.
 */
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

/** `stubUploads`, with its `restore` queued for the `afterEach` above. */
function uploadStore(...args: Parameters<typeof stubUploads>): ReturnType<typeof stubUploads> {
  const store = stubUploads(...args);
  restores.push(store.restore);
  return store;
}

/** Bytes that differ at every offset, so a chunk pasted at the wrong one shows. */
function pattern(length: number, step = 7): Uint8Array {
  return new Uint8Array(length).map((_, at) => (at * step) % 251);
}

describe("withTempDir", () => {
  test("gives the work a private directory and removes it after", async () => {
    let seen: string | undefined;
    const answer = await withTempDir(async (dir) => {
      seen = dir;
      await writeFile(join(dir, "probe"), "x");
      await expect(stat(join(dir, "probe"))).resolves.toBeTruthy();
      return "an upload id";
    });

    // What crosses the scope is the WORK's result, never a path into the scope.
    expect(answer).toBe("an upload id");
    expect(seen).toBeTruthy();
    await expect(stat(seen ?? "")).rejects.toThrow();
  });

  test("removes the directory even when the work throws", async () => {
    // The path that matters: a guest's disk is small, and a step that leaked a
    // directory per FAILED run is the one that fills it.
    let seen: string | undefined;
    const boom = new Error("the conversion failed");
    await expect(
      withTempDir((dir) => {
        seen = dir;
        throw boom;
      }),
    ).rejects.toThrow(boom);
    await expect(stat(seen ?? "")).rejects.toThrow();
  });

  test("sits under the OS temp directory, named `aai-step-` by default", async () => {
    // `join(tmpdir(), …)` rather than a `/tmp` literal — `guard-invariants` rule
    // 11, and on Windows a literal `/tmp/x` is drive-relative and every write
    // there fails with ENOENT.
    let seen = "";
    await withTempDir(async (dir) => {
      seen = dir;
    });
    expect(dirname(seen)).toBe(tmpdir());
    expect(basename(seen).startsWith("aai-step-")).toBe(true);
  });

  test("takes a prefix, which is what a person reading `ls /tmp` sees", async () => {
    let seen = "";
    await withTempDir(
      async (dir) => {
        seen = dir;
      },
      { prefix: "aai-normalize-" },
    );
    expect(basename(seen).startsWith("aai-normalize-")).toBe(true);
  });
});

describe("readUploadToFile", () => {
  test("writes the stored bytes to a path, in order, across many windows", async () => {
    const bytes = pattern(4096);
    uploadStore({ [UPLOAD_ID]: { bytes, name: "call.m4a" } });

    await withTempDir(async (dir) => {
      const path = join(dir, "source");
      // A small window, so the loop really runs four times — at the real 8 MiB
      // one a 4 KB upload is a single pass and proves nothing about the walk.
      const written = await readUploadToFile(UPLOAD_ID, path, { windowBytes: 1024 });
      expect(written).toBe(bytes.byteLength);
      expect(new Uint8Array(await readFile(path))).toEqual(bytes);
    });
  });

  test("defaults the size from uploadInfo, which is what both call sites had", async () => {
    // No `size` passed at all: the templates this replaces each fetched the
    // record a line earlier and threaded it, and a caller that has not is the
    // common case.
    const bytes = pattern(3000, 11);
    uploadStore({ [UPLOAD_ID]: bytes });

    await withTempDir(async (dir) => {
      const path = join(dir, "source");
      const written = await readUploadToFile(UPLOAD_ID, path, { windowBytes: 512 });
      expect(written).toBe(3000);
      expect(new Uint8Array(await readFile(path))).toEqual(bytes);
    });
  });

  test("an empty upload materializes an empty file rather than failing", async () => {
    uploadStore({ [UPLOAD_ID]: new Uint8Array(0) });
    await withTempDir(async (dir) => {
      const path = join(dir, "source");
      expect(await readUploadToFile(UPLOAD_ID, path)).toBe(0);
      expect((await stat(path)).size).toBe(0);
    });
  });

  test("truncates a path that already holds something longer", async () => {
    // `open(path, "w")`, not `"a"`: a retried step writing into the leftovers of
    // its own previous attempt would produce a file with a tail nobody stored.
    uploadStore({ [UPLOAD_ID]: pattern(64) });
    await withTempDir(async (dir) => {
      const path = join(dir, "source");
      await writeFile(path, pattern(4096, 3));
      await readUploadToFile(UPLOAD_ID, path);
      expect((await stat(path)).size).toBe(64);
    });
  });

  test("stops at what ARRIVED when the size overshoots the store", async () => {
    // The streamed-upload case, and the reason the walk advances by `slice.end`
    // rather than by the window it asked for: `readUpload` clamps to the bytes
    // that are there, so a stale size must end the walk rather than stride past
    // the short answer. The returned count is how a caller learns it was short.
    const arrived = pattern(4096, 5);
    uploadStore({ [UPLOAD_ID]: { bytes: arrived, complete: false } });

    await withTempDir(async (dir) => {
      const path = join(dir, "source");
      const written = await readUploadToFile(UPLOAD_ID, path, {
        size: 10 * 1024,
        windowBytes: 1024,
      });
      expect(written).toBe(arrived.byteLength);
      expect(new Uint8Array(await readFile(path))).toEqual(arrived);
    });
  });
});

describe("writeUploadFromFile", () => {
  test("stores the file's real bytes, not a reused buffer", async () => {
    // The aliasing bug, absorbed into this function so it is tested once here
    // instead of being re-explained wherever `writeUpload(fileChunks(p), …)` is
    // written by hand. Verified to CATCH it: deleting the `.slice()` in
    // `fileChunks` fails this test.
    uploadStore({}, { writable: true });
    const bytes = pattern(5000);

    const stored = await withTempDir(async (dir) => {
      const path = join(dir, "audio.pcm");
      await writeFile(path, bytes);
      // A 1 KB window over 5 KB, so there are five reads through ONE buffer.
      // That is what makes the aliasing reachable; the store concatenating the
      // chunks is what makes it visible, since every earlier chunk would then
      // read as the last one.
      return await writeUploadFromFile(path, { windowBytes: 1024 });
    });
    expect(stored.size).toBe(bytes.byteLength);

    // Read back through the store, on a window that does NOT divide either the
    // file or the write window — so a chunk that landed at the wrong offset
    // cannot be hidden by the two strides agreeing.
    await withTempDir(async (dir) => {
      const back = join(dir, "roundtrip");
      expect(await readUploadToFile(stored.id, back, { windowBytes: 997 })).toBe(5000);
      expect(new Uint8Array(await readFile(back))).toEqual(bytes);
    });
  });

  test("passes name and type through, and never the window", async () => {
    // `windowBytes` shares an options bag with the store's metadata, so the rest
    // spread is load-bearing: an upload whose `type` came back as a number is
    // one no browser plays.
    uploadStore({}, { writable: true });

    const stored = await withTempDir(async (dir) => {
      const path = join(dir, "summary.mp3");
      await writeFile(path, pattern(2048));
      return await writeUploadFromFile(path, {
        name: "audit.mp3",
        type: "audio/mpeg",
        windowBytes: 512,
      });
    });

    const info = await uploadInfo(stored.id);
    expect(info.name).toBe("audit.mp3");
    expect(info.type).toBe("audio/mpeg");
    expect(Object.keys(info)).not.toContain("windowBytes");
  });

  test("an empty file stores an empty upload rather than one empty chunk", async () => {
    uploadStore({}, { writable: true });

    const stored = await withTempDir(async (dir) => {
      const path = join(dir, "empty");
      await writeFile(path, new Uint8Array(0));
      return await writeUploadFromFile(path);
    });

    expect(stored.size).toBe(0);
  });

  test("defaults to the documented window, which is 8 MiB", async () => {
    // The default is nameable because both functions take it as an option — the
    // seam that makes their multi-window paths reachable without writing 16 MB
    // to a disk. Pinned so it cannot drift into a value a spec's arithmetic no
    // longer describes.
    expect(STEP_FILE_WINDOW_BYTES).toBe(8 * 1024 * 1024);

    uploadStore({}, { writable: true });
    const stored = await withTempDir(async (dir) => {
      const path = join(dir, "one-pass");
      await writeFile(path, pattern(1024));
      return await writeUploadFromFile(path);
    });
    expect(stored.size).toBe(1024);
  });
});
