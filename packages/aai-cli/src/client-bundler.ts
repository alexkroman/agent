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
 *
 * @internal — build hook for aai-server/the studio; not a supported public
 * API and not covered by semver. The lack of a `_` prefix is packaging (the
 * subpath must be importable cross-package), not an invitation: user code
 * should never import from `@alexkroman1/aai-cli`.
 */

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
// The `/utils` subpath is deliberately zod-free — the root barrel would pull
// zod and five other modules into the graph for one pure string helper.
import { isTextAssetPath } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { build, type PluginOption } from "vite";
import { writeTempHtml } from "./_default-html.ts";
import { errorMessage, fileExists } from "./_utils.ts";
import { DEDUPED_PEERS, withPreservedNodeEnv } from "./_vite-env.ts";

/**
 * Options for client SPA bundling.
 *
 * @internal — build hook for aai-server/the studio; not a supported public
 * API and not covered by semver.
 */
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
 * Build the client SPA with Vite if `client.tsx` exists.
 * Returns a map of relative file paths to string contents for deploy,
 * or `{}` when the project has no `client.tsx`.
 *
 * @internal — build hook for aai-server/the studio; not a supported public
 * API and not covered by semver.
 */
export async function buildClient(
  cwd: string,
  options: BuildClientOptions = {},
): Promise<Record<string, string>> {
  const clientEntry = path.join(cwd, "client.tsx");
  if (!(await fileExists(clientEntry))) {
    return {}; // No client.tsx — skip client build
  }

  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const clientDir = path.join(cwd, outDir);
  // Assigned inside the try so cleanup runs even if writeTempHtml itself
  // throws mid-write; until then there is nothing to clean up.
  let cleanupHtml = () => {
    /* no-op until writeTempHtml has run */
  };
  try {
    cleanupHtml = writeTempHtml(cwd);
    await withPreservedNodeEnv(() =>
      build({
        root: cwd,
        base: "./",
        logLevel: "silent",
        ...(options.configFile === false && { configFile: false }),
        ...omitUndefined({ plugins: options.plugins }),
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
  let entries: Dirent[];
  try {
    entries = await fs.readdir(clientDir, { recursive: true, withFileTypes: true });
  } catch (err) {
    // A raw ENOENT on the output dir reads like a CLI bug; say what it means.
    throw new Error(`Client build produced no output at ${clientDir}: ${errorMessage(err)}`, {
      cause: err,
    });
  }
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
