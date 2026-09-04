// Copyright 2026 the AAI authors. MIT license.
/**
 * Assemble a PREBUILT Vercel deployment — `.vercel/output/` — from what
 * `aai build` just produced.
 *
 * The argument for the Build Output API over an `api/` entry is in
 * `_build-target.ts` at {@link VERCEL_OUTPUT_DIR}; what this module adds is the
 * consequence of it. A `.func` directory is a directory WE fill, so every file
 * the server reads at runtime is present because it was copied in, and nothing
 * depends on a static tracer following a path it structurally cannot:
 *
 * - **`.aai/worker.mjs`** is loaded through `import(pathToFileURL(...))`
 *   (`start.ts`), which `@vercel/nft` cannot resolve. Under the `api/` shape
 *   the build was green and the function 500'd on its first request with
 *   "No built agent at .aai/worker.mjs".
 * - **`.env.example`** is not documentation here. `resolveServerEnv` treats it
 *   as the DECLARATION of which variables become `ctx.env` (see
 *   `DEPLOY_ENV_FILES`), so a function without it hands every tool an empty
 *   env while the Vercel project has the values set — a failure that looks
 *   like a credential problem and is a packaging one.
 * - **The client** is copied to `static/`, where the CDN serves it, and also
 *   beside the worker, so `resolveClientDir` finds a real directory rather
 *   than reaching into a `node_modules` that the bundle replaced.
 *
 * The entry is BUNDLED rather than shipped with a `node_modules` — see
 * `_target-bundle.ts`, which every target that emits an entry shares.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";
import { CLIENT_ARTIFACT_REL, WORKER_ARTIFACT_REL } from "./_artifacts.ts";
import {
  VERCEL_BUILD_CONFIG_SOURCE,
  VERCEL_ENTRY_SOURCE,
  VERCEL_FUNCTION_DIR,
  VERCEL_OUTPUT_DIR,
  VERCEL_STATIC_DIR,
  vercelFunctionConfigSource,
} from "./_build-target.ts";
import { bundleTargetEntry, targetPathExists } from "./_target-bundle.ts";

/**
 * Files copied verbatim into the function, each one read at RUNTIME by a path
 * no bundler can see. A missing one is skipped rather than fatal.
 *
 * **`.env` is deliberately NOT here.** `resolveServerEnv` reads
 * {@link DEPLOY_ENV_FILES} — `.env.example` then `.env` — but only the first is
 * a DECLARATION; the second holds a developer's own keys, and copying it would
 * bake them into a deployment artifact and let them silently win over the
 * values set in the Vercel project. Declarations ship, values come from the
 * platform environment. Verified by building the `simple` template: a local
 * `.env` with live credentials landed in the function until this list dropped
 * it.
 */
const RUNTIME_FILES: readonly string[] = [WORKER_ARTIFACT_REL, ".env.example"];

/** Options for {@link emitVercelOutput}. */
export interface EmitVercelOutputOptions {
  /**
   * Produce the function's `index.mjs`. Defaults to bundling {@link VERCEL_ENTRY_SOURCE}.
   *
   * Injectable so the ASSEMBLY — which file lands where, and which does not —
   * can be asserted without a ~15s rolldown pass over the whole runtime. The
   * bundle has its own contract and its own (scenario-tier) test; what this
   * seam separates is a question about a directory from a question about a
   * bundler.
   */
  bundle?: (cwd: string) => Promise<string>;
}

/**
 * Write `.vercel/output/` for this project.
 *
 * The directory is REMOVED first. It is not addressed by content, so a
 * function or a static asset left by an earlier build with a different shape
 * would be deployed alongside this one — and `vercel deploy --prebuilt`
 * uploads whatever is there.
 */
export async function emitVercelOutput(
  cwd: string,
  options: EmitVercelOutputOptions = {},
): Promise<void> {
  const outputDir = path.join(cwd, VERCEL_OUTPUT_DIR);
  const functionDir = path.join(cwd, VERCEL_FUNCTION_DIR);
  const staticDir = path.join(cwd, VERCEL_STATIC_DIR);

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(functionDir, { recursive: true });

  await fs.writeFile(path.join(outputDir, "config.json"), VERCEL_BUILD_CONFIG_SOURCE, "utf-8");
  await fs.writeFile(
    path.join(functionDir, ".vc-config.json"),
    vercelFunctionConfigSource(),
    "utf-8",
  );
  const bundle =
    options.bundle ?? ((dir: string) => bundleTargetEntry(dir, VERCEL_ENTRY_SOURCE, "vercel"));
  await fs.writeFile(path.join(functionDir, "index.mjs"), await bundle(cwd), "utf-8");

  for (const rel of RUNTIME_FILES) {
    const from = path.join(cwd, rel);
    if (!(await targetPathExists(from))) continue;
    const to = path.join(functionDir, rel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }

  // This project's own built UI when it has one, otherwise the prebuilt default
  // that ships inside `@alexkroman1/aai-ui` — the same choice `resolveClientDir`
  // makes at boot, made once here so both copies agree.
  const clientSource = (await targetPathExists(path.join(cwd, CLIENT_ARTIFACT_REL, "index.html")))
    ? path.join(cwd, CLIENT_ARTIFACT_REL)
    : defaultClientDir();
  await fs.cp(clientSource, staticDir, { recursive: true });
  await fs.cp(clientSource, path.join(functionDir, CLIENT_ARTIFACT_REL), { recursive: true });
}
