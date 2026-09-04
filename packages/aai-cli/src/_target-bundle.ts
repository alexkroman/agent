// Copyright 2026 the AAI authors. MIT license.
/**
 * Bundling a deployment target's ENTRY into one self-contained ESM file.
 *
 * Shared by every target that emits one, because the reason is the same at
 * each: the entry imports `@alexkroman1/aai-cli/start`, and what a host does
 * with the module graph behind that import differs in ways that are all bad.
 *
 * - **Vercel** traces it with `@vercel/nft`, which cannot follow the dynamic
 *   `import(pathToFileURL(...))` that loads the worker.
 * - **Deno Deploy** caches the dependency graph of the PACKAGE rather than of
 *   the import, and `@alexkroman1/aai-cli`'s dependencies are a build
 *   toolchain — vite, rolldown and the rest. Measured: the build exceeded its
 *   1024 MiB memory limit at "Caching dependencies for the entrypoint" before
 *   it reached any code of ours.
 *
 * A bundle removes the question. The host resolves nothing, installs nothing,
 * and what runs is what the project's own lockfile pinned.
 *
 * The entry is written INTO the project rather than a temp directory, because
 * that is what makes `@alexkroman1/aai-cli/start` resolve against the user's
 * install. Removed in a `finally`: a build that throws must not leave a file
 * that looks authored.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { invariant } from "@alexkroman1/aai/internal";
import { build, type Rollup } from "vite";
import { withPreservedNodeEnv } from "./_vite-env.ts";

/** Bundle `source` as if it were a module in `cwd`, and answer the code. */
export async function bundleTargetEntry(
  cwd: string,
  source: string,
  name: string,
): Promise<string> {
  const entryPath = path.join(cwd, ".aai", `${name}-entry.mjs`);
  await fs.mkdir(path.dirname(entryPath), { recursive: true });
  await fs.writeFile(entryPath, source, "utf-8");

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
          lib: { entry: entryPath, formats: ["es"], fileName: name },
          target: "node20",
          minify: false,
          write: false,
          rollupOptions: {
            // One file: a host loads the entry and nothing resolves a sibling
            // chunk relative to it.
            output: { entryFileNames: "[name].mjs", codeSplitting: false },
          },
        },
      }),
    );
  } finally {
    await fs.rm(entryPath, { force: true }).catch(() => undefined);
  }

  const output = Array.isArray(result) ? result[0] : (result as Rollup.RollupOutput);
  invariant(output !== undefined, "target.entry.output", () => ({ name }));
  const chunk = output.output.find((o): o is Rollup.OutputChunk => o.type === "chunk" && o.isEntry);
  invariant(chunk !== undefined, "target.entry.chunk", () => ({
    name,
    kinds: output.output.map((o) => o.type),
  }));
  return chunk.code;
}

/** Whether a path exists — the check every emit makes of an optional file. */
export async function targetPathExists(target: string): Promise<boolean> {
  return await fs.stat(target).then(
    () => true,
    () => false,
  );
}
