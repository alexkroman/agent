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
  return env.AAI_LOCAL_DEV === "1" || !env.SUPABASE_S3_ENDPOINT;
}

/**
 * Parse `PORT` for a service entry point. Unset/empty falls back to
 * `fallback`; anything else must be a valid port or boot fails loudly.
 *
 * Throwing beats falling back here: a platform-injected `PORT` that doesn't
 * parse (`Number.parseInt` on `tcp://…` is NaN) used to reach `listen(NaN)`,
 * which binds an EPHEMERAL port — the process boots "successfully" and looks
 * healthy locally while the proxy's configured port gets nothing.
 */
export function resolvePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid PORT "${raw}" — expected an integer between 0 and 65535`);
  }
  return port;
}
