// Copyright 2025 the AAI authors. MIT license.

import { resolveServerUrl } from "./_agent.ts";
import { buildAgentBundle } from "./_bundler.ts";
import { readProjectConfig, writeProjectConfig } from "./_config.ts";
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

  const env = await resolveServerEnv(cwd);
  const apiKey = env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No ASSEMBLYAI_API_KEY found in .env file. Add it to your agent's .env:\n\n" +
        "  ASSEMBLYAI_API_KEY=your-key-here\n\n" +
        "Get a key at https://www.assemblyai.com/dashboard/signup",
    );
  }

  log.step(`Deploying${slug ? ` ${slug}` : ""}…`);
  const deployed = await runDeploy({
    url: serverUrl,
    bundle,
    env,
    ...(slug ? { slug } : {}),
    apiKey,
  });

  await writeProjectConfig(cwd, { slug: deployed.slug, serverUrl });

  const agentUrl = `${serverUrl}/${deployed.slug}`;
  log.success(`Deployed ${fmtUrl(agentUrl)}`);

  return ok({ slug: deployed.slug, url: agentUrl });
}

export async function runDeployCommand(opts: { cwd: string; server?: string }): Promise<void> {
  await executeDeploy(opts);
}
