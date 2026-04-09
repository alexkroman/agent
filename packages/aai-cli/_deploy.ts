// Copyright 2025 the AAI authors. MIT license.

import { apiRequestOrThrow } from "./_api-client.ts";
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
  const body = JSON.stringify({
    ...(opts.slug ? { slug: opts.slug } : {}),
    env: opts.env,
    manifest: opts.bundle.manifest,
    toolBundles: opts.bundle.toolBundles,
    hookBundles: opts.bundle.hookBundles,
  });

  const resp = await apiRequestOrThrow(
    `${opts.url}/deploy`,
    { method: "POST", body, apiKey: opts.apiKey, action: "deploy" },
    {
      hints: {
        413: "Your bundle is too large. Try reducing dependencies or splitting your agent.",
      },
      fetch: opts.fetch,
    },
  );

  const data = (await resp.json()) as { slug: string };
  return { slug: data.slug };
}
