// Copyright 2025 the AAI authors. MIT license.
/**
 * Studio project workspaces — the server-side file trees the browser coding
 * agent reads and writes before an agent is built and deployed.
 *
 * Each workspace is one row in the {@link WorkspaceStore} (Postgres in
 * production, memory in dev/tests — see `workspace-store.ts`). Workspaces
 * are small (a handful of source files), so a single document keeps
 * reads/writes atomic per project and avoids per-file key encoding.
 *
 * Concurrency: every write is versioned. `createWorkspace` conflicts when
 * the project already exists; `mutateWorkspace` is the read-modify-write
 * for everything else — it re-reads and re-applies the mutation once when a
 * versioned put loses a race. In-process writers are still serialized by
 * `studio-workspace-lock.ts` (the AI SDK runs one step's tool calls
 * concurrently), so the single retry only has to absorb cross-replica
 * races, which the lock cannot see.
 */

import { hash } from "node:crypto";
import { SafePathSchema } from "aai-server/schemas";
import { WorkspaceConflictError, type WorkspaceStore } from "aai-server/workspace-store";
import {
  MAX_STUDIO_FILE_BYTES,
  MAX_STUDIO_FILES,
  MAX_STUDIO_WORKSPACE_BYTES,
} from "./studio-limits.ts";

export type StudioWorkspace = {
  files: Record<string, string>;
  /**
   * `filesHash` of `files`, stamped on every write so reads (project GET,
   * deploy) never recompute it. Optional because documents written before
   * the field existed lack it — readers fall back to computing.
   */
  hash?: string;
  /** Slug of the last successful deploy — redeploys reuse it. */
  deployedSlug?: string;
  /**
   * `filesHash` of the files as they were at the last successful deploy.
   * Compared against the current files to tell whether what is running is
   * still what is in the editor. A hash rather than a timestamp because
   * publishing itself writes the workspace (bumping `updatedAt`), and
   * because editing a file and undoing it should not count as a change.
   */
  deployedHash?: string;
  /**
   * Slug of the last successful PREVIEW deploy. Previews are auto-deployed
   * after edits (agent turns, editor saves) to a separate `-preview` slug so
   * the Preview pane can show the workspace's current state without touching
   * the production agent (`deployedSlug`), which only Publish updates.
   */
  previewSlug?: string;
  /** `filesHash` at the last successful preview deploy (see `deployedHash`). */
  previewHash?: string;
  /**
   * CLI output of the last FAILED preview deploy; cleared on the next
   * success. Surfaced by the Preview pane — auto-deploys have no chat
   * turn to carry their failure output.
   */
  previewError?: string;
  updatedAt: number;
};

/** What writers supply — `hash` and `updatedAt` are stamped on write. */
export type WorkspaceInput = Omit<StudioWorkspace, "updatedAt" | "hash">;

/** Stable content hash of a workspace's files. Key order never matters. */
export function filesHash(files: Record<string, string>): string {
  const stable = Object.keys(files)
    .sort()
    .map((path) => [path, files[path]]);
  return hash("sha256", JSON.stringify(stable));
}

/**
 * `workspace.hash` when present (stamped on write), else computed. The
 * fallback covers documents written before the hash was stored.
 */
export function currentFilesHash(workspace: StudioWorkspace): string {
  return workspace.hash ?? filesHash(workspace.files);
}

/** True when the workspace has edits that have not been published. */
export function hasUnpublishedChanges(workspace: StudioWorkspace): boolean {
  // Never deployed: there is nothing to be out of date with, and the preview
  // says "nothing published yet" rather than showing a stale banner.
  if (!workspace.deployedSlug) return false;
  return workspace.deployedHash !== currentFilesHash(workspace);
}

/**
 * True when the workspace has edits the preview deploy has not shipped yet.
 * Unlike {@link hasUnpublishedChanges} this is deliberately true before the
 * first preview exists: "no preview yet" IS stale — the client uses it to
 * poll while the first auto-deploy is in flight.
 */
export function hasPreviewChanges(workspace: StudioWorkspace): boolean {
  return workspace.previewHash !== currentFilesHash(workspace);
}

/**
 * Deterministic per-API-key namespace for studio data.
 *
 * Unlike the salted argon2 ownership hashes (which are intentionally
 * unstable), this must be stable across requests so a browser session can
 * find its own projects again. A plain SHA-256 of the high-entropy API key
 * is sufficient — it is a namespace identifier, not a stored credential.
 */
export function studioScope(apiKey: string): string {
  return hash("sha256", `studio:${apiKey}`, "base64url");
}

/**
 * Composite key for one project within one scope — used by the session
 * broker's sandbox map, the preview coalescer, and the workspace mutation
 * lock. NUL separator: neither a scope hash nor a validated project name
 * can contain it, so distinct (scope, project) pairs can never collide the
 * way a printable separator would allow.
 */
export function projectKey(scope: string, project: string): string {
  return `${scope}\u0000${project}`;
}

/** Validate a workspace-relative file path; throws on traversal/absolute paths. */
function assertSafeFilePath(path: string): string {
  const parsed = SafePathSchema.safeParse(path);
  if (!parsed.success) throw new Error(`Invalid file path: ${path}`);
  return parsed.data;
}

/** Enforce per-file, per-workspace file-count and total-size limits. */
export function assertWorkspaceLimits(files: Record<string, string>): void {
  const paths = Object.keys(files);
  if (paths.length > MAX_STUDIO_FILES) {
    throw new Error(`Too many files (max ${MAX_STUDIO_FILES})`);
  }
  let total = 0;
  for (const [path, content] of Object.entries(files)) {
    if (content.length > MAX_STUDIO_FILE_BYTES) {
      throw new Error(`File too large: ${path} (max ${MAX_STUDIO_FILE_BYTES} bytes)`);
    }
    total += content.length;
  }
  if (total > MAX_STUDIO_WORKSPACE_BYTES) {
    throw new Error(`Workspace too large (max ${MAX_STUDIO_WORKSPACE_BYTES} bytes)`);
  }
}

/** Shape-check a stored document; anything malformed reads as "no workspace". */
function parseWorkspace(doc: unknown): StudioWorkspace | null {
  // `typeof null === "object"`: a doc with `files: null` (or an array) must
  // read as "no workspace", not surface as TypeErrors downstream.
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const files = (doc as { files?: unknown }).files;
  if (!files || typeof files !== "object" || Array.isArray(files)) return null;
  return doc as StudioWorkspace;
}

/**
 * Validate paths/limits and stamp `hash` + `updatedAt`. The hash is never
 * trusted from the caller, who typically spreads a stale document around a
 * `files` replacement — but a metadata-only mutation spreads `current`
 * without touching `files`, so when the map is reference-equal to `prior`'s
 * its stamped hash is reused rather than re-serializing the whole tree.
 */
function stampWorkspace(workspace: WorkspaceInput, prior?: StudioWorkspace): StudioWorkspace {
  for (const path of Object.keys(workspace.files)) assertSafeFilePath(path);
  assertWorkspaceLimits(workspace.files);
  const hashValue =
    prior?.hash !== undefined && workspace.files === prior.files
      ? prior.hash
      : filesHash(workspace.files);
  return { ...workspace, hash: hashValue, updatedAt: Date.now() };
}

export async function getWorkspace(
  store: WorkspaceStore,
  scope: string,
  project: string,
): Promise<StudioWorkspace | null> {
  const record = await store.get(scope, project);
  return record ? parseWorkspace(record.doc) : null;
}

/**
 * Create a new workspace. Atomic at the store: two concurrent creates
 * cannot both succeed, so the loser can never reset the winner's files.
 *
 * @throws {WorkspaceConflictError} when the project already exists.
 */
export async function createWorkspace(
  store: WorkspaceStore,
  scope: string,
  project: string,
  workspace: WorkspaceInput,
): Promise<StudioWorkspace> {
  const doc = stampWorkspace(workspace);
  await store.put(scope, project, doc, null);
  return doc;
}

/**
 * Versioned read-modify-write. `mutate` receives the current document and
 * returns the replacement (or `null` to decline writing — the current
 * document is returned unchanged). Resolves `null` when the project does
 * not exist; a deleted project is never resurrected, because the versioned
 * put only replaces an existing row.
 *
 * On a version conflict — a concurrent writer on another replica, since
 * local writers are serialized by the workspace lock — the mutation is
 * re-derived against a fresh read exactly once; a second conflict
 * propagates as {@link WorkspaceConflictError}.
 */
export async function mutateWorkspace(
  store: WorkspaceStore,
  scope: string,
  project: string,
  mutate: (current: StudioWorkspace) => WorkspaceInput | null | Promise<WorkspaceInput | null>,
): Promise<StudioWorkspace | null> {
  for (let attempt = 0; ; attempt += 1) {
    const record = await store.get(scope, project);
    const current = record ? parseWorkspace(record.doc) : null;
    if (!(record && current)) return null;
    const next = await mutate(current);
    if (next === null) return current;
    const doc = stampWorkspace(next, current);
    try {
      await store.put(scope, project, doc, record.version);
      return doc;
    } catch (err) {
      if (!(err instanceof WorkspaceConflictError) || attempt > 0) throw err;
      // Lost a cross-replica race: re-read and re-apply once.
    }
  }
}

export async function deleteWorkspace(
  store: WorkspaceStore,
  scope: string,
  project: string,
): Promise<void> {
  await store.delete(scope, project);
}

/** List project names in a scope, sorted. */
export function listProjects(store: WorkspaceStore, scope: string): Promise<string[]> {
  return store.list(scope);
}
