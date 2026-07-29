// Copyright 2026 the AAI authors. MIT license.
/**
 * Per-turn view of one studio workspace.
 *
 * Within a chat turn the coding agent's tools are the only writer, but every
 * tool call used to pay a full storage GET (and mutations a full
 * read-modify-write) of the workspace document — a 16-step turn could cost
 * ~30 serialized round trips. A session reads the document once into memory
 * and serves every subsequent read from that snapshot; mutations update the
 * snapshot *and* write through to storage, so the browser still sees edits
 * immediately and a Publish always builds the latest files.
 *
 * The snapshot is turn-scoped by construction: create one per `runStudioChat`
 * call and let it die with the turn. Edits made outside the turn (the studio
 * editor's own file PUTs) are not observed mid-turn — the same freshness the
 * old per-call reads gave in practice, since a turn's tool calls and an
 * editor save racing each other was always last-write-wins.
 */

import type { Storage } from "unstorage";
import { getWorkspace, putWorkspace, type StudioWorkspace } from "./studio-workspace.ts";
import { withWorkspaceLock } from "./studio-workspace-lock.ts";

/** Applies an in-place edit to a mutable copy of the files; returns the tool's reply. */
export type WorkspaceEdit = (files: Record<string, string>) => string | Promise<string>;

export type WorkspaceSession = {
  /** Current workspace snapshot — one storage read per turn, then memory. */
  current(): Promise<StudioWorkspace | null>;
  /**
   * Copy the files, apply `edit`, write through to storage, and refresh the
   * snapshot. Failures (including workspace-limit violations from
   * `putWorkspace`) come back as `Error: …` strings and leave both the
   * snapshot and storage untouched.
   */
  update(edit: WorkspaceEdit): Promise<string>;
};

export function createWorkspaceSession(
  storage: Storage,
  scope: string,
  project: string,
): WorkspaceSession {
  let snapshot: Promise<StudioWorkspace | null> | undefined;
  const current = (): Promise<StudioWorkspace | null> => {
    snapshot ??= getWorkspace(storage, scope, project);
    return snapshot;
  };
  return {
    current,
    // Mutations take the per-project lock and re-read inside it: the AI SDK
    // executes one step's tool calls concurrently, so two updates working
    // from the same snapshot would silently drop one edit (and an editor PUT
    // landing mid-turn would be resurrected from the stale snapshot). Read
    // tools keep the cached snapshot — only writes pay the extra GET.
    update(edit) {
      return withWorkspaceLock(scope, project, async () => {
        const workspace = await getWorkspace(storage, scope, project);
        if (!workspace) return `Error: project ${project} not found`;
        const files = { ...workspace.files };
        try {
          const message = await edit(files);
          // Write-through: storage first, snapshot only after the PUT (with
          // its limit checks) succeeded — a rejected write must not leave a
          // snapshot storage never saw.
          const doc = await putWorkspace(storage, scope, project, { ...workspace, files });
          snapshot = Promise.resolve(doc);
          return message;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      });
    },
  };
}
