// Copyright 2026 the AAI authors. MIT license.
/**
 * Internals of the studio-workspace commands (`aai list/pull/push/publish`):
 * the local source-file walk and the thin clients for the platform's
 * `/studio/projects` routes. The workspace is the single source of truth —
 * these helpers only move files between a local directory and the project's
 * workspace row; production deploys happen exclusively through the studio's
 * Publish route (which runs the deploy machinery in the project's sandbox).
 */

import path from "node:path";
import { MAX_SLUG_LENGTH, PREVIEW_SLUG_SUFFIX, VALID_SLUG_RE } from "@alexkroman1/aai/internal";
import { slugifyName } from "@alexkroman1/aai/slugify";
import { isRecord } from "@alexkroman1/aai/utils";
import {
  isLocalOnlyFile,
  snapshotWorkspaceFiles,
  type WorkspaceSnapshot,
} from "@alexkroman1/aai/workspace-files";
import { apiRequest, checkedResponse, isStringArray } from "./_api-client.ts";

/**
 * Snapshot the local project into a workspace file map.
 *
 * The walk, the caps, the skip rules and the strict UTF-8 decode all come
 * from the SDK (`@alexkroman1/aai/workspace-files`), which is also what the
 * guest's end-of-turn sync uses — the two write the same map from opposite
 * ends, and a disagreement between them is not an error but a file silently
 * dropped here and resurrected there.
 *
 * `isLocalOnlyFile` is the one rule this side adds: `.env` rides the secret
 * routes and lockfiles are install output, so neither belongs in a row.
 */
export function collectSourceFiles(dir: string): Promise<WorkspaceSnapshot> {
  return snapshotWorkspaceFiles(dir, { subject: "Project", skipFile: isLocalOnlyFile });
}

/**
 * A studio project name derived from a directory name, or null if unusable.
 *
 * The normalization is the platform's own (`slugifyName`), not a local
 * regex. This used to strip `[^a-z0-9-_]` by hand, which differs from the
 * studio's slugifier on exactly the names people give agents: `Café
 * Ordering` reduced to `caf-ordering` here and `cafe-ordering` there, so the
 * same directory produced a different project depending on whether it was
 * created by `aai push` or by typing the name into the studio.
 *
 * A `-preview` suffix is deliberately unusable. Publishing a project deploys
 * it under the project's own name, so a `*-preview` project would claim a
 * slug the studio's orphan-preview sweep reaps hourly — deleting the agent,
 * its app-database schema, and its secrets on a schedule the user never
 * asked for. Refusing the name is recoverable (rename the directory); losing
 * a published agent to the reaper is not.
 */
export function projectNameFromDir(dir: string): string | null {
  const name = slugifyName(path.basename(dir), MAX_SLUG_LENGTH);
  if (name.endsWith(PREVIEW_SLUG_SUFFIX)) return null;
  return VALID_SLUG_RE.test(name) ? name : null;
}

/** The shareable studio URL for a project — what every command prints. */
export function studioProjectUrl(serverUrl: string, project: string): string {
  return `${serverUrl}/studio/chat/${project}`;
}

/**
 * The `/studio/projects/:project` base every project-scoped route hangs off —
 * the source, the deploy, the secret fan-out, the delete.
 *
 * One definition because of the `encodeURIComponent`: the project name comes
 * from `.aai/project.json` or from a directory name, i.e. from the working
 * tree, and every request built on it carries the user's API key. Six call
 * sites spelled this template out by hand, so "did that one encode?" was a
 * question the reader had to answer six times.
 */
export function studioProjectApiUrl(serverUrl: string, project: string): string {
  return `${serverUrl}/studio/projects/${encodeURIComponent(project)}`;
}

/** `GET /studio/projects/:project` — see `projectPayload` server-side. */
export type StudioProject = {
  files: Record<string, string>;
  sourceHash: string;
  deployedSlug?: string;
  unpublished?: boolean;
};

export function listStudioProjects(serverUrl: string, apiKey: string): Promise<string[]> {
  return apiRequest(`${serverUrl}/studio/projects`, {
    apiKey,
    action: "list",
    // Checked rather than cast: a 200 without `projects` made `aai list` die on
    // `undefined is not iterable` — and `notFoundHint` calls this on an
    // ALREADY-failing path, where a raw TypeError replaces the 404 the user
    // needs to see. See `checkedResponse`.
  }).then(
    (res) =>
      checkedResponse(
        res,
        (value): value is { projects: string[] } =>
          isRecord(value) && isStringArray(value.projects),
        `the studio project list at ${serverUrl}`,
      ).projects,
  );
}

/** Fetch a project, or null when it doesn't exist (the push existence probe). */
export function fetchStudioProject(
  serverUrl: string,
  apiKey: string,
  project: string,
): Promise<StudioProject | null> {
  return apiRequest<StudioProject | null>(studioProjectApiUrl(serverUrl, project), {
    apiKey,
    action: "pull",
    allow404: true,
  });
}

/** `PUT /studio/projects/:project/source` — the atomic whole-tree push. */
export function pushStudioSource(
  serverUrl: string,
  apiKey: string,
  project: string,
  body: { files: Record<string, string>; baseHash?: string | undefined },
): Promise<{ sourceHash: string; created: boolean }> {
  return apiRequest(`${studioProjectApiUrl(serverUrl, project)}/source`, {
    apiKey,
    action: "push",
    method: "PUT",
    body,
    // Not idempotent in effect (a retried create can double-fire previews),
    // but a replayed identical push is a no-op server-side, so retries are
    // safe — keep the default transient-failure retry.
    hints: {
      409: "The studio has newer changes. Run `aai pull` to fetch them, or `aai push --force` to overwrite.",
    },
  });
}

/** `POST /studio/projects/:project/deploy` — Publish, in the project's sandbox. */
export function publishStudioProject(
  serverUrl: string,
  apiKey: string,
  project: string,
  opts: { skipTypecheck?: boolean | undefined } = {},
): Promise<{ ok: true; slug: string; url: string; output: string }> {
  return apiRequest(`${studioProjectApiUrl(serverUrl, project)}/deploy`, {
    apiKey,
    action: "publish",
    method: "POST",
    // `--skipTypecheck` rides the request body so the in-sandbox `aai deploy`
    // skips its own tsc gate. `apiRequest` omits an undefined body, so the
    // common publish stays a bodyless POST an older server ignores.
    body: opts.skipTypecheck ? { skipTypecheck: true } : undefined,
    // A retried publish re-runs a whole in-sandbox build; surface the
    // failure instead.
    retry: 0,
  });
}
