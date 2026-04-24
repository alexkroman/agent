// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared helper for API key resolution. Lives outside `resolve.ts` so the
 * concrete openers (KV, vector, etc.) can import it without creating a
 * cycle through the resolver registry.
 */

/**
 * Look up a provider API key: agent env first (set via `aai secret put` or
 * `.env`), then the host's `process.env` as a fallback for self-hosted mode.
 * Returns `""` if neither has it — the caller decides whether that's fatal.
 */
export function resolveApiKey(envVar: string, env: Record<string, string>): string {
  return env[envVar] ?? process.env[envVar] ?? "";
}
