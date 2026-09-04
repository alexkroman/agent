// Copyright 2026 the AAI authors. MIT license.
/**
 * One spec, for the failure that took three hours to name: a step streaming an
 * upload to a local file runs out of DISK, and what the run records is
 * `ENOSPC: no space left on device, write` — a sentence that names neither the
 * directory that filled, nor how much it holds, nor how much was being asked of
 * it.
 *
 * It is a file of its own because it MOCKS `open`, and `step-files.test.ts`
 * deliberately does not: that suite's whole argument is that only real bytes on
 * a real filesystem catch the buffer-reuse bug behind `writeUploadFromFile`. A
 * `vi.mock` factory is hoisted to the whole module, so the two cannot share one.
 *
 * The mock is also the only PORTABLE way to reach this branch. A full
 * filesystem is `/dev/full` on Linux and nothing at all on darwin, and the real
 * trigger is a capacity — measured at **512 MiB**, the tmpfs a guest microVM
 * mounts at `/tmp` — which no fixture may reproduce by size.
 */

import { afterEach, expect, test, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    async open(...args: Parameters<typeof real.open>) {
      const handle = await real.open(...args);
      if (!full) return handle;
      return {
        ...handle,
        async write(): Promise<never> {
          // The shape node throws: an `Error` carrying `code`, which is the only
          // thing a caller can recognise it by.
          throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
            code: "ENOSPC",
          });
        },
        async close(): Promise<void> {
          await handle.close();
        },
      };
    },
  };
});

/** Whether the mocked `open` hands back a handle whose every write is ENOSPC. */
let full = false;

const { readUploadToFile, withTempDir } = await import("./step-files.ts");
const { stubUploads } = await import("../sdk/testing-uploads.ts");

const UPLOAD_ID = "upl_recording";

afterEach(() => {
  full = false;
});

test("a destination that runs out of space names the directory and the byte counts", async () => {
  const store = stubUploads({
    [UPLOAD_ID]: { bytes: new Uint8Array(4096), name: "podcast.wav" },
  });
  try {
    await withTempDir(async (dir) => {
      full = true;
      // What the run journaled was the bare `ENOSPC` sentence, so a reader had
      // no way to learn that `os.tmpdir()` in that container is a 512 MiB RAM
      // disk while `/` had 3.9 GB free. Every one of those facts is knowable
      // HERE — the path, the ask, and what the mount holds.
      const failure = await readUploadToFile(UPLOAD_ID, `${dir}/source`, { size: 4096 }).catch(
        (err: unknown) => err,
      );
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toMatch(/ran out of space/i);
      expect(message).toContain(`${dir}/source`);
      // The size asked for, and the mount's own capacity beside it. `4 KB` is
      // `formatBytes(4096)`; the capacity is the machine's, so only its shape
      // can be asserted.
      expect(message).toContain("4 KB");
      expect(message).toMatch(/the mount holding it is .+, .+ free/);
      // The original survives as `cause`, so `code` is still readable by anything
      // that wants to branch on it.
      expect((failure as Error).cause).toMatchObject({ code: "ENOSPC" });
    });
  } finally {
    store.restore();
  }
});
