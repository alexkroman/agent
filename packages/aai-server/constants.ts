// Copyright 2025 the AAI authors. MIT license.
/**
 * Centralised numeric constants for the platform server.
 *
 * SDK-level constants (HOOK_TIMEOUT_MS, TOOL_EXECUTION_TIMEOUT_MS, etc.)
 * live in @alexkroman1/aai/constants. This file holds server-specific values.
 */

// ─── Sandbox isolate ─────────────────────────────────────────────────────

/** Memory limit for sandbox isolates (MB). */
export const SANDBOX_MEMORY_LIMIT_MB = 128;

/** Timeout for isolate to announce its port after boot (ms). */
export const PORT_ANNOUNCE_TIMEOUT_MS = 15_000;

// ─── Slot lifecycle ──────────────────────────────────────────────────────

/** Default idle timeout before an agent slot is evicted (ms, 1 min). */
export const DEFAULT_SLOT_IDLE_MS = Number(process.env.SLOT_IDLE_MS) || 60_000;

/**
 * Max active sandbox slots before the server rejects new sandbox spawns.
 * Tuned for 85% max utilization on shared-cpu-2x@2048MB:
 * ~93 MB baseline + ~130 MB V8 residual + (10 × ~70 MB/slot) ≈ 923 MB (45%).
 * Headroom covers real agents with LLM/STT sessions using more than minimal test agents.
 */
export const MAX_SLOTS = Number(process.env.MAX_SLOTS) || 10;

/** Max RSS in MB before rejecting new sandbox spawns (85% of 2048 MB). */
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
export const JAIL_MEMORY_LIMIT_MB = 192;
