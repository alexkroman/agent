// Copyright 2025 the AAI authors. MIT license.
/**
 * Pure boot-time helpers for the platform server entry point (index.ts).
 * Extracted so the env-validation and sizing logic is unit-testable without
 * starting a server.
 */

import { DEFAULT_SHUTDOWN_DRAIN_MS } from "./constants.ts";

export function requireEnv<const K extends string>(
  env: NodeJS.ProcessEnv,
  keys: readonly K[],
): { [P in K]: string } {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  return Object.fromEntries(keys.map((k) => [k, env[k]])) as { [P in K]: string };
}

export function isLocalDev(env: NodeJS.ProcessEnv): boolean {
  return env.AAI_LOCAL_DEV === "1" || !env.SUPABASE_S3_ENDPOINT;
}

/**
 * Hard ceiling on the warm sandbox pool. Mirrors `POOL_SIZE_MAX` in
 * sandbox-pool.ts (which clamps again defensively) so the boot log and the
 * `warm_pool_target` metric report the size the pool will actually run at.
 */
const POOL_SIZE_MAX = 16;

/**
 * Parse `SANDBOX_POOL_SIZE`: null (pool disabled) for unset, non-numeric,
 * zero, or negative values; otherwise the integer clamped to POOL_SIZE_MAX.
 */
export function resolvePoolSize(raw: string | undefined): number | null {
  if (!raw) return null;
  const size = Number.parseInt(raw, 10);
  if (!Number.isFinite(size) || size < 1) return null;
  return Math.min(size, POOL_SIZE_MAX);
}

/**
 * Parse `SHUTDOWN_DRAIN_MS`: how long shutdown waits for live sessions before
 * force-closing them. Unset or unparseable falls back to
 * {@link DEFAULT_SHUTDOWN_DRAIN_MS}.
 *
 * `0` is honored as "don't wait" rather than treated as unset — it is the way
 * to get the old close-immediately behavior back, and silently substituting a
 * two-minute default for it would make a deploy look hung.
 */
export function resolveDrainMs(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_SHUTDOWN_DRAIN_MS;
  const ms = Number.parseInt(raw, 10);
  if (!Number.isFinite(ms) || ms < 0) return DEFAULT_SHUTDOWN_DRAIN_MS;
  return ms;
}
