// Copyright 2025 the AAI authors. MIT license.
/**
 * Centralised numeric constants for the platform server.
 *
 * SDK-level constants (TOOL_EXECUTION_TIMEOUT_MS, etc.)
 * live in @alexkroman1/aai-core. This file holds server-specific values.
 */

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
