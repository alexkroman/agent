// Copyright 2025 the AAI authors. MIT license.

import type { BundleOutput } from "./_bundler.ts";
import { generateSlug } from "./_discover.ts";

export const _internals = {
  fetch: globalThis.fetch.bind(globalThis),
};

export type DeployOpts = {
  url: string;
  bundle: BundleOutput;
  /** Env var values from .env to send to the server. */
  env: Record<string, string>;
  slug: string;
  apiKey: string;
};

export type DeployResult = {
  slug: string;
};

async function attemptDeploy(
  url: string,
  slug: string,
  apiKey: string,
  env: Record<string, string>,
  worker: string,
  clientFiles: Record<string, string>,
): Promise<Response> {
  try {
    return await _internals.fetch(`${url}/${slug}/deploy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        env,
        worker,
        clientFiles,
      }),
    });
  } catch {
    throw new Error(`deployment failed: could not reach ${url}`);
  }
}

const MAX_RETRIES = 20;

export async function runDeploy(opts: DeployOpts): Promise<DeployResult> {
  const { worker, clientFiles } = opts.bundle;
  let slug = opts.slug;

  // Try deploying, generating a new slug on 403
  for (let i = 0; i < MAX_RETRIES; i++) {
    const resp = await attemptDeploy(opts.url, slug, opts.apiKey, opts.env, worker, clientFiles);

    if (resp.ok) {
      return { slug };
    }

    const text = await resp.text();

    if (resp.status === 403 && text.includes("Slug")) {
      // Slug conflict — generate a new one and retry
      slug = generateSlug();
      continue;
    }

    throw new Error(`deploy failed (${resp.status}): ${text}`);
  }

  throw new Error(`deploy failed: could not find available slug after ${MAX_RETRIES} attempts`);
}
