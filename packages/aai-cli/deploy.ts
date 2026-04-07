// Copyright 2025 the AAI authors. MIT license.

import { resolveServerUrl } from "./_agent.ts";
import { buildAgentBundle } from "./_bundler.ts";
import { getApiKey, readProjectConfig, writeProjectConfig } from "./_config.ts";
import { runDeploy } from "./_deploy.ts";
import { fmtUrl, log } from "./_ui.ts";

export async function runDeployCommand(opts: { cwd: string; server?: string }): Promise<void> {
  const { cwd } = opts;
  const apiKey = await getApiKey();
  const projectConfig = await readProjectConfig(cwd);
  const serverUrl = resolveServerUrl(opts.server, projectConfig?.serverUrl);
  const bundle = await buildAgentBundle(cwd);
  const slug = projectConfig?.slug;

  log.step(`Deploying${slug ? ` ${slug}` : ""}…`);
  const deployed = await runDeploy({
    url: serverUrl,
    bundle,
    env: { ASSEMBLYAI_API_KEY: apiKey },
    ...(slug ? { slug } : {}),
    apiKey,
  });

  await writeProjectConfig(cwd, { slug: deployed.slug, serverUrl });

  const agentUrl = `${serverUrl}/${deployed.slug}`;
  log.success(`Deployed ${fmtUrl(agentUrl)}`);
}
