// Copyright 2026 the AAI authors. MIT license.
/**
 * Assemble a self-contained Modal deployment directory — `.aai/modal/`.
 *
 * The runtime files are `_target-output.ts`, shared with the Deno emit for the
 * reason that module's doc gives: neither host installs anything, so both need
 * the same three files carried in beside the bundled entry.
 *
 * Modal's own half is the fourth file, `app.py`. It is what makes this target
 * different in kind from the other two — Vercel and Deno are each pointed at a
 * directory and work out the rest, while `modal deploy` RUNS a Python module
 * that declares the image, the app and the function. See `_modal-app.ts`.
 *
 * The `app.py` is written LAST, after the directory it describes exists. That
 * ordering has no failure to point at yet; it is here because the file's
 * `add_local_dir(HERE, …)` is a claim about this directory's contents, and a
 * half-assembled directory is a worse thing to hand a user than a missing one.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { modalAppSource } from "./_modal-app.ts";
import {
  MODAL_APP_FILE,
  MODAL_ENTRY_FILE,
  MODAL_ENTRY_SOURCE,
  MODAL_OUTPUT_DIR,
} from "./_modal-target.ts";
import { type EmitSelfContainedOptions, emitSelfContainedOutput } from "./_target-output.ts";

/** Options for {@link emitModalOutput}. */
export interface EmitModalOutputOptions extends EmitSelfContainedOptions {
  /**
   * The agent's name, which becomes the Modal app name and its secret's.
   *
   * Passed in rather than re-read from the built worker: `executeBuild` has
   * already evaluated the bundle to report the name, and loading it twice would
   * make the emit depend on a second evaluation of the user's own code.
   */
  name: string;
}

/** Write `.aai/modal/` for this project. */
export async function emitModalOutput(cwd: string, options: EmitModalOutputOptions): Promise<void> {
  const { name, ...emitOptions } = options;
  const outputDir = await emitSelfContainedOutput(
    cwd,
    {
      outputDir: MODAL_OUTPUT_DIR,
      entryFile: MODAL_ENTRY_FILE,
      entrySource: MODAL_ENTRY_SOURCE,
      name: "modal",
    },
    emitOptions,
  );

  await fs.writeFile(path.join(outputDir, MODAL_APP_FILE), modalAppSource({ name }), "utf-8");
}
