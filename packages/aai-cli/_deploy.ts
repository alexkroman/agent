// Copyright 2025 the AAI authors. MIT license.

import { gzipSync } from "node:zlib";
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
  /**
   * Ask the server to WARN (in `warnings`) instead of rejecting when the
   * agent's providers are missing credentials — `aai deploy
   * --allow-missing-secrets`, for setting them post-deploy with
   * `aai secret put` (the studio's publish flow relies on this: its Secrets
   * panel needs a deployed slug to attach secrets to).
   */
  allowMissingSecrets?: boolean;
  /**
   * Ask the server to permit a `-preview`-suffixed slug (`aai deploy
   * --allow-preview-slug`). That suffix is reserved for the studio's
   * auto-preview deploys — the server rejects it otherwise — and this is set
   * by the studio's own in-guest deploy, not by ordinary users.
   */
  allowPreviewSlug?: boolean;
  /** Retry delay override for tests (0 = no real sleeps on retry paths). */
  retryDelay?: number;
  /** Optional fetch implementation for testing. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
};

export type DeployResult = {
  slug: string;
  /** Server-side deploy warnings (e.g. the missing-credential preflight). */
  warnings?: string[];
};

export async function runDeploy(opts: DeployOpts): Promise<DeployResult> {
  // Gzip the JSON payload — worker + client files compress ~4-5x, cutting
  // upload time on slow links. Sent as a raw Buffer so ofetch passes it
  // through untouched; the server inflates on Content-Encoding: gzip.
  const body = gzipSync(
    JSON.stringify({
      ...(opts.slug ? { slug: opts.slug } : {}),
      // Kept for OLDER servers only: the current one runs no credential
      // preflight (the CLI does — see _preflight.ts) and strips this field.
      ...(opts.allowMissingSecrets ? { credentialPolicy: "warn" } : {}),
      ...(opts.allowPreviewSlug ? { allowPreviewSlug: true } : {}),
      env: opts.env,
      worker: opts.bundle.worker,
      clientFiles: opts.bundle.clientFiles,
    }),
  );
  const data = await apiRequest<{ slug: string; warnings?: string[] }>(`${opts.url}/deploy`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
    apiKey: opts.apiKey,
    action: "deploy",
    hints: {
      413: "Your bundle is too large. Try reducing dependencies or splitting your agent.",
    },
    // A slug-less first deploy is not idempotent: the server generates a
    // fresh slug per request, so retrying a request that succeeded but lost
    // its response would create a second, orphaned agent. Redeploys target a
    // fixed slug and stay retried.
    ...(opts.slug ? {} : { retry: 0 }),
    ...(opts.retryDelay !== undefined ? { retryDelay: opts.retryDelay } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  return { slug: data.slug, ...(data.warnings ? { warnings: data.warnings } : {}) };
}
