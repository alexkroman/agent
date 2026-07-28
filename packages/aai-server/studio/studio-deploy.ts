// Copyright 2025 the AAI authors. MIT license.
/**
 * Studio deploy flow: bundle the workspace, extract the agent config inside
 * a throwaway sandbox (never on the host), validate it, and hand the result
 * to the shared deploy core. Failures come back as plain-text messages so
 * the coding agent (and the UI) can show — and fix — them.
 */

import type { Storage } from "unstorage";
import { resolveHarnessPath } from "../constants.ts";
import { type DeployDeps, deployAgentBundle } from "../deploy.ts";
import { IsolateConfigSchema } from "../rpc-schemas.ts";
import { describeBundle } from "../sandbox-vm.ts";
import { hashApiKey } from "../secrets.ts";
import { bundleWorkspace, StudioBuildError } from "./studio-bundle.ts";
import { getWorkspace, putWorkspace } from "./studio-workspace.ts";

export type StudioDeployResult =
  | { ok: true; slug: string; url: string }
  | { ok: false; error: string };

export type StudioDeployDeps = DeployDeps & {
  storage: Storage;
  /** Injectable for tests — defaults to the real esbuild bundler. */
  bundle?: (files: Record<string, string>) => Promise<string>;
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

export async function deployStudioProject(
  deps: StudioDeployDeps,
  params: StudioDeployParams,
): Promise<StudioDeployResult> {
  const workspace = await getWorkspace(deps.storage, params.scope, params.project);
  if (!workspace) return { ok: false, error: `Project not found: ${params.project}` };

  const bundle = deps.bundle ?? bundleWorkspace;
  let worker: string;
  try {
    worker = await bundle(workspace.files);
  } catch (err) {
    if (err instanceof StudioBuildError) return { ok: false, error: err.message };
    throw err;
  }

  const inspect =
    deps.inspect ??
    ((code: string) => describeBundle({ harnessPath: resolveHarnessPath(), workerCode: code }));
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
      keyHash: await hashApiKey(params.apiKey),
      worker,
      clientFiles: {},
      env: params.env,
      agentConfig: parsed.data,
    },
  );
  if (!outcome.ok) return { ok: false, error: outcome.error };

  if (workspace.deployedSlug !== outcome.slug) {
    await putWorkspace(deps.storage, params.scope, params.project, {
      files: workspace.files,
      deployedSlug: outcome.slug,
    });
  }
  return { ok: true, slug: outcome.slug, url: `/${outcome.slug}/` };
}
