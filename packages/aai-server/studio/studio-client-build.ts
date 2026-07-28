// Copyright 2025 the AAI authors. MIT license.
/**
 * Build a studio workspace's `client.tsx` into deployable `clientFiles`.
 *
 * This does **not** reimplement the CLI's client build — it materializes the
 * in-memory workspace to a scratch directory and calls the CLI's own
 * `buildClient` (`@alexkroman1/aai-cli/client-bundler`), so a UI published
 * from the browser is produced by the same Vite pipeline as `aai deploy`.
 *
 * Two things the CLI gets from a real project and the studio must supply:
 *
 * - **Plugins.** A scaffolded project has a `vite.config.ts` with
 *   `@vitejs/plugin-react` + `@tailwindcss/vite`. A workspace has no config
 *   and can't install packages, so the plugins are injected here.
 * - **`configFile: false`.** Workspace files are untrusted and a Vite config
 *   is executable host code. Any `vite.config.ts` the coding agent writes is
 *   materialized but never loaded.
 *
 * The scratch directory lives under the server package (not `os.tmpdir()`) so
 * Node resolves `react`, `react-dom`, and `@alexkroman1/aai-ui` by walking up
 * to the workspace `node_modules` — the same reason `studio-bundle.ts` anchors
 * esbuild's resolver at the package root.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildClient } from "@alexkroman1/aai-cli/client-bundler";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { SafePathSchema } from "../schemas.ts";
import { StudioBuildError } from "./studio-bundle.ts";

/** Scratch root for materialized workspaces (see module doc for placement). */
const BUILD_ROOT = path.resolve(import.meta.dirname, "..", ".studio-build");

/** Vite writes here, relative to the scratch dir. */
const OUT_DIR = "dist-client";

/**
 * Build the workspace's client SPA. Returns `{}` when there is no
 * `client.tsx` — the agent then falls back to the platform default UI.
 *
 * @throws {StudioBuildError} with Vite diagnostics on compile errors.
 */
export async function buildWorkspaceClient(
  files: Record<string, string>,
): Promise<Record<string, string>> {
  if (!files["client.tsx"]) return {};

  const dir = path.join(BUILD_ROOT, randomUUID());
  try {
    await materialize(dir, files);
    return await buildClient(dir, {
      configFile: false,
      plugins: [react(), tailwindcss()],
      outDir: OUT_DIR,
    });
  } catch (err) {
    throw new StudioBuildError(formatViteError(err), { cause: err });
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {
      /* best-effort cleanup */
    });
  }
}

/**
 * Write the workspace to `dir`. Paths are re-validated with the same
 * `SafePathSchema` the write_file route uses — this is the one place a
 * workspace key becomes a real filesystem path, so it re-checks rather than
 * trusting what storage handed back.
 */
async function materialize(dir: string, files: Record<string, string>): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(
    Object.entries(files).map(async ([rel, contents]) => {
      const parsed = SafePathSchema.safeParse(rel);
      if (!parsed.success) {
        throw new StudioBuildError(`Unsafe workspace path: ${rel}`);
      }
      const abs = path.join(dir, parsed.data);
      if (!abs.startsWith(`${dir}${path.sep}`)) {
        throw new StudioBuildError(`Unsafe workspace path: ${rel}`);
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents, "utf-8");
    }),
  );
}

/** Format a Vite/Rollup build failure for the chat and the UI. */
function formatViteError(err: unknown): string {
  if (err instanceof StudioBuildError) return err.message;
  const e = err as { message?: string; id?: string; loc?: { line?: number } };
  const where = e?.id ? `${e.id}${e.loc?.line ? `:${e.loc.line}` : ""}: ` : "";
  return `Client build failed:\n${where}${e?.message ?? String(err)}`;
}
