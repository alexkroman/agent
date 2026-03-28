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

const MAX_SLUG_RETRIES = 20;

type AttemptResult =
  | { ok: true; slug: string }
  | { ok: false; retry: true }
  | { ok: false; retry: false; error: string };

async function attempt(
  fetchFn: typeof globalThis.fetch,
  url: string,
  slug: string,
  body: string,
  apiKey: string,
): Promise<AttemptResult> {
  let resp: Response;
  try {
    resp = await fetchFn(`${url}/${slug}/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body,
    });
  } catch (err: unknown) {
    const hint = url.startsWith("http://localhost")
      ? "Is the local dev server running? Start it with `aai dev`."
      : "Check your network connection and verify the server URL is correct.";
    throw new Error(`deployment failed: could not reach ${url}\n  ${hint}`, { cause: err });
  }

  if (resp.ok) return { ok: true, slug };

  const text = await resp.text();

  if (resp.status === 403 && text.includes("owned by another")) {
    return { ok: false, retry: true };
  }

  let hint = "";
  if (resp.status === 401) {
    hint =
      "Your API key may be invalid. Check ~/.config/aai/config.json or set ASSEMBLYAI_API_KEY.";
  } else if (resp.status === 403 && text.includes("Slug")) {
    hint = "This slug is already taken. Set a different slug in .aai/project.json.";
  } else if (resp.status === 413) {
    hint = "Your bundle is too large. Try reducing dependencies or splitting your agent.";
  }
  return {
    ok: false,
    retry: false,
    error: `deploy failed (HTTP ${resp.status}): ${text}${hint ? `\n  ${hint}` : ""}`,
  };
}

export async function runDeploy(opts: DeployOpts): Promise<DeployResult> {
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const body = JSON.stringify({
    env: opts.env,
    worker: opts.bundle.worker,
    clientFiles: opts.bundle.clientFiles,
  });
  let slug = opts.slug;

  for (let i = 0; i < MAX_SLUG_RETRIES; i++) {
    const result = await attempt(fetchFn, opts.url, slug, body, opts.apiKey);
    if (result.ok) return { slug: result.slug };
    if (!result.retry) throw new Error(result.error);
    slug = generateSlug();
  }

  throw new Error(`could not find an available agent slug after ${MAX_SLUG_RETRIES} attempts`);
}
