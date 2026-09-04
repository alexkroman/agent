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
 * `stepReadUpload`/`stepWriteUpload` read a process-wide slot rather than dialling
 * anything, so a spec supplies its own bytes and the code under test is
 * unchanged. `stubUploads` is imported from its own module rather than from
 * `sdk/testing.ts`; the barrel would work equally well and this is the narrower
 * graph.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { publishUploadReader, stepUploadInfo } from "../sdk/step-uploads.ts";
import { stubUploads } from "../sdk/testing-uploads.ts";
import {
  readUploadToFile,
  STEP_FILE_READ_CONCURRENCY,
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

/**
 * A store whose reads are OBSERVABLE — how many were in flight at once, and in
 * what order they were asked for.
 *
 * `stubUploads` answers every read from an already-resolved promise, which makes
 * both properties this file has to check unmeasurable: the fan-out settles each
 * window before the next slot has anything to overlap with, so concurrency reads
 * as 1 whatever the code does. Each read here resolves on a macrotask instead,
 * which is enough for the whole width to be outstanding at once and is still
 * deterministic — nothing is racing a deadline.
 *
 * `short` stages the case the fan-out has to survive on a COMPLETE file: a store
 * answering a window with fewer bytes than the range it was handed, for reasons
 * of its own. `stepReadUpload` would not clamp here — `info.complete` is true and its
 * `size` covers the file — so the shortness is visible only in the bytes.
 */
function watchedStore(
  bytes: Uint8Array,
  opts: { short?: { start: number; length: number } | undefined } = {},
): { maxInFlight: () => number; starts: () => number[] } {
  let inFlight = 0;
  let peak = 0;
  const starts: number[] = [];
  publishUploadReader({
    info: (id) =>
      Promise.resolve({ id, name: "", type: "", size: bytes.byteLength, complete: true }),
    read: (_id, start, end) => {
      starts.push(start);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const stop = opts.short?.start === start ? start + opts.short.length : end;
      return new Promise<Uint8Array>((resolve) => {
        setTimeout(() => {
          inFlight -= 1;
          resolve(bytes.subarray(start, stop));
        }, 0);
      });
    },
  });
  restores.push(() => publishUploadReader(undefined));
  return { maxInFlight: () => peak, starts: () => [...starts] };
}

/**
 * A store that HOLDS every read until the spec releases it, so a spec decides the
 * order the windows land in.
 *
 * The out-of-order case cannot be staged any other way: with a real store the
 * order is a race, and asserting on a race is how a spec passes for the wrong
 * reason. Here the fan-out is stopped with its whole width outstanding, and the
 * spec resolves them LAST FIRST.
 */
function heldStore(bytes: Uint8Array): {
  pending: Array<{ start: number; release: () => void }>;
} {
  const pending: Array<{ start: number; release: () => void }> = [];
  publishUploadReader({
    info: (id) =>
      Promise.resolve({ id, name: "", type: "", size: bytes.byteLength, complete: true }),
    read: (_id, start, end) => {
      const { promise, resolve } = Promise.withResolvers<Uint8Array>();
      pending.push({ start, release: () => resolve(bytes.subarray(start, end)) });
      return promise;
    },
  });
  restores.push(() => publishUploadReader(undefined));
  return { pending };
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

  test("defaults the size from stepUploadInfo, which is what both call sites had", async () => {
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
    // rather than by the window it asked for: `stepReadUpload` clamps to the bytes
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

  // The gap the test above only LOOKS like it covers: it passes a size, so the
  // walk can come back short and say so. Defaulting the size instead reads the
  // upload's `size`, which is the contiguous PREFIX — so the count returned
  // equalled the prefix by construction and the "a caller polling a streamed
  // upload has to notice" contract could not fire. A truncated local file then
  // goes to ffmpeg, and a run reports a transcript of most of a recording.
  test("REFUSES to default the size off an upload that is still arriving", async () => {
    const arrived = pattern(4096, 5);
    uploadStore({ [UPLOAD_ID]: { bytes: arrived, complete: false } });

    await withTempDir(async (dir) => {
      const path = join(dir, "source");
      await expect(readUploadToFile(UPLOAD_ID, path, { windowBytes: 1024 })).rejects.toMatchObject({
        name: "UploadIncompleteError",
        retryable: false,
      });
    });
  });

  test("an explicit size still reads the prefix — the caller has said what it wants", async () => {
    // The other half of the same decision: `size` MEANS "I have already read the
    // record", so passing one moves the completeness judgement to the caller,
    // which is what lets a polling body copy the windows that have landed.
    const arrived = pattern(2048, 5);
    uploadStore({ [UPLOAD_ID]: { bytes: arrived, complete: false } });

    await withTempDir(async (dir) => {
      const path = join(dir, "source");
      expect(await readUploadToFile(UPLOAD_ID, path, { size: 2048, windowBytes: 512 })).toBe(2048);
    });
  });
});

describe("readUploadToFile — the windows are read concurrently", () => {
  test("produces the same file the serial walk does, across many windows", async () => {
    // The property that makes the fan-out substitutable at all: same bytes, same
    // length, whatever order the windows landed in. Both halves run against one
    // store, so nothing but the path taken differs.
    const bytes = pattern(4096, 13);
    uploadStore({ [UPLOAD_ID]: bytes });

    await withTempDir(async (dir) => {
      const serial = join(dir, "serial");
      const concurrent = join(dir, "concurrent");
      // `size` passed is the serial walk; omitted is the fan-out.
      expect(await readUploadToFile(UPLOAD_ID, serial, { size: 4096, windowBytes: 1024 })).toBe(
        4096,
      );
      expect(await readUploadToFile(UPLOAD_ID, concurrent, { windowBytes: 1024 })).toBe(4096);
      expect(new Uint8Array(await readFile(concurrent))).toEqual(
        new Uint8Array(await readFile(serial)),
      );
      expect(new Uint8Array(await readFile(concurrent))).toEqual(bytes);
    });
  });

  test("really does overlap its reads, which is the whole point", async () => {
    // Without this the rest of the suite passes over a `for` loop. Four windows
    // at the default width, so the ceiling is reachable and the assertion is
    // about the shape rather than about hitting exactly 4.
    const store = watchedStore(pattern(4096, 3));
    await withTempDir(async (dir) => {
      expect(await readUploadToFile(UPLOAD_ID, join(dir, "source"), { windowBytes: 1024 })).toBe(
        4096,
      );
    });
    expect(store.maxInFlight()).toBeGreaterThan(1);
    expect(store.maxInFlight()).toBeLessThanOrEqual(STEP_FILE_READ_CONCURRENCY);
  });

  test("honours an explicit concurrency, and 1 is the serial shape", async () => {
    const store = watchedStore(pattern(4096, 3));
    await withTempDir(async (dir) => {
      await readUploadToFile(UPLOAD_ID, join(dir, "source"), {
        windowBytes: 1024,
        concurrency: 2,
      });
    });
    expect(store.maxInFlight()).toBe(2);

    const one = watchedStore(pattern(4096, 3));
    await withTempDir(async (dir) => {
      await readUploadToFile(UPLOAD_ID, join(dir, "source"), {
        windowBytes: 1024,
        concurrency: 1,
      });
    });
    expect(one.maxInFlight()).toBe(1);
  });

  test("writes the right file when the windows land OUT OF ORDER", async () => {
    // The case a fan-out over one file exists to survive, and the reason the
    // writes are positional: window 3 finishing first must not put its bytes at
    // offset 0. Staged rather than raced — every read is held until all four are
    // outstanding, then released last-first.
    const bytes = pattern(4096, 17);
    const store = heldStore(bytes);

    await withTempDir(async (dir) => {
      const path = join(dir, "source");
      const walk = readUploadToFile(UPLOAD_ID, path, {
        windowBytes: 1024,
      });
      await vi.waitFor(() => expect(store.pending.length).toBe(4));
      expect(store.pending.map((one) => one.start)).toEqual([0, 1024, 2048, 3072]);
      for (const read of [...store.pending].reverse()) read.release();

      expect(await walk).toBe(4096);
      expect(new Uint8Array(await readFile(path))).toEqual(bytes);
    });
  });

  test("a short window answers the CONTIGUOUS PREFIX and leaves no hole on disk", async () => {
    // A complete upload whose store answers the second window short. Windows 3
    // and 4 land in full and are written at their own offsets, so the count must
    // NOT be the sum of what was written — that number would name a length whose
    // first bytes include a gap nobody stored. It is the prefix, and the file is
    // cut back to it, so neither the answer nor the bytes claim the hole is not
    // there.
    const bytes = pattern(4096, 23);
    watchedStore(bytes, { short: { start: 1024, length: 300 } });

    await withTempDir(async (dir) => {
      const path = join(dir, "source");
      const written = await readUploadToFile(UPLOAD_ID, path, {
        windowBytes: 1024,
      });
      expect(written).toBe(1324);
      expect((await stat(path)).size).toBe(1324);
      expect(new Uint8Array(await readFile(path))).toEqual(bytes.subarray(0, 1324));
    });
  });

  test("an empty first window answers 0, however much landed behind it", async () => {
    const bytes = pattern(4096, 29);
    watchedStore(bytes, { short: { start: 0, length: 0 } });

    await withTempDir(async (dir) => {
      const path = join(dir, "source");
      expect(await readUploadToFile(UPLOAD_ID, path, { windowBytes: 1024 })).toBe(0);
      expect((await stat(path)).size).toBe(0);
    });
  });

  test("a passed `size` still walks one window at a time, and still stops short", async () => {
    // The path that may not fan out: `size` means the caller is judging
    // completeness itself, which it can only do if it sees the windows in order.
    // A store that comes back short at window two must end the walk THERE — a
    // fan-out would have already read the rest.
    const bytes = pattern(4096, 31);
    const store = watchedStore(bytes, { short: { start: 1024, length: 300 } });

    await withTempDir(async (dir) => {
      const path = join(dir, "source");
      const written = await readUploadToFile(UPLOAD_ID, path, {
        size: 4096,
        windowBytes: 1024,
        // Named and ignored: the option is read only on the complete-file path.
        concurrency: 4,
      });
      // The serial walk advances by the `end` the read echoes back rather than by
      // the bytes, so a store answering short inside its own range is the one
      // shape it does not catch — what it does catch, and what this asserts, is
      // that it never has more than one window outstanding.
      expect(written).toBeLessThanOrEqual(4096);
      expect(store.maxInFlight()).toBe(1);
      expect(store.starts()).toEqual([0, 1024, 2048, 3072]);
    });
  });

  test("stops the walk at the first window a still-arriving upload cannot fill", async () => {
    // The same serial contract through the real clamp rather than a rigged store:
    // `stepReadUpload` cuts the window to what has ARRIVED, and the walk must stop at
    // that answer instead of striding a whole window past it.
    const arrived = pattern(2500, 5);
    uploadStore({ [UPLOAD_ID]: { bytes: arrived, complete: false } });

    await withTempDir(async (dir) => {
      const path = join(dir, "source");
      const written = await readUploadToFile(UPLOAD_ID, path, {
        size: 8192,
        windowBytes: 1024,
      });
      expect(written).toBe(2500);
      expect(new Uint8Array(await readFile(path))).toEqual(arrived);
    });
  });
});

describe("writeUploadFromFile", () => {
  test("stores the file's real bytes, not a reused buffer", async () => {
    // The aliasing bug, absorbed into this function so it is tested once here
    // instead of being re-explained wherever `stepWriteUpload(fileChunks(p), …)` is
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

    const info = await stepUploadInfo(stored.id);
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
