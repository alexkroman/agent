// Copyright 2025 the AAI authors. MIT license.

import type { BundleOutput } from "./_bundler.ts";
import { generateSlug } from "./_discover.ts";
import { info, step, stepInfo, warn } from "./_output.ts";

export const _internals = {
  fetch: globalThis.fetch.bind(globalThis),
};

export type DeployOpts = {
  url: string;
  bundle: BundleOutput;
  /** Env var values from .env to send to the server. */
  env: Record<string, string>;
  slug: string;
  dryRun: boolean;
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
  transport: string[],
  worker: string,
  html: string,
  config: unknown,
  toolSchemas: unknown,
): Promise<Response> {
  return await _internals.fetch(`${url}/${slug}/deploy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      env,
      worker,
      html,
      transport,
      config,
      toolSchemas,
    }),
  });
}

const MAX_RETRIES = 20;

export async function runDeploy(opts: DeployOpts): Promise<DeployResult> {
  const manifest = JSON.parse(opts.bundle.manifest);
  const worker = opts.bundle.worker;
  const html = opts.bundle.html;
  const transport = manifest.transport ?? ["websocket"];
  const config = manifest.config;
  const toolSchemas = manifest.toolSchemas;

  let slug = opts.slug;

  if (opts.dryRun) {
    stepInfo("Dry run", "would deploy:");
    info(`${slug} -> ${opts.url}/${slug}`);
    return { slug };
  }

  // Try deploying, generating a new slug on 403
  for (let i = 0; i < MAX_RETRIES; i++) {
    const resp = await attemptDeploy(
      opts.url,
      slug,
      opts.apiKey,
      opts.env,
      transport,
      worker,
      html,
      config,
      toolSchemas,
    );

    if (resp.ok) {
      step("Deploy", `${slug} -> ${opts.url}/${slug}`);

      // Health check: best-effort verification
      try {
        const healthResp = await _internals.fetch(`${opts.url}/${slug}/health`);
        const ok = healthResp.ok && (await healthResp.json()).status === "ok";
        if (ok) {
          step("Ready", slug);
        } else {
          warn(`${slug} deployed but health check failed -- check for runtime errors`);
        }
      } catch {
        // Health check is best-effort
      }

      return { slug };
    }

    if (resp.status === 403) {
      const text = await resp.text();
      // Slug conflict — generate a new one and retry
      if (text.includes("Slug")) {
        const next = generateSlug();
        step("Retry", `slug "${slug}" taken, trying "${next}"`);
        slug = next;
        continue;
      }
    }

    const text = await resp.text();
    throw new Error(`deploy failed (${resp.status}): ${text}`);
  }

  throw new Error(`deploy failed: could not find available slug after ${MAX_RETRIES} attempts`);
}
