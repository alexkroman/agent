// Copyright 2026 the AAI authors. MIT license.
/**
 * Assemble a self-contained Deno Deploy directory — `.aai/deno/`.
 *
 * The assembly is `_target-output.ts`, shared with the Modal emit: both hosts
 * upload a directory and run one file in it with no install step, so the set of
 * runtime files that have to travel is the same set, and that module's doc
 * carries which three and the deployment failure that found each.
 *
 * Deno's own half is two files. The ENTRY it bundles — see `DENO_ENTRY_SOURCE`
 * — and a **`deno.json`** beside it (see {@link DENO_CONFIG_SOURCE}), so the
 * directory describes how to run itself and no command against it has to
 * re-supply `--entrypoint`.
 *
 * That second file is also the answer to "why is this not just the shared
 * emit": both self-contained targets need a way to say what to RUN, and the two
 * hosts take it differently — Deno reads a config it already understands, while
 * Modal has no descriptor at all and needs a generated Python module.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  DENO_CONFIG_FILE,
  DENO_CONFIG_SOURCE,
  DENO_ENTRY_FILE,
  DENO_ENTRY_SOURCE,
  DENO_OUTPUT_DIR,
} from "./_deno-target.ts";
import { type EmitSelfContainedOptions, emitSelfContainedOutput } from "./_target-output.ts";

/** Options for {@link emitDenoOutput}. */
export type EmitDenoOutputOptions = EmitSelfContainedOptions;

/** Write `.aai/deno/` for this project. */
export async function emitDenoOutput(
  cwd: string,
  options: EmitDenoOutputOptions = {},
): Promise<void> {
  const outputDir = await emitSelfContainedOutput(
    cwd,
    {
      outputDir: DENO_OUTPUT_DIR,
      entryFile: DENO_ENTRY_FILE,
      entrySource: DENO_ENTRY_SOURCE,
      name: "deno",
    },
    options,
  );

  // Beside the entry, never instead of it: `--entrypoint` still overrides, so
  // this only removes the need to pass one.
  await fs.writeFile(path.join(outputDir, DENO_CONFIG_FILE), DENO_CONFIG_SOURCE, "utf-8");
}
