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

/** Timeout for isolate to announce its RPC port after boot (ms). */
export const PORT_ANNOUNCE_TIMEOUT_MS = 15_000;

/** Timeout for the config RPC call to the isolate after port is ready (ms). */
export const CONFIG_TIMEOUT_MS = 10_000;

// ─── Sidecar ─────────────────────────────────────────────────────────────

/** Per-fetch timeout for the sidecar's SSRF-safe fetch proxy (ms). */
export const FETCH_PROXY_TIMEOUT_MS = 15_000;

/** Maximum response body size the sidecar will buffer (bytes, 1 MB). */
export const MAX_RESPONSE_BODY_BYTES = 1_048_576;

/** Timeout for sidecar HTTP server to start listening (ms). */
export const SIDECAR_STARTUP_TIMEOUT_MS = 10_000;

// ─── Slot lifecycle ──────────────────────────────────────────────────────

/** Default idle timeout before an agent slot is evicted (ms, 5 min). */
export const DEFAULT_SLOT_IDLE_MS = 5 * 60 * 1000;

// ─── Auth ────────────────────────────────────────────────────────────────

/** Maximum entries in the API key hash LRU cache. */
export const AUTH_HASH_CACHE_MAX = 100;

// ─── Harness runtime (isolate-side) ──────────────────────────────────────
// These are duplicated as literals in _harness-runtime.ts because the
// harness cannot import workspace packages at runtime (secure-exec
// constraint). The constant-sync build plugin enforces they stay in sync.

/** Tool execution timeout inside the isolate (ms). Must match TOOL_EXECUTION_TIMEOUT_MS. */
export const HARNESS_TOOL_TIMEOUT_MS = 30_000;

/** Maximum HTTP request body the harness RPC server will accept (bytes, 5 MB). */
export const HARNESS_MAX_BODY_SIZE = 5 * 1024 * 1024;

// ─── Deploy ──────────────────────────────────────────────────────────────

/** Maximum worker bundle size (bytes, 10 MB). */
export const MAX_WORKER_SIZE = 10_000_000;
