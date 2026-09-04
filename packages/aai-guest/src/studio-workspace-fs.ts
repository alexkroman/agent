// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio workspace's filesystem primitives — walking, snapshotting, and
 * materializing the session's scratch tree. Split from studio-tools.ts,
 * which defines the coding agent's tool set over these; the harness and the
 * chat surface use them directly (session init, mid-turn checkpoints, the
 * end-of-turn sync).
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isLockfile,
  snapshotWorkspaceFiles,
  type WorkspaceSnapshot,
  walkWorkspaceFiles,
} from "@alexkroman1/aai/workspace-files";
import { isPathInside } from "@alexkroman1/aai-runtime/internal";

/**
 * Resolve a workspace-relative path, refusing escapes from the root.
 *
 * The containment test is {@link isPathInside}, not a fourth copy of the line.
 * It was open-coded here byte for byte — as it was in `aai-cli/studio.ts` — even
 * though `aai-runtime` exports it from `/internal` with a comment saying it is
 * shared BECAUSE the guest harness needs it. The copies were only correct for an
 * absolute, normalized, trailing-slash-free root, which nothing stated: this
 * function threw "Path escapes the workspace" for `resolveInside("/a/b/",
 * "c.ts")`. Only the ERROR SENTENCE is this module's — the callers' surfaces
 * differ (a coding-agent tool result here, a CLI failure there), which is
 * exactly why the predicate is shared and the message is not.
 */
export function resolveInside(dir: string, rel: string): string {
  const abs = path.resolve(dir, rel);
  if (!isPathInside(dir, abs)) {
    throw new Error(`Path escapes the workspace: ${rel}`);
  }
  return abs;
}

/**
 * Write one file at an already-resolved absolute path, creating its parent
 * directories.
 *
 * Every write into a workspace goes through the same two calls — `mkdir -p` the
 * parent, then write utf-8 — and it was open-coded at four sites (this module's
 * own materialize, `write_file`, `download_to_workspace`, and the template
 * copy). The path is passed RESOLVED rather than relative on purpose: each
 * caller refuses an escape with {@link resolveInside} at the point where its own
 * error shape is right, and this must not become a second place that decides.
 */
export async function writeFileWithParents(abs: string, content: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf-8");
}

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
