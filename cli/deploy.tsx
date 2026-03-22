// Copyright 2025 the AAI authors. MIT license.

import { buildAgentBundle } from "./_build.tsx";
import type { BundleOutput } from "./_bundler.ts";
import { runDeploy } from "./_deploy.ts";
import {
  generateSlug,
  getApiKey,
  readProjectConfig,
  resolveServerUrl,
  writeProjectConfig,
} from "./_discover.ts";
import { runWithInk, Step, StepInfo } from "./_ink.tsx";
import { askEnter } from "./_prompts.tsx";

async function deployBundle(opts: {
  bundle: BundleOutput;
  serverUrl: string;
  apiKey: string;
  slug: string;
  cwd: string;
  log: (el: React.ReactNode) => void;
}): Promise<string> {
  const { bundle, serverUrl, apiKey, cwd, log } = opts;
  let { slug } = opts;

  log(<Step action="Deploy" msg={slug} />);
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
  log(<Step action="Ready" msg={agentUrl} />);
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

  let agentUrl = "";

  await runWithInk(async ({ log }) => {
    const bundle = await buildAgentBundle(cwd, log);

    if (dryRun) {
      log(<StepInfo action="Dry run" msg={`would deploy as ${slug}`} />);
      return;
    }

    agentUrl = await deployBundle({ bundle, serverUrl, apiKey, slug, cwd, log });
  });

  if (agentUrl) {
    await askEnter("Press enter to open in browser");
    const { exec } = await import("node:child_process");
    exec(`open "${agentUrl}"`);
  }
}
