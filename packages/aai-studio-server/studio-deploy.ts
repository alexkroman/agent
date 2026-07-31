// Copyright 2025 the AAI authors. MIT license.
/**
 * Studio deploy flow: bundle the workspace, extract the agent config inside
 * a throwaway sandbox (never on the host), validate it, and hand the result
 * to the shared deploy core. Failures come back as plain-text messages so
 * the coding agent (and the UI) can show — and fix — them.
 */

import { ASSEMBLYAI_API_KEY_ENV } from "@alexkroman1/aai/stt";
import { resolveHarnessPath } from "aai-server/constants";
import { type DeployDeps, deployAgentBundle, extractAgentConfig } from "aai-server/deploy";
import type { SandboxPool } from "aai-server/sandbox-pool";
import { describeBundle } from "aai-server/sandbox-vm";
import type { WorkspaceStore } from "aai-server/workspace-store";
import { getCachedBuild, putCachedBuild } from "./studio-build-cache.ts";
import type { StudioBuildRunner } from "./studio-build-protocol.ts";
import { resolveStudioBuildRunner } from "./studio-build-runner.ts";
import { StudioBuildError } from "./studio-errors.ts";
import { currentFilesHash, getWorkspace, mutateWorkspace } from "./studio-workspace.ts";
import { withWorkspaceLock } from "./studio-workspace-lock.ts";

export type StudioDeployResult =
  | { ok: true; slug: string; url: string }
  | { ok: false; error: string };

export type StudioDeployDeps = DeployDeps & {
  workspaces: WorkspaceStore;
  /** Warm harness pool — config extraction acquires from it when present. */
  pool?: SandboxPool | undefined;
  /**
   * Injectable for tests — defaults to the env-selected out-of-process build
   * runner (a local build subprocess in dev, the Modal build worker in
   * production; see `studio-build-runner.ts`).
   */
  build?: StudioBuildRunner;
  /** Injectable for tests — defaults to sandboxed `describeBundle`. */
  inspect?: (workerCode: string) => Promise<unknown>;
};

export type StudioDeployParams = {
  apiKey: string;
  scope: string;
  project: string;
  /** Env/secrets to merge into the agent's stored env. */
  env?: Record<string, string> | undefined;
};

/**
 * Build (or reuse) the deployable artifacts for one workspace content hash.
 *
 * Content-hash keyed build reuse: `test_agent` already built this exact
 * worker during the chat turn, and a repeat Publish of unchanged files built
 * both artifacts. A full hit skips materialize + both Vite passes; a
 * worker-only hit (the test_agent case) pays just the client build.
 *
 * @throws {StudioBuildError} on compile errors, exactly like the builders.
 */
async function buildArtifacts(
  deps: StudioDeployDeps,
  files: Record<string, string>,
  hash: string,
): Promise<{ worker: string; clientFiles: Record<string, string> }> {
  const build = deps.build ?? resolveStudioBuildRunner();
  const cached = getCachedBuild(hash);
  let worker = cached?.worker;
  let clientFiles = cached?.clientFiles;
  if (worker === undefined || clientFiles === undefined) {
    // One runner call builds whatever the cache is missing — one materialize
    // feeds both Vite passes (and on the Modal backend, one remote hop).
    const built = await build({
      files,
      worker: worker === undefined,
      client: clientFiles === undefined,
    });
    worker ??= built.worker;
    clientFiles ??= built.clientFiles;
  }
  if (worker === undefined || clientFiles === undefined) {
    throw new Error("Build runner returned incomplete artifacts");
  }
  putCachedBuild(hash, { worker, clientFiles });
  return { worker, clientFiles };
}

export async function deployStudioProject(
  deps: StudioDeployDeps,
  params: StudioDeployParams,
): Promise<StudioDeployResult> {
  const workspace = await getWorkspace(deps.workspaces, params.scope, params.project);
  if (!workspace) return { ok: false, error: `Project not found: ${params.project}` };

  // Computed once and reused for the build cache and `deployedHash` below.
  const hash = currentFilesHash(workspace);
  let worker: string;
  let clientFiles: Record<string, string>;
  try {
    // A build failure is a message the coding agent can act on, not an
    // exception.
    ({ worker, clientFiles } = await buildArtifacts(deps, workspace.files, hash));
  } catch (err) {
    if (err instanceof StudioBuildError) return { ok: false, error: err.message };
    throw err;
  }

  const inspect =
    deps.inspect ??
    ((code: string) =>
      describeBundle({ harnessPath: resolveHarnessPath(), workerCode: code, pool: deps.pool }));
  const extraction = await extractAgentConfig(inspect, worker);
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
  return { ok: true, slug: outcome.slug, url: `/${outcome.slug}/` };
}
