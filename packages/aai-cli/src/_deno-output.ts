// Copyright 2026 the AAI authors. MIT license.
/**
 * Assemble a self-contained Deno Deploy directory — `.aai/deno/`.
 *
 * `deno deploy` uploads a DIRECTORY and runs one entrypoint in it, with no
 * install step of its own once the entry is bundled. So the emit's whole job
 * is to put beside that entry every file the server opens at run time, and
 * each of the three was found by a deployment failing without it:
 *
 * - **`.aai/worker.mjs`**, loaded through `import(pathToFileURL(...))`. Bundling
 *   cannot inline it and nothing else would carry it.
 * - **The browser client.** `resolveClientDir` falls back to `defaultClientDir()`,
 *   which is `require.resolve("@alexkroman1/aai-ui/package.json")` — a lookup
 *   with no `node_modules` to answer it. A bundled deployment died at boot on
 *   exactly that until the prebuilt UI was copied in.
 * - **`.env.example`**, which DECLARES which variables become `ctx.env`. Without
 *   it every tool sees an empty env while the platform has the values set.
 *
 * A **`deno.json`** is written beside the entry as well — see
 * {@link DENO_CONFIG_SOURCE} — so the directory describes how to run itself and
 * no command against it has to re-supply `--entrypoint`.
 *
 * **`.env` is deliberately absent**, the same rule the Vercel emit follows:
 * declarations ship, values come from `deno deploy env`.
 *
 * The nesting is not an accident. `createProjectServer` resolves the worker at
 * `<cwd>/.aai/worker.mjs` and the entry passes its own directory as `cwd`, so
 * the output holds its own `.aai/` — the layout the server already knows,
 * rather than a second one this module would have to teach it.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";
import { CLIENT_ARTIFACT_REL, WORKER_ARTIFACT_REL } from "./_artifacts.ts";
import {
  DENO_CONFIG_FILE,
  DENO_CONFIG_SOURCE,
  DENO_ENTRY_FILE,
  DENO_ENTRY_SOURCE,
  DENO_OUTPUT_DIR,
} from "./_build-target.ts";
import { bundleTargetEntry, targetPathExists } from "./_target-bundle.ts";

/** Files copied verbatim, each read at RUNTIME by a path no bundler can see. */
const RUNTIME_FILES: readonly string[] = [WORKER_ARTIFACT_REL, ".env.example"];

/** Options for {@link emitDenoOutput}. */
export interface EmitDenoOutputOptions {
  /**
   * Produce the entry. Defaults to bundling {@link DENO_ENTRY_SOURCE}.
   *
   * Injectable for the same reason the Vercel emit's is: the ASSEMBLY — which
   * file lands where, and which does not — is a question about a directory,
   * and answering it should not cost a rolldown pass over the whole runtime.
   */
  bundle?: (cwd: string) => Promise<string>;
}

/**
 * Write `.aai/deno/` for this project.
 *
 * REMOVED first: the directory is uploaded wholesale, so anything an earlier
 * build left in it would be deployed alongside this one.
 */
export async function emitDenoOutput(
  cwd: string,
  options: EmitDenoOutputOptions = {},
): Promise<void> {
  const outputDir = path.join(cwd, DENO_OUTPUT_DIR);
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const bundle =
    options.bundle ?? ((dir: string) => bundleTargetEntry(dir, DENO_ENTRY_SOURCE, "deno"));
  await fs.writeFile(path.join(outputDir, DENO_ENTRY_FILE), await bundle(cwd), "utf-8");

  // Beside the entry, never instead of it: `--entrypoint` still overrides, so
  // this only removes the need to pass one.
  await fs.writeFile(path.join(outputDir, DENO_CONFIG_FILE), DENO_CONFIG_SOURCE, "utf-8");

  for (const rel of RUNTIME_FILES) {
    const from = path.join(cwd, rel);
    if (!(await targetPathExists(from))) continue;
    const to = path.join(outputDir, rel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }

  // This project's own built UI when it has one, otherwise the prebuilt default
  // — the same choice `resolveClientDir` makes at boot, made once here so the
  // deployment and the server cannot disagree about which UI it serves.
  const clientSource = (await targetPathExists(path.join(cwd, CLIENT_ARTIFACT_REL, "index.html")))
    ? path.join(cwd, CLIENT_ARTIFACT_REL)
    : defaultClientDir();
  await fs.cp(clientSource, path.join(outputDir, CLIENT_ARTIFACT_REL), { recursive: true });
}
