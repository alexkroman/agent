// Copyright 2025 the AAI authors. MIT license.
/**
 * Centralised numeric constants for the platform server.
 *
 * SDK-level constants (HOOK_TIMEOUT_MS, TOOL_EXECUTION_TIMEOUT_MS, etc.)
 * live in @alexkroman1/aai/constants. This file holds server-specific values.
 */

// ─── Sandbox isolate ─────────────────────────────────────────────────────

/** Memory limit for sandbox isolates (MB). Most templates use 0.3–26 MB at boot. */
export const SANDBOX_MEMORY_LIMIT_MB = 64;

// ─── Slot lifecycle ──────────────────────────────────────────────────────

/**
 * Max RSS in MB before evicting cold slots / rejecting new spawns.
 * Set to 85% of 2048 MB. This is the sole admission gate — isolates are
 * cheap (~1 MB each), so a fixed slot count is unnecessary.
 *
 * Note: SECURE_EXEC_V8_MAX_SESSIONS env var must be set high enough in
 * production to avoid session creation failures in the Rust V8 runtime.
 */
export const MAX_RSS_MB = Number(process.env.MAX_RSS_MB) || 1740;

// ─── Auth ────────────────────────────────────────────────────────────────

/** Maximum entries in the API key hash LRU cache. */
export const AUTH_HASH_CACHE_MAX = 100;

// ─── Server ─────────────────────────────────────────────────────────────

/** Default HTTP server listen port. */
export const DEFAULT_PORT = 8080;

/** Default credential key derivation scope when KV_SCOPE_SECRET is unset. */
export const DEFAULT_CREDENTIAL_SCOPE = "default-credential-key";

/** Max concurrent WebSocket connections before the server rejects new upgrades. */
export const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 100;

// ─── Deploy ──────────────────────────────────────────────────────────────

/** Maximum worker bundle size (bytes, 10 MB). */
export const MAX_WORKER_SIZE = 10_000_000;

/** KV storage prefix for a given agent slug. */
export function agentKvPrefix(slug: string): string {
  return `agents/${slug}/kv`;
}

// ─── Process jail ───────────────────────────────────────────────────────

/** Total memory limit for nsjail cgroup (V8 heap + Rust runtime overhead, MB). */
export const JAIL_MEMORY_LIMIT_MB = 128;
