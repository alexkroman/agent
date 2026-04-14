// Copyright 2025 the AAI authors. MIT license.

import { resolveServerUrl } from "./_agent.ts";
import { buildAgentBundle } from "./_bundler.ts";
import { ensureApiKey, readProjectConfig, writeProjectConfig } from "./_config.ts";
import { runDeploy } from "./_deploy.ts";
import { type CommandResult, ok } from "./_output.ts";
import { resolveServerEnv } from "./_server-common.ts";
import { fmtUrl, log } from "./_ui.ts";

type DeployData = { slug: string; url: string };

export async function executeDeploy(opts: {
  cwd: string;
  server?: string;
}): Promise<CommandResult<DeployData>> {
  const { cwd } = opts;
  const projectConfig = await readProjectConfig(cwd);
  const serverUrl = resolveServerUrl(opts.server, projectConfig?.serverUrl);
  const bundle = await buildAgentBundle(cwd);
  const slug = projectConfig?.slug;

  const apiKey = await ensureApiKey();
  const env = await resolveServerEnv(cwd);

  log.step(`Deploying${slug ? ` ${slug}` : ""}…`);
  const deployed = await runDeploy({
    url: serverUrl,
    bundle,
    env: { ...env, ASSEMBLYAI_API_KEY: apiKey },
    ...(slug ? { slug } : {}),
    apiKey,
  });

  await writeProjectConfig(cwd, { slug: deployed.slug, serverUrl });

  const agentUrl = `${serverUrl}/${deployed.slug}`;
  log.success(`Deployed ${fmtUrl(agentUrl)}`);

  return ok({ slug: deployed.slug, url: agentUrl });
}
