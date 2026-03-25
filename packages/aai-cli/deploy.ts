// Copyright 2025 the AAI authors. MIT license.

import { buildAgentBundle } from "./_build.ts";
import type { BundleOutput } from "./_bundler.ts";
import { runDeploy } from "./_deploy.ts";
import {
  generateSlug,
  getApiKey,
  readProjectConfig,
  resolveServerUrl,
  writeProjectConfig,
} from "./_discover.ts";
import { runCommand, step, stepInfo } from "./_ui.ts";

async function deployBundle(opts: {
  bundle: BundleOutput;
  serverUrl: string;
  apiKey: string;
  slug: string;
  cwd: string;
  log: (msg: string) => void;
}): Promise<string> {
  const { bundle, serverUrl, apiKey, cwd, log } = opts;
  let { slug } = opts;

  log(step("Deploy", slug));
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
  log(step("Ready", agentUrl));
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

  await runCommand(async ({ log }) => {
    const bundle = await buildAgentBundle(cwd, log);

    if (dryRun) {
      log(stepInfo("Dry run", `would deploy as ${slug}`));
      return;
    }

    await deployBundle({ bundle, serverUrl, apiKey, slug, cwd, log });
  });
}
