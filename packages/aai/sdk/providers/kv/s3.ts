// Copyright 2025 the AAI authors. MIT license.
/**
 * S3-compatible KV descriptor.
 *
 * Resolves to unstorage's `s3` driver — works with AWS S3, Tigris,
 * Cloudflare R2, and other S3-protocol stores. Credentials are
 * pulled from the agent env at session start (the descriptor stays
 * secret-free).
 *
 * Required agent env: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
 * Optional: `AWS_SESSION_TOKEN` (for temporary credentials).
 */

import type { KvProvider } from "../../providers.ts";

export const S3_KV_KIND = "s3" as const;

export interface S3KvOptions {
  bucket: string;
  /** Custom endpoint URL — required for non-AWS providers (Tigris, R2). */
  endpoint?: string;
  /** Region. Defaults to `"auto"`. */
  region?: string;
}

export type S3KvProvider = KvProvider & {
  readonly kind: typeof S3_KV_KIND;
  readonly options: S3KvOptions;
};

export function s3Kv(opts: S3KvOptions): S3KvProvider {
  return { kind: S3_KV_KIND, options: { ...opts } };
}
