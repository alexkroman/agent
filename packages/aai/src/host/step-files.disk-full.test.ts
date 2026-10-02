// Copyright 2026 the AAI authors. MIT license.
/**
 * One spec, for the failure that took three hours to name: a step streaming an
 * upload to a local file runs out of DISK, and what the run records is
 * `ENOSPC: no space left on device, write` — a sentence that names neither the
 * directory that filled, nor how much it holds, nor how much was being asked of
 * it.
 *
 * It is a file of its own because it FAKES the write, and `step-files.test.ts`
 * deliberately does not: that suite's whole argument is that only real bytes on
 * a real filesystem catch the buffer-reuse bug behind `writeUploadFromFile`.
 * The handle here is a real one, opened through the module's `stepFilesFs`
 * seam, with only its `write` replaced.
 *
 * The fake is also the only PORTABLE way to reach this branch. A full
 * filesystem is `/dev/full` on Linux and nothing at all on darwin, and the real
 * trigger is a capacity — measured at **512 MiB**, the tmpfs a guest microVM
 * mounts at `/tmp` — which no fixture may reproduce by size.
 */

import { open } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { stubUploads } from "../sdk/testing-uploads.ts";
import { readUploadToFile, stepFilesFs, withTempDir } from "./step-files.ts";

/** From here on, every file the module opens is real but refuses every write with ENOSPC. */
function fillTheDisk(): void {
  vi.spyOn(stepFilesFs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    // The shape node throws: an `Error` carrying `code`, which is the only
    // thing a caller can recognise it by.
    vi.spyOn(handle, "write").mockRejectedValue(
      Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }),
    );
    return handle;
  });
}

const UPLOAD_ID = "upl_recording";

test("a destination that runs out of space names the directory and the byte counts", async () => {
  const store = stubUploads({
    [UPLOAD_ID]: { bytes: new Uint8Array(4096), name: "podcast.wav" },
  });
  try {
    await withTempDir(async (dir) => {
      fillTheDisk();
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
