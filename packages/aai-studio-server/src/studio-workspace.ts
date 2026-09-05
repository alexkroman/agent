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
 * for everything else — it serializes in-process writers on a keyed mutex
 * (the AI SDK runs one step's tool calls concurrently) and re-reads and
 * re-applies the mutation once when a versioned put loses a race, so the
 * single retry only has to absorb cross-replica races, which the lock
 * cannot see.
 */

import { hash } from "node:crypto";
import { isRecord } from "@alexkroman1/aai/utils";
import { SafePathSchema } from "aai-server/config";
import { createKeyedLock, projectKey as platformProjectKey, withLock } from "aai-server/platform";
import { WorkspaceConflictError, type WorkspaceStore } from "aai-server/stores";
import {
  MAX_STUDIO_FILE_BYTES,
  MAX_STUDIO_FILES,
  MAX_STUDIO_WORKSPACE_BYTES,
} from "./studio-limits.ts";
import type { ProjectKind } from "./studio-project-kind.ts";

export type StudioWorkspace = {
  files: Record<string, string>;
  /**
   * What the project builds — the new-project screen's switcher, stamped at
   * create time and read back when a coding-agent session is installed, which
   * is what selects the system prompt (see studio-project-kind.ts). Absent on
   * every document written before the switcher existed, which
   * `resolveProjectKind` reads as the default (`agent`).
   */
  kind?: ProjectKind;
  /**
   * `filesHash` of `files`, stamped on every write so reads (project GET,
   * deploy) never recompute it. Required: `stampWorkspace` is the only way a
   * document is written, and it always sets this.
   */
  hash: string;
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
  /**
   * `owner/repo` of the last successful GitHub sync (studio-github-sync.ts).
   * The whole GitHub group is stamped together and read together: a repo with
   * no hash beside it could not answer "is this branch current", which is the
   * only question the button asks.
   */
  githubRepo?: string;
  /** Branch of the last successful sync. */
  githubBranch?: string;
  /**
   * `filesHash` at the last successful sync — the idempotence token, exactly
   * as `deployedHash` and `previewHash` are for their deploys. A hash rather
   * than a timestamp for the same two reasons: the sync itself writes the
   * workspace, and an edit that is undone should not leave the project
   * permanently "unsynced".
   */
  githubHash?: string;
  /** Commit the last sync created, so the client can link to it. */
  githubCommit?: string;
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

/** True when the workspace has edits that have not been published. */
export function hasUnpublishedChanges(workspace: StudioWorkspace): boolean {
  // Never deployed: there is nothing to be out of date with, and the preview
  // says "nothing published yet" rather than showing a stale banner.
  if (!workspace.deployedSlug) return false;
  return workspace.deployedHash !== workspace.hash;
}

/**
 * True when the workspace has edits the last GitHub sync does not carry.
 *
 * False when nothing was ever synced — like {@link hasUnpublishedChanges} and
 * unlike {@link hasPreviewChanges}: with no repository connected there is
 * nothing to be out of date WITH, and a project that has never opted into
 * GitHub must not render as permanently stale.
 */
export function hasGithubChanges(workspace: StudioWorkspace): boolean {
  if (!workspace.githubRepo) return false;
  return workspace.githubHash !== workspace.hash;
}

/**
 * True when the workspace has edits the preview deploy has not shipped yet.
 * Unlike {@link hasUnpublishedChanges} this is deliberately true before the
 * first preview exists: "no preview yet" IS stale — the client shows the
 * preview as building until the first auto-deploy lands (pushed to it over
 * the project SSE stream).
 */
export function hasPreviewChanges(workspace: StudioWorkspace): boolean {
  return workspace.previewHash !== workspace.hash;
}

/**
 * Deterministic namespace for studio data: a SHA-256 of the caller's
 * identity — `user:<uid>` for browser sessions, the raw API key for CLI
 * and eval callers (see `requestScope` in studio-routes.ts). It must be
 * stable across requests so a caller can find its own projects again; it
 * is a namespace identifier, not a stored credential.
 */
export function studioScope(apiKey: string): string {
  return hash("sha256", `studio:${apiKey}`, "base64url");
}

/**
 * Composite key for one project within one scope — used by the session
 * broker's sandbox map, the preview coalescer, and the workspace mutation
 * lock.
 *
 * Delegated rather than redefined: the NUL separator's whole argument is that
 * no (scope, project) pair can forge another's key, and that holds only while
 * every copy agrees on the separator. They did not — the Realtime channel pool
 * keyed on a SPACE — so there is one definition now, in the package that
 * documents the reasoning.
 */
export function projectKey(scope: string, project: string): string {
  return platformProjectKey(scope, project);
}

/**
 * Validate a workspace-relative file path and return its NORMALIZED form;
 * throws on traversal/absolute paths.
 *
 * The normalization is the return value and callers must use it. `agent.ts`
 * and `./agent.ts` both pass `SafePathSchema`, which normalizes them to the
 * same path — and the workspace is a `Record<string, string>` keyed by
 * whatever the writer sent, so storing the raw key gave one file two entries.
 * Both then show in the editor, `test_agent` builds whichever the bundler
 * resolves, and a write to one leaves the other stale.
 */
export function normalizeFilePath(path: string): string {
  const parsed = SafePathSchema.safeParse(path);
  if (!parsed.success) throw new Error(`Invalid file path: ${path}`);
  return parsed.data;
}

/**
 * The file map as it will be STORED: every key validated and normalized.
 *
 * Returns the input unchanged when no key moved, which keeps
 * {@link stampWorkspace}'s reference-equality hash reuse working — a
 * metadata-only mutation spreads `current` and must not pay for a re-hash.
 * When two keys normalize to one, the later entry wins: they always denoted
 * one file, and this is where they become one.
 */
function normalizeFileMap(files: Record<string, string>): Record<string, string> {
  let moved = false;
  const normalized: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    const safe = normalizeFilePath(path);
    if (safe !== path) moved = true;
    normalized[safe] = content;
  }
  return moved ? normalized : files;
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
  // `isRecord` rather than a hand-spelled `typeof`/`Array.isArray` pair: it
  // NARROWS, so reading `.files` needs no cast. A doc with `files: null` (or an
  // array) must read as "no workspace", not surface as TypeErrors downstream.
  if (!(isRecord(doc) && isRecord(doc.files))) return null;
  return doc as StudioWorkspace;
}

/**
 * Validate paths/limits and stamp `hash` + `updatedAt`. The hash is never
 * trusted from the caller, who typically spreads a stale document around a
 * `files` replacement — but a metadata-only mutation spreads `current`
 * without touching `files`, so when the map is reference-equal to `prior`'s
 * its stamped hash is reused rather than re-serializing the whole tree.
 */
function stampWorkspace(
  workspace: WorkspaceInput,
  prior?: StudioWorkspace,
  knownHash?: string,
): StudioWorkspace {
  const files = normalizeFileMap(workspace.files);
  assertWorkspaceLimits(files);
  // `prior` is a PARSED store document, so `prior.hash` is a claim rather than a
  // value — `parseWorkspace` shape-checks `files` and casts the rest. The
  // presence test is what stops a document that lacks one from stamping
  // `undefined` over the whole tree's hash.
  const hashValue =
    knownHash ??
    (prior?.hash !== undefined && files === prior.files ? prior.hash : filesHash(files));
  return { ...workspace, files, hash: hashValue, updatedAt: Date.now() };
}

/**
 * The stored row and its parsed document together — the read every WRITER
 * opens with, since a versioned put needs the version and a malformed document
 * has to read as "no workspace" (see {@link parseWorkspace}).
 *
 * Spelled once because the three readers below each re-derived the pair and
 * its `record && current` guard, and the guard is the interesting half: a row
 * whose `doc` does not parse must take the same path as a missing row, in
 * every one of them.
 */
async function readWorkspace(
  store: WorkspaceStore,
  scope: string,
  project: string,
): Promise<{ version: number; workspace: StudioWorkspace } | null> {
  const record = await store.get(scope, project);
  const workspace = record ? parseWorkspace(record.doc) : null;
  return record && workspace ? { version: record.version, workspace } : null;
}

export async function getWorkspace(
  store: WorkspaceStore,
  scope: string,
  project: string,
): Promise<StudioWorkspace | null> {
  return (await readWorkspace(store, scope, project))?.workspace ?? null;
}

/**
 * Replace a workspace's entire file map in one atomic write — the CLI
 * `aai push` primitive. Upserts: a missing project is created (first push),
 * an existing one has its files swapped while every metadata field
 * (deployedSlug, preview state) is preserved.
 *
 * `baseHash` is the fast-forward check, and it is deliberately the FILES
 * hash, never the row version: preview deploys and Publish stamp metadata
 * onto the row (bumping its version) right after every settled edit, so a
 * version token would go stale on almost every push while the files were
 * untouched. The hash moves exactly when the files move — which is the only
 * "someone else edited" signal a pusher cares about. When supplied, the
 * write only lands while the current files still hash to it — anything else
 * (including "the project no longer exists") throws
 * {@link WorkspaceConflictError}, which the route reports as a 409 telling
 * the caller to pull first. Omitted (`--force`, or a first push), the write
 * applies over whatever is current.
 *
 * A push whose files are byte-identical to what is stored is a no-op
 * (`changed: false`) — no version bump, no preview churn.
 */
export function syncWorkspaceSource(
  store: WorkspaceStore,
  scope: string,
  project: string,
  files: Record<string, string>,
  baseHash?: string,
): Promise<{ workspace: StudioWorkspace; sourceHash: string; created: boolean; changed: boolean }> {
  return withLock(workspaceLock, projectKey(scope, project), async () => {
    // Normalized BEFORE the no-op comparison, not only on the way into the
    // store: a push spelling a path `./agent.ts` hashes differently from the
    // `agent.ts` it is stored as, so comparing the raw map would report every
    // such push as a change — a version bump and a preview deploy per `aai
    // push`, for a byte-identical tree.
    const incoming = normalizeFileMap(files);
    // Hashed ONCE and threaded into the stamps below: `stampWorkspace` reuses
    // `prior.hash` only on REFERENCE equality, which a caller replacing the map
    // defeats by construction, so a changed push hashed the same tree twice.
    const incomingHash = filesHash(incoming);
    const stored = await readWorkspace(store, scope, project);
    if (!stored) {
      // A caller holding a baseHash pulled a project that has since been
      // deleted — that is a conflict to surface, not a fresh create.
      if (baseHash !== undefined) throw new WorkspaceConflictError(scope, project);
      const doc = stampWorkspace({ files: incoming }, undefined, incomingHash);
      await store.put(scope, project, doc, null);
      return { workspace: doc, sourceHash: doc.hash, created: true, changed: true };
    }
    const { workspace: current } = stored;
    const storedHash = current.hash;
    if (baseHash !== undefined && baseHash !== storedHash) {
      throw new WorkspaceConflictError(scope, project);
    }
    if (incomingHash === storedHash) {
      return { workspace: current, sourceHash: storedHash, created: false, changed: false };
    }
    const doc = stampWorkspace({ ...current, files: incoming }, current, incomingHash);
    await store.put(scope, project, doc, stored.version);
    return { workspace: doc, sourceHash: doc.hash, created: false, changed: true };
  });
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
 * Serializes this process's workspace writers per (scope, project): the AI
 * SDK executes one assistant step's tool calls concurrently, an editor PUT
 * can land mid chat turn, and deploy/preview stamp metadata after
 * multi-second builds. Without serialization those local writers would burn
 * the versioned put's single conflict retry on each other. Module-level on
 * purpose: chat sync, the file routes, and deploy all run in the same
 * server process against the same store, so one keyed mutex covers every
 * writer.
 */
const workspaceLock = createKeyedLock();

/**
 * Versioned read-modify-write. `mutate` receives the current document and
 * returns the replacement (or `null` to decline writing — the current
 * document is returned unchanged). Resolves `null` when the project does
 * not exist; a deleted project is never resurrected, because the versioned
 * put only replaces an existing row.
 *
 * The in-process workspace lock is taken HERE, not by callers, so
 * serialization is the mechanism's invariant rather than per-call-site
 * discipline (the guest's sync-workspace handler once called this bare).
 * Long work — builds — stays outside the lock: only the read-modify-write,
 * the mutate callback included, runs under it.
 *
 * On a version conflict — a concurrent writer on another replica, since
 * local writers are serialized by the lock — the mutation is re-derived
 * against a fresh read exactly once; a second conflict propagates as
 * {@link WorkspaceConflictError}.
 */
export function mutateWorkspace(
  store: WorkspaceStore,
  scope: string,
  project: string,
  mutate: (current: StudioWorkspace) => WorkspaceInput | null | Promise<WorkspaceInput | null>,
): Promise<StudioWorkspace | null> {
  return withLock(workspaceLock, projectKey(scope, project), () =>
    applyMutation(store, scope, project, mutate),
  );
}

/** The read-modify-write loop `mutateWorkspace` runs under the lock. */
async function applyMutation(
  store: WorkspaceStore,
  scope: string,
  project: string,
  mutate: (current: StudioWorkspace) => WorkspaceInput | null | Promise<WorkspaceInput | null>,
): Promise<StudioWorkspace | null> {
  for (let attempt = 0; ; attempt += 1) {
    const stored = await readWorkspace(store, scope, project);
    if (!stored) return null;
    const current = stored.workspace;
    const next = await mutate(current);
    if (next === null) return current;
    const doc = stampWorkspace(next, current);
    try {
      await store.put(scope, project, doc, stored.version);
      return doc;
    } catch (err) {
      if (!(err instanceof WorkspaceConflictError) || attempt > 0) throw err;
      // Lost a cross-replica race: re-read and re-apply once.
    }
  }
}

/**
 * The metadata fields a stamp may write. Deliberately NOT `Partial<
 * StudioWorkspace>`: `files` and `hash` are absent from this type, so the
 * cheap write path is structurally incapable of touching the file map or
 * desynchronizing its hash. `undefined` REMOVES the field (the shape the call
 * sites already had — `delete next.previewHash`).
 */
type StampField =
  | "deployedSlug"
  | "deployedHash"
  | "previewSlug"
  | "previewHash"
  | "previewError"
  | "githubRepo"
  | "githubBranch"
  | "githubHash"
  | "githubCommit";

// `?: T | undefined` rather than `Partial<Pick<…>>`: under
// `exactOptionalPropertyTypes` those differ, and only this form lets a call
// site pass an explicit `undefined` — which is how a stamp says REMOVE.
export type WorkspaceStamp = {
  [K in StampField]?: StudioWorkspace[K] | undefined;
};

/**
 * Record deploy/preview/database metadata without reading or rewriting the
 * file map — {@link WorkspaceStore.patch}, which is where the reasoning lives.
 *
 * Every field here is re-derivable and independently owned, so last-write-wins
 * per field is the right merge: two stamps that touch different fields both
 * survive, where the versioned read-modify-write this replaced made one of
 * them retry against the other. And a stamp can no longer revert a file edit
 * that landed mid-deploy, because it never carries files — the call sites used
 * to spell that hazard out one by one ("writing the pre-deploy files back
 * would silently revert anything edited meanwhile"), and now the type says it.
 *
 * Still under the workspace lock, and that is not vestigial: `mutateWorkspace`
 * has exactly ONE conflict retry, sized for CROSS-REPLICA races, and an
 * unlocked stamp landing inside a local file write's read-modify-write would
 * spend it on a writer in the same process.
 *
 * @returns the updated workspace, or null when the project no longer exists.
 */
export function stampWorkspaceMeta(
  store: WorkspaceStore,
  scope: string,
  project: string,
  stamp: WorkspaceStamp,
): Promise<StudioWorkspace | null> {
  const set: Record<string, unknown> = { updatedAt: Date.now() };
  const remove: string[] = [];
  for (const [field, value] of Object.entries(stamp)) {
    if (value === undefined) remove.push(field);
    else set[field] = value;
  }
  return withLock(workspaceLock, projectKey(scope, project), async () => {
    const record = await store.patch(scope, project, { set, remove });
    return record ? parseWorkspace(record.doc) : null;
  });
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
