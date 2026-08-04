// Copyright 2025 the AAI authors. MIT license.

import { resolveDeployTarget } from "./_agent.ts";
import { buildAgentBundle } from "./_bundler.ts";
import { updateProjectConfig } from "./_config.ts";
import { runDeploy } from "./_deploy.ts";
import { type CommandResult, ok } from "./_output.ts";
import { resolveServerEnv } from "./_server-common.ts";
import { assertTypechecks } from "./_typecheck-gate.ts";
import { fmtUrl, log } from "./_ui.ts";
import { errorMessage } from "./_utils.ts";

type DeployData = { slug: string; url: string; warnings?: string[] };

export async function executeDeploy(opts: {
  cwd: string;
  server?: string | undefined;
  /** See DeployOpts.allowMissingSecrets (`--allow-missing-secrets`). */
  allowMissingSecrets?: boolean | undefined;
  /** See DeployOpts.allowPreviewSlug (`--allow-preview-slug`; studio-internal). */
  allowPreviewSlug?: boolean | undefined;
  /** `--skipTypecheck`: deploy without the tsc gate. */
  skipTypecheck?: boolean | undefined;
}): Promise<CommandResult<DeployData>> {
  const { cwd } = opts;
  const { config: projectConfig, serverUrl, apiKey } = await resolveDeployTarget(cwd, opts.server);
  if (!opts.skipTypecheck) await assertTypechecks(cwd);
  // Minify the worker for deploy — smaller upload and stored bundle. Dev
  // builds (`aai dev`) stay unminified for readable stack traces.
  const bundle = await buildAgentBundle(cwd, { minify: true });
  const slug = projectConfig?.slug;

  const env = await resolveServerEnv(cwd);

  log.step(`Deploying${slug ? ` ${slug}` : ""}…`);
  const deployed = await runDeploy({
    url: serverUrl,
    bundle,
    // The login key is a FLOOR, not an override: an ASSEMBLYAI_API_KEY the
    // user declared in .env deliberately targets a different account and
    // must win — matching the server's own defaultEnv merge semantics.
    env: { ASSEMBLYAI_API_KEY: apiKey, ...env },
    ...(slug ? { slug } : {}),
    ...(opts.allowMissingSecrets ? { allowMissingSecrets: true } : {}),
    ...(opts.allowPreviewSlug ? { allowPreviewSlug: true } : {}),
    apiKey,
  });

  const agentUrl = `${serverUrl}/${deployed.slug}`;

  // The deploy already succeeded server-side — a failure to record the slug
  // must not read as a failed deploy (and must surface the slug loudly, or
  // the next `aai deploy` would mint a fresh slug and orphan this agent).
  try {
    // Merge, never replace: a studio-linked directory's link fields
    // (studioProject/studioSourceHash) must survive a deploy.
    await updateProjectConfig(cwd, { slug: deployed.slug, serverUrl });
  } catch (err) {
    log.warn(
      `Deployed as ${deployed.slug}, but couldn't save .aai/project.json: ${errorMessage(err)}\n` +
        "  Write it manually so future deploys reuse this slug:\n" +
        `  ${JSON.stringify({ slug: deployed.slug, serverUrl })}`,
    );
  }

  for (const warning of deployed.warnings ?? []) log.warn(warning);
  log.success(`Deployed ${fmtUrl(agentUrl)}`);

  return ok({
    slug: deployed.slug,
    url: agentUrl,
    ...(deployed.warnings ? { warnings: deployed.warnings } : {}),
  });
}
