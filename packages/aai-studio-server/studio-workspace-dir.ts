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
import { isPathInside } from "aai-server/platform-barrel";
import { SafePathSchema } from "aai-server/schemas";
import { StudioBuildError } from "./studio-errors.ts";

/** Scratch root for materialized workspaces (see module doc for placement). */
// Inside this package (not os.tmpdir()) so Node resolves @alexkroman1/aai,
// zod, react, and @alexkroman1/aai-ui by walking up to the package's
// node_modules. The studio sources sit at the package root since the
// aai-studio-server split, so no `..` — that would land the scratch dir in
// packages/, outside any node_modules scope.
const BUILD_ROOT = path.resolve(import.meta.dirname, ".studio-build");

/**
 * Scratch dirs older than this are leaked by a dead process. Age-gated
 * rather than "everything under the root" because BUILD_ROOT is shared:
 * another process (parallel test workers, a rolling deploy) may have a
 * build in flight this instant.
 */
const STALE_BUILD_DIR_MS = 60 * 60 * 1000;

/**
 * Once-per-process, best-effort sweep of BUILD_ROOT on first use: scratch
 * dirs are removed in a `finally`, but a crashed process leaks its in-flight
 * dirs permanently. Must never fail a build, hence the swallowed rejection.
 */
let sweepPromise: Promise<void> | null = null;
function sweepStaleBuildDirs(): Promise<void> {
  sweepPromise ??= (async () => {
    const cutoff = Date.now() - STALE_BUILD_DIR_MS;
    const entries = await fs.readdir(BUILD_ROOT);
    await Promise.all(
      entries.map(async (name) => {
        const entry = path.join(BUILD_ROOT, name);
        if ((await fs.stat(entry)).mtimeMs < cutoff) {
          await fs.rm(entry, { recursive: true, force: true });
        }
      }),
    );
  })().catch(() => undefined);
  return sweepPromise;
}

/**
 * Write `files` to a fresh scratch directory, run `fn` against it, and remove
 * the directory afterwards — whether `fn` resolves or throws.
 */
export async function withWorkspaceDir<T>(
  files: Record<string, string>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  await sweepStaleBuildDirs();
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
      // Separator-safe containment (never a bare startsWith) — and strictly
      // inside: a key resolving to the scratch dir itself is not a file.
      if (abs === dir || !isPathInside(dir, abs)) {
        throw new StudioBuildError(`Unsafe workspace path: ${rel}`);
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents, "utf-8");
    }),
  );
}
