// Copyright 2025 the AAI authors. MIT license.
/**
 * Studio deploy flow: bundle the workspace, extract the agent config inside
 * a throwaway sandbox (never on the host), validate it, and hand the result
 * to the shared deploy core. Failures come back as plain-text messages so
 * the coding agent (and the UI) can show — and fix — them.
 */

import { ASSEMBLYAI_API_KEY_ENV } from "@alexkroman1/aai/stt";
import type { Storage } from "unstorage";
import { resolveHarnessPath } from "../constants.ts";
import { type DeployDeps, deployAgentBundle } from "../deploy.ts";
import { IsolateConfigSchema } from "../rpc-schemas.ts";
import type { SandboxPool } from "../sandbox-pool.ts";
import { describeBundle } from "../sandbox-vm.ts";
import { getCachedBuild, putCachedBuild } from "./studio-build-cache.ts";
import { bundleWorkspaceWorker } from "./studio-bundle.ts";
import { buildWorkspaceClient } from "./studio-client-build.ts";
import { StudioBuildError } from "./studio-errors.ts";
import { currentFilesHash, getWorkspace, putWorkspace } from "./studio-workspace.ts";
import { withWorkspaceDir } from "./studio-workspace-dir.ts";

export type StudioDeployResult =
  | { ok: true; slug: string; url: string }
  | { ok: false; error: string };

export type StudioDeployDeps = DeployDeps & {
  storage: Storage;
  /** Warm harness pool — config extraction acquires from it when present. */
  pool?: SandboxPool | undefined;
  /** Injectable for tests — defaults to the CLI's Vite worker build. */
  bundle?: (dir: string) => Promise<string>;
  /** Injectable for tests — defaults to sandboxed `describeBundle`. */
  inspect?: (workerCode: string) => Promise<unknown>;
  /** Injectable for tests — defaults to the CLI's Vite client build. */
  buildClient?: (dir: string) => Promise<Record<string, string>>;
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
  const bundle = deps.bundle ?? bundleWorkspaceWorker;
  const buildClient = deps.buildClient ?? buildWorkspaceClient;
  const cached = getCachedBuild(hash);
  let worker: string;
  let clientFiles: Record<string, string>;
  if (cached?.worker !== undefined && cached.clientFiles !== undefined) {
    worker = cached.worker;
    clientFiles = cached.clientFiles;
  } else if (cached?.worker !== undefined) {
    worker = cached.worker;
    clientFiles = await withWorkspaceDir(files, buildClient);
  } else {
    // One materialize feeds both builds — they read the same scratch dir and
    // are otherwise independent.
    [worker, clientFiles] = await withWorkspaceDir(files, (dir) =>
      Promise.all([bundle(dir), buildClient(dir)]),
    );
  }
  putCachedBuild(hash, { worker, clientFiles });
  return { worker, clientFiles };
}

export async function deployStudioProject(
  deps: StudioDeployDeps,
  params: StudioDeployParams,
): Promise<StudioDeployResult> {
  const workspace = await getWorkspace(deps.storage, params.scope, params.project);
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
  let rawConfig: unknown;
  try {
    rawConfig = await inspect(worker);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Agent bundle failed to load: ${message}` };
  }

  const parsed = IsolateConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.message).join("; ");
    return { ok: false, error: `Invalid agent config: ${issues}` };
  }

  const outcome = await deployAgentBundle(
    { store: deps.store, slots: deps.slots },
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
      agentConfig: parsed.data,
    },
  );
  if (!outcome.ok) return { ok: false, error: outcome.error };

  // Always written, not just on a slug change: `deployedHash` is what tells
  // the preview whether the running agent still matches the editor, so a
  // redeploy to the same slug has to refresh it too.
  await putWorkspace(deps.storage, params.scope, params.project, {
    files: workspace.files,
    deployedSlug: outcome.slug,
    deployedHash: hash,
  });
  return { ok: true, slug: outcome.slug, url: `/${outcome.slug}/` };
}
