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
 * The entry is BUNDLED rather than shipped with a `node_modules`. Same call as
 * the worker (`ssr: { noExternal: true }`, `root: cwd`), so it resolves the
 * project's own installed SDK and pulls the runtime, `ws` and `pg` in with it
 * — which is already the arrangement a deployed worker runs under, and it is
 * what makes the function independent of whether the host's install left a
 * usable, hoisted `node_modules` behind.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { invariant } from "@alexkroman1/aai/internal";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";
import { build, type Rollup } from "vite";
import { CLIENT_ARTIFACT_REL, WORKER_ARTIFACT_REL } from "./_artifacts.ts";
import {
  VERCEL_BUILD_CONFIG_SOURCE,
  VERCEL_ENTRY_SOURCE,
  VERCEL_FUNCTION_DIR,
  VERCEL_OUTPUT_DIR,
  VERCEL_STATIC_DIR,
  vercelFunctionConfigSource,
} from "./_build-target.ts";
import { withPreservedNodeEnv } from "./_vite-env.ts";

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
   * Produce the function's `index.mjs`. Defaults to {@link bundleEntry}.
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
  const bundle = options.bundle ?? bundleEntry;
  await fs.writeFile(path.join(functionDir, "index.mjs"), await bundle(cwd), "utf-8");

  for (const rel of RUNTIME_FILES) {
    const from = path.join(cwd, rel);
    if (!(await exists(from))) continue;
    const to = path.join(functionDir, rel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }

  // This project's own built UI when it has one, otherwise the prebuilt default
  // that ships inside `@alexkroman1/aai-ui` — the same choice `resolveClientDir`
  // makes at boot, made once here so both copies agree.
  const clientSource = (await exists(path.join(cwd, CLIENT_ARTIFACT_REL, "index.html")))
    ? path.join(cwd, CLIENT_ARTIFACT_REL)
    : defaultClientDir();
  await fs.cp(clientSource, staticDir, { recursive: true });
  await fs.cp(clientSource, path.join(functionDir, CLIENT_ARTIFACT_REL), { recursive: true });
}

/**
 * Bundle {@link VERCEL_ENTRY_SOURCE} and everything it imports into one ESM
 * file.
 *
 * The entry is written INTO the project rather than a temp directory, because
 * that is what makes `@alexkroman1/aai-cli/start` resolve against the user's
 * install — the deployed server is then the version their lockfile pins, which
 * is the same guarantee `aai publish` gives. Removed in a `finally`: a build
 * that throws must not leave a file that looks authored.
 */
export async function bundleEntry(cwd: string): Promise<string> {
  const entryPath = path.join(cwd, ".aai", "vercel-entry.mjs");
  await fs.mkdir(path.dirname(entryPath), { recursive: true });
  await fs.writeFile(entryPath, VERCEL_ENTRY_SOURCE, "utf-8");

  let result: Awaited<ReturnType<typeof build>>;
  try {
    result = await withPreservedNodeEnv(() =>
      build({
        root: cwd,
        logLevel: "silent",
        configFile: false,
        // Bundle everything except `node:` builtins — see this module's doc.
        ssr: { noExternal: true },
        build: {
          ssr: true,
          lib: { entry: entryPath, formats: ["es"], fileName: "index" },
          target: "node20",
          minify: false,
          write: false,
          rollupOptions: {
            // One file: the `.func` launcher loads `handler` and nothing
            // resolves a sibling chunk relative to it.
            output: { entryFileNames: "[name].mjs", codeSplitting: false },
          },
        },
      }),
    );
  } finally {
    await fs.rm(entryPath, { force: true }).catch(() => undefined);
  }

  const output = Array.isArray(result) ? result[0] : (result as Rollup.RollupOutput);
  invariant(output !== undefined, "vercel.entry.output");
  const chunk = output.output.find((o): o is Rollup.OutputChunk => o.type === "chunk" && o.isEntry);
  invariant(chunk !== undefined, "vercel.entry.chunk", () => ({
    kinds: output.output.map((o) => o.type),
  }));
  return chunk.code;
}

async function exists(target: string): Promise<boolean> {
  return await fs.stat(target).then(
    () => true,
    () => false,
  );
}
