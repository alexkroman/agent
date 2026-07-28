// Copyright 2025 the AAI authors. MIT license.
/**
 * Materialize an in-memory studio workspace to a scratch directory.
 *
 * Both studio builds — the worker (`studio-bundle.ts`) and the client
 * (`studio-client-build.ts`) — run through the CLI's Vite bundlers, which
 * take a directory. One materialize serves both.
 *
 * The scratch dir lives under the server package rather than `os.tmpdir()`
 * so Node resolves `@alexkroman1/aai`, `zod`, `react`, and
 * `@alexkroman1/aai-ui` by walking up to the workspace `node_modules`.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SafePathSchema } from "../schemas.ts";
import { StudioBuildError } from "./studio-errors.ts";

/** Scratch root for materialized workspaces (see module doc for placement). */
const BUILD_ROOT = path.resolve(import.meta.dirname, "..", ".studio-build");

/**
 * Write `files` to a fresh scratch directory, run `fn` against it, and remove
 * the directory afterwards — whether `fn` resolves or throws.
 */
export async function withWorkspaceDir<T>(
  files: Record<string, string>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = path.join(BUILD_ROOT, randomUUID());
  try {
    await materialize(dir, files);
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {
      /* best-effort cleanup */
    });
  }
}

/**
 * Paths are re-validated with the same `SafePathSchema` the write_file route
 * uses — this is the one place a workspace key becomes a real filesystem
 * path, so it re-checks rather than trusting what storage handed back.
 */
async function materialize(dir: string, files: Record<string, string>): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(
    Object.entries(files).map(async ([rel, contents]) => {
      const parsed = SafePathSchema.safeParse(rel);
      if (!parsed.success) throw new StudioBuildError(`Unsafe workspace path: ${rel}`);
      const abs = path.join(dir, parsed.data);
      if (!abs.startsWith(`${dir}${path.sep}`)) {
        throw new StudioBuildError(`Unsafe workspace path: ${rel}`);
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents, "utf-8");
    }),
  );
}
