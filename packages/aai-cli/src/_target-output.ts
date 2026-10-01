// Copyright 2026 the AAI authors. MIT license.
/**
 * The SELF-CONTAINED deployment directory — the half two targets share.
 *
 * `deno deploy` uploads a directory and runs one entrypoint in it; `modal
 * deploy` uploads a directory into an image layer and spawns node on one file
 * in it. Neither performs an install, so both emits have the identical job:
 * put beside the bundled entry every file the server opens at RUN time. Each
 * of the three was found by a deployment failing without it, which is the
 * reason this is one module and not a shape each target re-derives —
 * a fourth target must not get to rediscover them.
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
 * **`.env` is deliberately absent**, the same rule the Vercel emit follows:
 * declarations ship, values come from the host (`deno deploy env`, a
 * `modal.Secret`). Copying it would upload a developer's live credentials AND
 * let them outrank what the host was configured with.
 *
 * The nesting is not an accident. `createProjectServer` resolves the worker at
 * `<cwd>/.aai/worker.mjs` and each entry passes its own directory as `cwd`, so
 * the output holds its own `.aai/` — the layout the server already knows,
 * rather than a second one this module would have to teach it.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";
import { CLIENT_ARTIFACT_REL, WORKER_ARTIFACT_REL } from "./_artifacts.ts";
import { bundleTargetEntry, targetPathExists } from "./_target-bundle.ts";

/** Files copied verbatim, each read at RUNTIME by a path no bundler can see. */
const RUNTIME_FILES: readonly string[] = [WORKER_ARTIFACT_REL, ".env.example"];

/** What a self-contained target declares about its own directory. */
export interface SelfContainedTarget {
  /** Where the directory goes, relative to the project root. */
  outputDir: string;
  /** The entry's filename inside it — a contract with whatever the host is pointed at. */
  entryFile: string;
  /** The entry source, bundled into {@link SelfContainedTarget.entryFile}. */
  entrySource: string;
  /** The target's name, for the bundler's temp entry and its diagnostics. */
  name: string;
}

/** Options for {@link emitSelfContainedOutput}. */
export interface EmitSelfContainedOptions {
  /**
   * Produce the entry. Defaults to bundling the target's `entrySource`.
   *
   * Injectable because the ASSEMBLY — which file lands where, and which does
   * not — is a question about a DIRECTORY, and answering it should not cost a
   * rolldown pass over the whole runtime. The bundler's own contract needs a
   * real pass and is asserted in the scenario tier.
   */
  bundle?: (cwd: string) => Promise<string>;
}

/**
 * Write a target's self-contained directory and answer its absolute path.
 *
 * REMOVED first: the directory is uploaded wholesale, so anything an earlier
 * build left in it would be deployed alongside this one.
 *
 * The path comes back so a target with MORE to write — Modal's `app.py` — adds
 * it here rather than recomputing where "here" is.
 */
export async function emitSelfContainedOutput(
  cwd: string,
  target: SelfContainedTarget,
  options: EmitSelfContainedOptions = {},
): Promise<string> {
  const outputDir = path.join(cwd, target.outputDir);
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const bundle =
    options.bundle ?? ((dir: string) => bundleTargetEntry(dir, target.entrySource, target.name));
  await fs.writeFile(path.join(outputDir, target.entryFile), await bundle(cwd), "utf-8");

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

  return outputDir;
}
