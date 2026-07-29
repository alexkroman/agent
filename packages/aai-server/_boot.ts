// Copyright 2025 the AAI authors. MIT license.
/**
 * Pure boot-time helpers for the platform server entry point (index.ts).
 * Extracted so the env-validation and sizing logic is unit-testable without
 * starting a server.
 */

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
  return env.AAI_LOCAL_DEV === "1" || !env.BUCKET_NAME;
}

/**
 * Keys a local dev run needs to exercise the studio end to end.
 *
 * `ASSEMBLYAI_API_KEY` drives the chat LLM (and is seeded into every agent
 * published from the studio); `BRAVE_API_KEY` backs the coding agent's
 * `web_search`. Both are optional in production — the studio degrades
 * (chat 503s, web_search is dropped from the tool set) — but in dev that
 * degradation is silent and easy to mistake for a bug, so fail at boot
 * where the cause is obvious instead of ten minutes into a session.
 */
const DEV_REQUIRED_KEYS = ["ASSEMBLYAI_API_KEY", "BRAVE_API_KEY"] as const;

export function assertDevKeys(env: NodeJS.ProcessEnv): void {
  if (!isLocalDev(env) || env.AAI_DEV_SKIP_KEY_CHECK === "1") return;
  const missing = DEV_REQUIRED_KEYS.filter((key) => !env[key]);
  if (missing.length === 0) return;
  const it = missing.length === 1 ? "it" : "them";
  throw new Error(
    `Local dev is missing ${missing.join(" and ")}. Set ${it} in ` +
      "packages/aai-server/.env (or the shell) before `pnpm dev:aai-server`, " +
      "or set AAI_DEV_SKIP_KEY_CHECK=1 to start without.",
  );
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
