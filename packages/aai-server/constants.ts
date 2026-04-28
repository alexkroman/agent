// Copyright 2025 the AAI authors. MIT license.
/**
 * Centralised numeric constants for the platform server.
 *
 * SDK-level constants (TOOL_EXECUTION_TIMEOUT_MS, etc.)
 * live in aai. This file holds server-specific values.
 */

// ─── Auth ────────────────────────────────────────────────────────────────

/** Maximum serialized env blob size in bytes (64 KB). */
export const MAX_ENV_SIZE = 65_536;

// ─── Server ─────────────────────────────────────────────────────────────

/** Default HTTP server listen port. */
export const DEFAULT_PORT = 8080;

/** Max concurrent WebSocket connections before the server rejects new upgrades. */
export const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 100;

/**
 * Time a sandbox stays resident with no active sessions before it's
 * evicted to free memory. Bumped on each session start.
 */
export const IDLE_SANDBOX_MS = 5 * 60 * 1000;

// ─── Deploy ──────────────────────────────────────────────────────────────

/** Maximum worker bundle size (bytes, 10 MB). */
export const MAX_WORKER_SIZE = 10_000_000;

/** KV storage prefix for a given agent slug. */
export function agentKvPrefix(slug: string): string {
  return `agents/${slug}/kv`;
}
