// Copyright 2025 the AAI authors. MIT license.
// Server-specific constants. SDK-level constants live in aai.

/** 64 KiB. */
export const MAX_ENV_SIZE = 64 * 1024;

export const DEFAULT_PORT = 8080;

/** Max concurrent WebSocket connections before the server rejects new upgrades. */
export const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 100;

/** Idle time before a resident sandbox is evicted. Bumped on each session start. */
export const IDLE_SANDBOX_MS = 5 * 60 * 1000;

/** 10,000,000 bytes (10 MB, decimal). */
export const MAX_WORKER_SIZE = 10_000_000;

export function agentKvPrefix(slug: string): string {
  return `agents/${slug}/kv`;
}
