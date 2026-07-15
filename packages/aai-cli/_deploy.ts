// Copyright 2025 the AAI authors. MIT license.

import { apiRequest } from "./_api-client.ts";
import type { DirectoryBundleOutput } from "./_bundler.ts";

export type DeployOpts = {
  url: string;
  bundle: DirectoryBundleOutput;
  /** Env var values from .env to send to the server. */
  env: Record<string, string>;
  /** Existing slug for redeployment. Omit for first deploy — server generates one. */
  slug?: string;
  apiKey: string;
  /** Optional fetch implementation for testing. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
};

export type DeployResult = {
  slug: string;
};

export async function runDeploy(opts: DeployOpts): Promise<DeployResult> {
  const data = await apiRequest<{ slug: string }>(`${opts.url}/deploy`, {
    method: "POST",
    body: {
      ...(opts.slug ? { slug: opts.slug } : {}),
      env: opts.env,
      worker: opts.bundle.worker,
      clientFiles: opts.bundle.clientFiles,
      agentConfig: opts.bundle.agentConfig,
    },
    apiKey: opts.apiKey,
    action: "deploy",
    hints: {
      413: "Your bundle is too large. Try reducing dependencies or splitting your agent.",
    },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  return { slug: data.slug };
}
