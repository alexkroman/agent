// Copyright 2025 the AAI authors. MIT license.
/**
 * Studio Publish: the project's guest sandbox runs the LITERAL `aai deploy`
 * CLI against the platform (the broker's `workspace/deploy`), on the
 * caller's own key. Build, config extraction, ownership, reserved slugs,
 * the ASSEMBLYAI_API_KEY floor, and the credential preflight all happen on
 * the exact laptop-deploy path — this module only stamps the workspace's
 * deploy metadata and shapes the result for the client, whose job is to
 * show the CLI output and post it into the chat so the coding agent can
 * act on failures.
 */

import type { WorkspaceStore } from "aai-server/workspace-store";
import type { StudioSessionBroker } from "./studio-session-broker.ts";
import { currentFilesHash, getWorkspace, stampWorkspaceMeta } from "./studio-workspace.ts";

export type StudioDeployResult =
  | { ok: true; slug: string; url: string; output: string }
  | { ok: false; error: string };

export type StudioDeployDeps = {
  workspaces: WorkspaceStore;
  /** The session broker's `deployWorkspace` — Publish's in-sandbox CLI run. */
  deployWorkspace: StudioSessionBroker["deployWorkspace"];
};

export type StudioDeployParams = {
  apiKey: string;
  scope: string;
  project: string;
  /** Public platform origin the guest's CLI deploys to. */
  serverUrl: string;
};

export async function deployStudioProject(
  deps: StudioDeployDeps,
  params: StudioDeployParams,
): Promise<StudioDeployResult> {
  const workspace = await getWorkspace(deps.workspaces, params.scope, params.project);
  if (!workspace) return { ok: false, error: `Project not found: ${params.project}` };

  // Computed once and stamped as `deployedHash` below.
  const hash = currentFilesHash(workspace);
  // A deploy failure is CLI output the coding agent can act on, not an
  // exception; transport failures (dead sandbox, malformed frames) throw.
  const result = await deps.deployWorkspace(params.scope, params.project, workspace.files, {
    serverUrl: params.serverUrl,
    apiKey: params.apiKey,
    // Redeploys reuse the project's slug; first deploys claim the project
    // name itself (matching what a user would expect their URL to be).
    slug: workspace.deployedSlug ?? params.project,
  });
  if (!result.ok) return { ok: false, error: result.output };
  const slug = result.slug ?? workspace.deployedSlug ?? params.project;

  // Always written, not just on a slug change: `deployedHash` is what tells
  // the preview whether the running agent still matches the editor, so a
  // redeploy to the same slug has to refresh it too.
  //
  // Stamp only the deploy metadata: the CLI run above takes seconds, and
  // writing the pre-deploy `files` snapshot back would silently revert
  // anything edited meanwhile — which `stampWorkspaceMeta` now makes
  // impossible rather than merely intended, since its patch carries no files
  // at all. `hash` is of the snapshot that was actually deployed, so
  // mid-deploy edits still show as unpublished. Deleted mid-deploy → no row,
  // and the project is never resurrected just to record a slug.
  await stampWorkspaceMeta(deps.workspaces, params.scope, params.project, {
    deployedSlug: slug,
    deployedHash: hash,
  });
  return { ok: true, slug, url: `/${slug}/`, output: result.output };
}
