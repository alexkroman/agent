// Copyright 2025 the AAI authors. MIT license.
// Server-specific constants. SDK-level constants live in aai.

import path from "node:path";

/** 64 KB. */
export const MAX_ENV_SIZE = 65_536;

export const DEFAULT_PORT = 8080;

/** Max concurrent WebSocket connections before the server rejects new upgrades. */
export const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 100;

/** Idle time before a resident sandbox is evicted. Bumped on each session start. */
export const IDLE_SANDBOX_MS = 5 * 60 * 1000;

/** 10 MB. */
export const MAX_WORKER_SIZE = 10_000_000;

/**
 * How long shutdown waits for live sessions to end before force-closing them.
 *
 * Must stay below `kill_timeout` in fly.toml (currently 150s) with room for
 * sandbox teardown afterwards, or Fly SIGKILLs the process mid-drain and the
 * wait accomplishes nothing. Override with `SHUTDOWN_DRAIN_MS`.
 */
export const DEFAULT_SHUTDOWN_DRAIN_MS = 120_000;

/** How often the drain loop re-checks the live-session count. */
export const DRAIN_POLL_MS = 250;

// ── Storage layout ──
// Single source of truth for the `agents/{slug}` storage namespace. Note
// that the platform-default KV lives under the same prefix, so a prefix
// sweep of `agentPrefix(slug)` (deploy/delete) also removes the agent's
// KV data.

/** Root storage prefix for everything belonging to one agent. */
export function agentPrefix(slug: string): string {
  return `agents/${slug}`;
}

/** Storage key for one file of an agent's bundle (manifest, worker, client assets). */
export function agentObjectKey(slug: string, file: string): string {
  return `${agentPrefix(slug)}/${file}`;
}

/** Storage prefix for the agent's platform-default KV data. */
export function agentKvPrefix(slug: string): string {
  return `${agentPrefix(slug)}/kv`;
}

/** Locate the built Deno guest harness (overridable via GUEST_HARNESS_PATH). */
export function resolveHarnessPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.GUEST_HARNESS_PATH ?? path.resolve(import.meta.dirname, "dist/guest/deno-harness.mjs");
}
