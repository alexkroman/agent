// Copyright 2025 the AAI authors. MIT license.
/**
 * Build a studio workspace's `client.tsx` into deployable `clientFiles`.
 *
 * This does **not** reimplement the CLI's client build — it calls `buildClient`
 * from `@alexkroman1/aai-cli/client-bundler`, so a UI published from the
 * browser is produced by the same Vite pipeline as `aai deploy`.
 *
 * Two things the CLI gets from a real project and the studio must supply:
 *
 * - **Plugins.** A scaffolded project has a `vite.config.ts` with
 *   `@vitejs/plugin-react` + `@tailwindcss/vite`. A workspace has no config
 *   and can't install packages, so the plugins are injected here.
 * - **`configFile: false`.** Workspace files are untrusted and a Vite config
 *   is executable host code. Any `vite.config.ts` the coding agent writes is
 *   materialized but never loaded.
 */

import { buildClient } from "@alexkroman1/aai-cli/client-bundler";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { formatBuildFailure, StudioBuildError } from "./studio-errors.ts";

/** Vite writes here, relative to the scratch dir. */
const OUT_DIR = "dist-client";

/**
 * Build the workspace's client SPA. Returns `{}` when there is no
 * `client.tsx` — the agent then falls back to the platform default UI.
 *
 * @throws {StudioBuildError} with Vite diagnostics on compile errors.
 */
export async function buildWorkspaceClient(dir: string): Promise<Record<string, string>> {
  try {
    return await buildClient(dir, {
      configFile: false,
      plugins: [react(), tailwindcss()],
      outDir: OUT_DIR,
    });
  } catch (err) {
    throw new StudioBuildError(formatBuildFailure(err, "Client build failed", dir), {
      cause: err,
    });
  }
}
