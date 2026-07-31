// Copyright 2026 the AAI authors. MIT license.
/**
 * Per-turn view of one studio workspace.
 *
 * Within a chat turn the coding agent's tools are the only writer, but every
 * tool call used to pay a full store GET (and mutations a full
 * read-modify-write) of the workspace document — a 16-step turn could cost
 * ~30 serialized round trips. A session reads the document once into memory
 * and serves every subsequent read from that snapshot; mutations update the
 * snapshot *and* write through to the store, so the browser still sees edits
 * immediately and a Publish always builds the latest files.
 *
 * The snapshot is turn-scoped by construction: create one per `runStudioChat`
 * call and let it die with the turn. Edits made outside the turn (the studio
 * editor's own file PUTs) are not observed mid-turn — the same freshness the
 * old per-call reads gave in practice, since a turn's tool calls and an
 * editor save racing each other was always last-write-wins.
 */

import { errorMessage } from "@alexkroman1/aai";
import type { WorkspaceStore } from "aai-server/workspace-store";
import { getWorkspace, mutateWorkspace, type StudioWorkspace } from "./studio-workspace.ts";
import { withWorkspaceLock } from "./studio-workspace-lock.ts";

/** Applies an in-place edit to a mutable copy of the files; returns the tool's reply. */
export type WorkspaceEdit = (files: Record<string, string>) => string | Promise<string>;

export type WorkspaceSession = {
  /** Current workspace snapshot — one store read per turn, then memory. */
  current(): Promise<StudioWorkspace | null>;
  /**
   * Copy the files, apply `edit`, write through to the store, and refresh
   * the snapshot. Failures (including workspace-limit violations) come back
   * as `Error: …` strings and leave both the snapshot and the store
   * untouched.
   */
  update(edit: WorkspaceEdit): Promise<string>;
};

export function createWorkspaceSession(
  store: WorkspaceStore,
  scope: string,
  project: string,
): WorkspaceSession {
  let snapshot: Promise<StudioWorkspace | null> | undefined;
  const current = (): Promise<StudioWorkspace | null> => {
    snapshot ??= getWorkspace(store, scope, project);
    return snapshot;
  };
  return {
    current,
    // Mutations take the per-project lock and go through the versioned
    // read-modify-write: the AI SDK executes one step's tool calls
    // concurrently, so two updates working from the same snapshot would
    // silently drop one edit (and an editor PUT landing mid-turn would be
    // resurrected from the stale snapshot). Read tools keep the cached
    // snapshot — only writes pay the extra GET. The edit is re-derivable
    // ("apply this change to the current files"), so a cross-replica
    // version conflict is absorbed by mutateWorkspace re-applying it.
    update(edit) {
      return withWorkspaceLock(scope, project, async () => {
        try {
          let message = "";
          const doc = await mutateWorkspace(store, scope, project, async (workspace) => {
            const files = { ...workspace.files };
            message = await edit(files);
            return { ...workspace, files };
          });
          if (!doc) return `Error: project ${project} not found`;
          // Write-through: the store first, snapshot only after the put
          // (with its limit checks) succeeded — a rejected write must not
          // leave a snapshot the store never saw.
          snapshot = Promise.resolve(doc);
          return message;
        } catch (err) {
          return `Error: ${errorMessage(err)}`;
        }
      });
    },
  };
}
