// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/workspace-files` — what a workspace IS on disk — the walk, the skip rules, the caps and the strict decode.
 *
 * A FACADE. The subpath resolves here rather than at `workspace-files.ts`, which buys two
 * things the direct form could not. That module can be SPLIT as it grows without
 * moving the published entry point — the path an implementation file happens to
 * have is not a thing to promise anyone — and a name it gains next reaches the
 * public surface only when a line is added below, rather than the moment it is
 * written.
 *
 * Named re-exports rather than `export *` for the second half of that: the
 * wildcard form re-exports whatever arrives, and needs a `noReExportAll`
 * suppression the escape-hatch ratchet only lets move down.
 *
 * @module workspace-files
 */

export {
  decodeWorkspaceText,
  IGNORED_WORKSPACE_DIRS,
  isLocalOnlyFile,
  isLockfile,
  LOCAL_ONLY_FILES,
  LOCKFILES,
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_FILES,
  snapshotWorkspaceFiles,
  type WorkspaceSnapshot,
  type WorkspaceWalkOptions,
  walkWorkspaceFiles,
} from "./workspace-files.ts";
