// Copyright 2025 the AAI authors. MIT license.

import { type BundleOutput, buildAgentBundle } from "./_bundler.ts";
import { runDeploy } from "./_deploy.ts";
import {
  generateSlug,
  getApiKey,
  readProjectConfig,
  resolveServerUrl,
  writeProjectConfig,
} from "./_discover.ts";
import { consola } from "./_ui.ts";

async function deployBundle(opts: {
  bundle: BundleOutput;
  serverUrl: string;
  apiKey: string;
  slug: string;
  cwd: string;
}): Promise<string> {
  const { bundle, serverUrl, apiKey, cwd } = opts;
  let { slug } = opts;

  consola.start(`Deploy ${slug}`);
  const deployed = await runDeploy({
    url: serverUrl,
    bundle,
    env: { ASSEMBLYAI_API_KEY: apiKey },
    slug,
    apiKey,
  });
  slug = deployed.slug;

  await writeProjectConfig(cwd, { slug, serverUrl });

  const agentUrl = `${serverUrl}/${slug}`;
  consola.success(`Ready ${agentUrl}`);
  return agentUrl;
}

export async function runDeployCommand(opts: {
  cwd: string;
  server?: string;
  dryRun?: boolean;
}): Promise<void> {
  const { cwd } = opts;
  const dryRun = opts.dryRun ?? false;
  const apiKey = dryRun ? "" : await getApiKey();
  const projectConfig = await readProjectConfig(cwd);
  const serverUrl = resolveServerUrl(opts.server, projectConfig?.serverUrl);
  const slug = projectConfig?.slug ?? generateSlug();

  const bundle = await buildAgentBundle(cwd);

  if (dryRun) {
    consola.info(`Dry run: would deploy as ${slug}`);
    return;
  }

  await deployBundle({ bundle, serverUrl, apiKey, slug, cwd });
}
