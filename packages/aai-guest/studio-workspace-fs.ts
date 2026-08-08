// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio workspace's filesystem primitives — walking, snapshotting, and
 * materializing the session's scratch tree. Split from studio-tools.ts,
 * which defines the coding agent's tool set over these; the harness and the
 * chat surface use them directly (session init, mid-turn checkpoints, the
 * end-of-turn sync).
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  snapshotWorkspaceFiles,
  type WorkspaceSnapshot,
  walkWorkspaceFiles,
} from "@alexkroman1/aai/workspace-files";

/** Resolve a workspace-relative path, refusing escapes from the root. */
export function resolveInside(dir: string, rel: string): string {
  const abs = path.resolve(dir, rel);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) {
    throw new Error(`Path escapes the workspace: ${rel}`);
  }
  return abs;
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
 */
export function snapshotWorkspace(dir: string): Promise<WorkspaceSnapshot> {
  return snapshotWorkspaceFiles(dir);
}

/** Materialize a files record into `dir`, replacing whatever was there. */
export async function materializeWorkspace(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = resolveInside(dir, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf-8");
    }),
  );
}
