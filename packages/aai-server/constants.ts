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

/** Default idle timeout before an agent slot is evicted (ms, 5 min). */
export const DEFAULT_SLOT_IDLE_MS = 5 * 60 * 1000;

// ─── Auth ────────────────────────────────────────────────────────────────

/** Maximum entries in the API key hash LRU cache. */
export const AUTH_HASH_CACHE_MAX = 100;

// ─── Server ─────────────────────────────────────────────────────────────

/** Default HTTP server listen port. */
export const DEFAULT_PORT = 8787;

/** Default credential key derivation scope when KV_SCOPE_SECRET is unset. */
export const DEFAULT_CREDENTIAL_SCOPE = "default-credential-key";

// ─── Deploy ──────────────────────────────────────────────────────────────

/** Maximum worker bundle size (bytes, 10 MB). */
export const MAX_WORKER_SIZE = 10_000_000;

// ─── Process jail ───────────────────────────────────────────────────────

/** Total memory limit for nsjail cgroup (V8 heap + Rust runtime overhead, MB). */
export const JAIL_MEMORY_LIMIT_MB = 256;
