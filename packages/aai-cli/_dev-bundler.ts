// Copyright 2025 the AAI authors. MIT license.

/**
 * Incremental worker builds for `aai dev`.
 *
 * The deploy path (`buildWorker` in `worker-bundler.ts`) is a from-scratch
 * Vite/Rollup pass — right for a one-shot `aai deploy`, but 1–3 s per save
 * when the dev watcher runs it on every change. This module keeps a
 * long-lived esbuild `context()` whose `rebuild()` reuses the previous
 * build's work, cutting rebuilds to tens of ms. Deploy keeps Vite untouched,
 * so nothing that ships is produced by esbuild.
 *
 * Parity with `buildWorker` where it matters for dev:
 *
 * - single-file ESM output, unminified (dev builds never minify);
 * - `node:` builtins external (esbuild's `platform: "node"`), everything
 *   else — zod, workspace deps, local imports — bundled in;
 * - `.md` imports resolve to their raw text (esbuild's `text` loader is
 *   `rawMdPlugin`'s transform), and Vite-style `?raw` suffix imports are
 *   honored via `rawSuffixPlugin` below.
 *
 * Known dev/deploy differences, accepted: Rollup and esbuild can disagree on
 * `exports`-condition ordering for exotic dual-format packages, and Vite's
 * lib build applies `define`/`import.meta.env` replacements esbuild does not.
 * When a rebuild fails for anything other than a compile error in the agent's
 * code, the caller falls back to the cold Vite path (see `_dev-server.ts`),
 * so an esbuild-specific resolution gap degrades to the old slow-but-correct
 * behavior rather than a broken dev server.
 *
 * esbuild does not touch `process.env` (verified: no NODE_ENV write in its
 * JS API), so the `withPreservedNodeEnv` wrapper Vite builds need is not
 * required here.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { BuildContext, Plugin } from "esbuild";

/**
 * Vite serves `import x from "./file?raw"` as the file's text. esbuild treats
 * the suffix as part of the filename, so resolve it explicitly and load the
 * real file with the `text` loader.
 */
const rawSuffixPlugin: Plugin = {
  name: "raw-suffix",
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.slice(0, -"?raw".length)),
      namespace: "aai-raw",
    }));
    build.onLoad({ filter: /.*/, namespace: "aai-raw" }, async (args) => ({
      contents: await fs.readFile(args.path, "utf8"),
      loader: "text",
    }));
  },
};

/**
 * True for esbuild build failures — compile/resolve errors in the code being
 * built (the esbuild analog of a Rollup diagnostic). Anything else coming out
 * of `rebuild()` is an esbuild-infrastructure problem, which callers treat as
 * "fall back to the cold Vite path" rather than "the user's code is broken".
 */
export function isEsbuildBuildFailure(err: unknown): boolean {
  return (
    err instanceof Error && "errors" in err && Array.isArray((err as { errors: unknown }).errors)
  );
}

/** Long-lived incremental builder for one agent directory. */
export type DevWorkerBuilder = {
  /** Build (or incrementally rebuild) the worker ESM for `agent.ts`. */
  build(): Promise<string>;
  /** Release the esbuild context. Safe to call more than once. */
  dispose(): Promise<void>;
};

/**
 * Create an incremental dev builder for the agent at `cwd`.
 *
 * The context is created lazily on first `build()` and kept across calls —
 * that reuse is the entire point. A rebuild that fails for a non-compile
 * reason drops the context so the next call starts from a clean one.
 */
export function createDevWorkerBuilder(cwd: string): DevWorkerBuilder {
  let ctx: BuildContext | undefined;

  async function ensureContext(): Promise<BuildContext> {
    if (ctx) return ctx;
    const { context } = await import("esbuild");
    ctx = await context({
      entryPoints: [path.join(cwd, "agent.ts")],
      absWorkingDir: cwd,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      write: false,
      outfile: "worker.js",
      minify: false,
      logLevel: "silent",
      loader: { ".md": "text" },
      plugins: [rawSuffixPlugin],
    });
    return ctx;
  }

  return {
    async build(): Promise<string> {
      const active = await ensureContext();
      let result: Awaited<ReturnType<BuildContext["rebuild"]>>;
      try {
        result = await active.rebuild();
      } catch (err) {
        if (!isEsbuildBuildFailure(err)) {
          // Context state is unknown after an infra failure — drop it so the
          // next build starts fresh instead of failing forever.
          ctx = undefined;
          await active.dispose().catch(() => undefined);
        }
        throw err;
      }
      const file = result.outputFiles?.[0];
      if (!file) throw new Error("esbuild produced no output for agent.ts");
      return file.text;
    },

    async dispose(): Promise<void> {
      const active = ctx;
      ctx = undefined;
      await active?.dispose().catch(() => undefined);
    },
  };
}
