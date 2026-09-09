// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio workspace's filesystem primitives — snapshotting and materializing
 * the session's scratch tree. Split from `studio/tools.ts`, which defines the
 * studio's extra tools over these; the harness and the chat surface use them
 * directly (session init, mid-turn checkpoints, the end-of-turn sync).
 *
 * The path primitives underneath — `resolveInside` (the containment refusal)
 * and `writeFileWithParents` — are the SDK's now
 * (`@alexkroman1/aai/workspace-files`), where the coding-agent tool set that
 * shares them lives. They are re-exported here so this module stays the one
 * import path for "how this package touches a workspace".
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  isLockfile,
  resolveInside,
  snapshotWorkspaceFiles,
  type WorkspaceSnapshot,
  walkWorkspaceFiles,
  writeFileWithParents,
} from "@alexkroman1/aai/workspace-files";

export { resolveInside, writeFileWithParents } from "@alexkroman1/aai/workspace-files";

/**
 * Parse the workspace's own `package.json`, or null when it is missing or is
 * not valid JSON.
 *
 * Absence and a mid-edit manifest are the SAME answer on purpose, and both
 * callers want it: the dependency reifier has nothing to reify, and
 * `update_dependencies` has nothing to diff. Kept here rather than at either
 * call site because a second copy is a second decision about which failures
 * count as "no manifest".
 */
export async function readWorkspaceManifest(dir: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, "package.json"), "utf-8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Workspace-relative paths of all non-ignored files under `dir`.
 *
 * Backs the coding agent's `list_files`/`grep` as well as the sync, which is
 * why it applies no per-file skip: a `.env` the agent wrote itself must stay
 * visible to the tools that read it. The CLI's push adds that rule on its
 * own side (`isLocalOnlyFile`).
 */
export function walkWorkspace(dir: string): Promise<string[]> {
  return walkWorkspaceFiles(dir);
}

/**
 * Snapshot the session's scratch tree into a workspace file map.
 *
 * Same walk, caps, skip rules and strict decode `aai push` uses — one
 * definition in the SDK (`@alexkroman1/aai/workspace-files`), because the two
 * write the same map from opposite ends and a disagreement between them is a
 * file silently dropped on one path and resurrected on the other.
 *
 * Lockfiles are the one thing this drops (see {@link isLockfile}), and unlike
 * push it drops ONLY those: `add_dependency` runs `npm install`, which writes
 * a ~100 KB `package-lock.json` after three ordinary dependencies, and syncing
 * it made a resolved tree the bulk of every turn's payload and of what `aai
 * pull` writes back. Push's other rule — `.env` — deliberately does not apply
 * here, because the coding agent may have written that file itself.
 */
export function snapshotWorkspace(dir: string): Promise<WorkspaceSnapshot> {
  return snapshotWorkspaceFiles(dir, { skipFile: isLockfile });
}

/** Materialize a files record into `dir`, replacing whatever was there. */
export async function materializeWorkspace(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Object.entries(files).map(([rel, content]) =>
      writeFileWithParents(resolveInside(dir, rel), content),
    ),
  );
}
