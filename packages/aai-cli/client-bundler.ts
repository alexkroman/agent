// Copyright 2025 the AAI authors. MIT license.

/**
 * Client SPA bundling — the one implementation of "turn a `client.tsx` into
 * deployable `clientFiles`".
 *
 * Public (no `_` prefix) because the platform's browser studio reuses it: a
 * studio workspace is materialized to a directory and built through this same
 * function, so a UI published from the browser is byte-identical to one
 * deployed with `aai deploy`. Keep it that way — a second client bundler is
 * how the two paths would silently drift.
 *
 * The studio differs from a CLI project in two ways, hence the options:
 * it has no `vite.config.ts` to supply React/Tailwind plugins, and its files
 * are untrusted so any config the workspace *does* contain must be ignored.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { isTextAssetPath } from "@alexkroman1/aai";
import { build, type PluginOption } from "vite";
import { writeTempHtml } from "./_default-html.ts";
import { fileExists } from "./_utils.ts";
import { withPreservedNodeEnv } from "./_vite-env.ts";

export type BuildClientOptions = {
  /**
   * Plugins to inject instead of relying on the project's `vite.config.ts`
   * (React + Tailwind for the studio, whose workspace has neither).
   */
  plugins?: PluginOption[];
  /**
   * `false` ignores any `vite.config.ts` under `cwd`. The studio passes this:
   * a Vite config is executable code, and workspace files are untrusted.
   */
  configFile?: false;
  /** Build output directory, relative to `cwd`. */
  outDir?: string;
};

const DEFAULT_OUT_DIR = ".aai/client";

/**
 * Packages resolved from the build root rather than from whichever
 * `node_modules` happens to sit above the importing file.
 *
 * `@alexkroman1/aai-ui` declares React as a **peer** dependency — "my consumer
 * supplies it" — but a bundler resolves the bare `react/jsx-runtime` import
 * inside `aai-ui/dist/**` from that file's own real path, not from the
 * consumer's. In the studio's case the two differ: the workspace scratch dir
 * (the build root, under `aai-server`, which owns the React dependency) is
 * nowhere above `packages/aai-ui/dist`, and the production image installs prod
 * deps only, so aai-ui's own devDependency copy of React is pruned there.
 * The result was a publish that failed with *"Rolldown failed to resolve
 * import react/jsx-runtime"* while every local build passed.
 *
 * Deduping states the peer contract in terms the bundler enforces, and it is
 * what a React app wants anyway: two copies of React in one bundle break
 * hooks. Guarded by `client-bundler.test.ts` and, for the half that has to
 * hold in the image, `aai-server/dockerfile-packaging.test.ts`.
 */
const DEDUPED_PEERS = ["react", "react-dom"];

/**
 * Build the client SPA with Vite if `client.tsx` exists.
 * Returns a map of relative file paths to string contents for deploy,
 * or `{}` when the project has no `client.tsx`.
 */
export async function buildClient(
  cwd: string,
  opts: BuildClientOptions = {},
): Promise<Record<string, string>> {
  const clientEntry = path.join(cwd, "client.tsx");
  if (!(await fileExists(clientEntry))) {
    return {}; // No client.tsx — skip client build
  }

  const outDir = opts.outDir ?? DEFAULT_OUT_DIR;
  const clientDir = path.join(cwd, outDir);
  const cleanupHtml = writeTempHtml(cwd);
  try {
    await withPreservedNodeEnv(() =>
      build({
        root: cwd,
        base: "./",
        logLevel: "silent",
        ...(opts.configFile === false && { configFile: false }),
        ...(opts.plugins && { plugins: opts.plugins }),
        resolve: { dedupe: DEDUPED_PEERS },
        build: {
          outDir,
          emptyOutDir: true,
        },
      }),
    );
  } finally {
    cleanupHtml();
  }

  return readClientDir(clientDir);
}

/** Read a built client directory into an in-memory deploy payload. */
async function readClientDir(clientDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const entries = await fs.readdir(clientDir, { recursive: true, withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const abs = path.join(entry.parentPath, entry.name);
        const rel = path.relative(clientDir, abs).split(path.sep).join("/");
        // Text assets travel as UTF-8; binary assets (images, fonts, wasm)
        // would be corrupted by UTF-8 decode, so base64-encode them. The
        // server serve path decodes using the same isTextAssetPath heuristic.
        files[rel] = isTextAssetPath(rel)
          ? await fs.readFile(abs, "utf-8")
          : (await fs.readFile(abs)).toString("base64");
      }),
  );
  return files;
}
