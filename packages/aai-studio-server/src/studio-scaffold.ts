// Copyright 2026 the AAI authors. MIT license.
/**
 * The project scaffold, as the studio server reaches it: one directory, found
 * through the package graph, read once.
 *
 * Two things here need it. The coding agent's system prompt embeds the
 * authoring guide (`scaffold/CLAUDE.md`), and the GitHub sync layers the rest
 * of it under a workspace so the repository it writes is a project a laptop
 * can install and run — the same completion `aai pull` applies
 * (`layerScaffoldFiles` in `@alexkroman1/aai/workspace-files`).
 */

import { createRequire } from "node:module";
import path from "node:path";
import { readScaffoldFiles } from "@alexkroman1/aai/workspace-files";

/**
 * The scaffold directory, resolved through the package graph the same way
 * `studio-static.ts` finds the built studio client.
 *
 * This was a relative `../aai-templates/...` walk once, justified by a comment
 * claiming the dev and built layouts both sit one directory under the package
 * root. They do not: from `dist/` it resolved to
 * `packages/aai-studio-server/src/aai-templates/...`, which does not exist — so
 * production (which runs the bundle) silently served the prompt's fallback
 * guide. Resolving through a real dependency edge cannot drift with the
 * bundle's location.
 */
export function scaffoldDir(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve("aai-templates/package.json")), "scaffold");
}

let cached: Promise<Record<string, string>> | undefined;

/**
 * The scaffold's files, read on first use and shared after.
 *
 * Cached for the life of the process because the scaffold is part of the
 * deployed image: it changes only with a redeploy, which is a new process.
 * A failed read is NOT cached, so a transient error does not pin every later
 * sync to an incomplete project.
 */
export function loadScaffoldFiles(): Promise<Record<string, string>> {
  cached ??= readScaffoldFiles(scaffoldDir()).catch((err: unknown) => {
    cached = undefined;
    throw err;
  });
  return cached;
}
