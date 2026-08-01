// Copyright 2025 the AAI authors. MIT license.
/**
 * Studio deploy flow: build the workspace IN a guest sandbox — the broker's
 * `workspace/build`, which runs the same aai CLI bundler pass `aai deploy`
 * runs and loads the built worker in place for its config self-description
 * — validate that config, and hand the result to the shared deploy core.
 * The host never builds and never evaluates tenant code. Failures come back
 * as plain-text messages so the coding agent (and the UI) can show — and
 * fix — them.
 */

import { ASSEMBLYAI_API_KEY_ENV } from "@alexkroman1/aai/stt";
import { type DeployDeps, deployAgentBundle, validateAgentConfig } from "aai-server/deploy";
import type { WorkspaceStore } from "aai-server/workspace-store";
import type { WorkspaceBuildOutcome } from "./studio-session-broker.ts";
import { currentFilesHash, getWorkspace, mutateWorkspace } from "./studio-workspace.ts";
import { withWorkspaceLock } from "./studio-workspace-lock.ts";

export type StudioDeployResult =
  | { ok: true; slug: string; url: string; warning?: string }
  | { ok: false; error: string };

export type StudioDeployDeps = DeployDeps & {
  workspaces: WorkspaceStore;
  /** The session broker's `buildWorkspace` — Publish's in-sandbox build. */
  buildWorkspace: (
    scope: string,
    project: string,
    files: Record<string, string>,
  ) => Promise<WorkspaceBuildOutcome>;
};

export type StudioDeployParams = {
  apiKey: string;
  scope: string;
  project: string;
  /** Env/secrets to merge into the agent's stored env. */
  env?: Record<string, string> | undefined;
};

export async function deployStudioProject(
  deps: StudioDeployDeps,
  params: StudioDeployParams,
): Promise<StudioDeployResult> {
  const workspace = await getWorkspace(deps.workspaces, params.scope, params.project);
  if (!workspace) return { ok: false, error: `Project not found: ${params.project}` };

  // Computed once and stamped as `deployedHash` below.
  const hash = currentFilesHash(workspace);
  // A build failure is a message the coding agent can act on, not an
  // exception; transport failures (dead sandbox, malformed frames) throw.
  const built = await deps.buildWorkspace(params.scope, params.project, workspace.files);
  if (!built.ok) return { ok: false, error: built.error };
  const { worker, clientFiles } = built;

  const extraction = validateAgentConfig(built.config);
  if (!extraction.ok) return { ok: false, error: extraction.error };

  const outcome = await deployAgentBundle(
    {
      store: deps.store,
      slots: deps.slots,
      slugLock: deps.slugLock,
      slugEpochs: deps.slugEpochs,
    },
    {
      // Redeploys reuse the project's slug; first deploys claim the project
      // name itself (matching what a user would expect their URL to be).
      slug: workspace.deployedSlug ?? params.project,
      apiKey: params.apiKey,
      worker,
      clientFiles,
      env: params.env,
      // The studio has no secrets UI, so a published agent would otherwise
      // start with an empty env and its S2S connect would send `Bearer ` —
      // AssemblyAI answers `unauthorized`. The bearer token the caller
      // authenticated with *is* their AssemblyAI key (see `aai-cli/_config.ts`),
      // so seed it as the agent's key. A floor, not an override: a key the
      // user set explicitly (here or via `aai secret put`) always wins.
      defaultEnv: { [ASSEMBLYAI_API_KEY_ENV]: params.apiKey },
      agentConfig: extraction.config,
      // Warn, never reject: the studio has no secrets UI, so a hard failure
      // on a missing non-AssemblyAI key would leave its user with no way to
      // publish at all. The warning rides back to the client instead.
      credentialPolicy: "warn",
    },
  );
  if (!outcome.ok) return { ok: false, error: outcome.error };

  // Always written, not just on a slug change: `deployedHash` is what tells
  // the preview whether the running agent still matches the editor, so a
  // redeploy to the same slug has to refresh it too.
  //
  // Re-read under the workspace lock and stamp only the deploy metadata:
  // the builds above take seconds, and writing the pre-build `files`
  // snapshot back would silently revert anything edited meanwhile. `hash`
  // is of the snapshot that was actually built, so mid-build edits still
  // show as unpublished. Deleted mid-deploy → mutateWorkspace finds no row
  // and never resurrects the project just to record a slug; the metadata
  // stamp is re-derivable, so a cross-replica conflict retries cleanly.
  await withWorkspaceLock(params.scope, params.project, () =>
    mutateWorkspace(deps.workspaces, params.scope, params.project, (current) => ({
      ...current,
      deployedSlug: outcome.slug,
      deployedHash: hash,
    })),
  );
  return {
    ok: true,
    slug: outcome.slug,
    url: `/${outcome.slug}/`,
    ...(outcome.warnings && outcome.warnings.length > 0
      ? { warning: outcome.warnings.join(" ") }
      : {}),
  };
}
