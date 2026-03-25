// Copyright 2025 the AAI authors. MIT license.

import type { BundleOutput } from "./_bundler.ts";
import { generateSlug } from "./_discover.ts";

export type DeployOpts = {
  url: string;
  bundle: BundleOutput;
  /** Env var values from .env to send to the server. */
  env: Record<string, string>;
  slug: string;
  apiKey: string;
  /** Optional fetch implementation for testing. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
};

export type DeployResult = {
  slug: string;
};

async function attemptDeploy(
  fetchFn: typeof globalThis.fetch,
  url: string,
  slug: string,
  apiKey: string,
  env: Record<string, string>,
  worker: string,
  clientFiles: Record<string, string>,
): Promise<Response> {
  try {
    return await fetchFn(`${url}/${slug}/deploy`, {
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
    const hint = url.startsWith("http://localhost")
      ? "Is the local dev server running? Start it with `aai dev`."
      : "Check your network connection and verify the server URL is correct.";
    throw new Error(`deployment failed: could not reach ${url}\n  ${hint}`);
  }
}

const MAX_RETRIES = 20;

export async function runDeploy(opts: DeployOpts): Promise<DeployResult> {
  const { worker, clientFiles } = opts.bundle;
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  let slug = opts.slug;

  // Try deploying, generating a new slug on 403
  for (let i = 0; i < MAX_RETRIES; i++) {
    const resp = await attemptDeploy(
      fetchFn,
      opts.url,
      slug,
      opts.apiKey,
      opts.env,
      worker,
      clientFiles,
    );

    if (resp.ok) {
      return { slug };
    }

    const text = await resp.text();

    if (resp.status === 403 && text.includes("Slug")) {
      // Slug conflict — generate a new one and retry
      slug = generateSlug();
      continue;
    }

    const hint =
      resp.status === 401
        ? "Your API key may be invalid. Check ~/.config/aai/config.json or set ASSEMBLYAI_API_KEY."
        : resp.status === 413
          ? "Your bundle is too large. Try reducing dependencies or splitting your agent."
          : "";
    throw new Error(`deploy failed (HTTP ${resp.status}): ${text}${hint ? `\n  ${hint}` : ""}`);
  }

  throw new Error(
    `deploy failed: could not find an available agent slug after ${MAX_RETRIES} attempts. ` +
      "Try setting a custom slug in .aai/project.json.",
  );
}
