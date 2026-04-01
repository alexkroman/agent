// Copyright 2025 the AAI authors. MIT license.

import { apiError, apiRequest, HINT_INVALID_API_KEY } from "./_api-client.ts";
import type { BundleOutput } from "./_bundler.ts";

export type DeployOpts = {
  url: string;
  bundle: BundleOutput;
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
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const body = JSON.stringify({
    ...(opts.slug ? { slug: opts.slug } : {}),
    env: opts.env,
    worker: opts.bundle.worker,
    clientFiles: opts.bundle.clientFiles,
  });

  const resp = await apiRequest(
    `${opts.url}/deploy`,
    { method: "POST", body, apiKey: opts.apiKey, action: "deploy" },
    fetchFn,
  );

  if (resp.ok) {
    const data = (await resp.json()) as { slug: string };
    return { slug: data.slug };
  }

  const text = await resp.text();
  let hint: string | undefined;
  if (resp.status === 401) {
    hint = HINT_INVALID_API_KEY;
  } else if (resp.status === 413) {
    hint = "Your bundle is too large. Try reducing dependencies or splitting your agent.";
  }
  throw new Error(apiError("deploy", resp.status, text, hint).message);
}
