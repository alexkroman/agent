// Copyright 2025 the AAI authors. MIT license.
/**
 * Studio project workspaces — the server-side file trees the browser coding
 * agent reads and writes before an agent is built and deployed.
 *
 * Each workspace is one JSON document in the platform `Storage` under
 * `studio/{scope}/{project}`. Workspaces are small (a handful of source
 * files), so a single document keeps reads/writes atomic per project and
 * avoids per-file key encoding.
 */

import { createHash } from "node:crypto";
import type { Storage } from "unstorage";
import { SafePathSchema } from "../schemas.ts";
import {
  MAX_STUDIO_FILE_BYTES,
  MAX_STUDIO_FILES,
  MAX_STUDIO_WORKSPACE_BYTES,
} from "./studio-schemas.ts";

export type StudioWorkspace = {
  files: Record<string, string>;
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
  updatedAt: number;
};

/** Stable content hash of a workspace's files. Key order never matters. */
export function filesHash(files: Record<string, string>): string {
  const stable = Object.keys(files)
    .sort()
    .map((path) => [path, files[path]]);
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/** True when the workspace has edits that have not been published. */
export function hasUnpublishedChanges(workspace: StudioWorkspace): boolean {
  // Never deployed: there is nothing to be out of date with, and the preview
  // says "nothing published yet" rather than showing a stale banner.
  if (!workspace.deployedSlug) return false;
  return workspace.deployedHash !== filesHash(workspace.files);
}

/**
 * Deterministic per-API-key namespace for studio data.
 *
 * Unlike the salted PBKDF2 ownership hashes (which are intentionally
 * unstable), this must be stable across requests so a browser session can
 * find its own projects again. A plain SHA-256 of the high-entropy API key
 * is sufficient — it is a namespace identifier, not a stored credential.
 */
export function studioScope(apiKey: string): string {
  return createHash("sha256").update(`studio:${apiKey}`).digest("base64url");
}

function projectKey(scope: string, project: string): string {
  return `studio/${scope}/${project}`;
}

/** Validate a workspace-relative file path; throws on traversal/absolute paths. */
export function assertSafeFilePath(path: string): string {
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

export async function getWorkspace(
  storage: Storage,
  scope: string,
  project: string,
): Promise<StudioWorkspace | null> {
  const raw = await storage.getItem<string>(projectKey(scope, project));
  if (raw == null) return null;
  try {
    const doc = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!doc || typeof doc !== "object" || typeof doc.files !== "object") return null;
    return doc as StudioWorkspace;
  } catch {
    return null;
  }
}

export async function putWorkspace(
  storage: Storage,
  scope: string,
  project: string,
  workspace: Omit<StudioWorkspace, "updatedAt">,
): Promise<StudioWorkspace> {
  for (const path of Object.keys(workspace.files)) assertSafeFilePath(path);
  assertWorkspaceLimits(workspace.files);
  const doc: StudioWorkspace = { ...workspace, updatedAt: Date.now() };
  await storage.setItem(projectKey(scope, project), JSON.stringify(doc));
  return doc;
}

export async function deleteWorkspace(
  storage: Storage,
  scope: string,
  project: string,
): Promise<void> {
  await storage.removeItem(projectKey(scope, project));
}

/** List project names in a scope, newest key order not guaranteed — sorted. */
export async function listProjects(storage: Storage, scope: string): Promise<string[]> {
  const keys = await storage.getKeys(`studio/${scope}/`);
  return keys
    .map((key) => key.split(":").at(-1) ?? "")
    .filter((name) => name.length > 0)
    .sort((a, b) => a.localeCompare(b));
}
