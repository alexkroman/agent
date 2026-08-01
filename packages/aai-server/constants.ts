// Copyright 2025 the AAI authors. MIT license.
// Server-specific constants. SDK-level constants live in aai.

import { createRequire } from "node:module";

/** 64 KB. */
export const MAX_ENV_SIZE = 65_536;

export const DEFAULT_PORT = 8080;

/** Max concurrent WebSocket connections before the server rejects new upgrades. */
export const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 100;

/** Idle time before a resident sandbox is evicted. Bumped on each session start. */
export const IDLE_SANDBOX_MS = 5 * 60 * 1000;

/**
 * Horizontal sandbox scaling (see sandbox-scale.ts): live sessions per guest
 * sandbox before the broker scales the slug out to another sandbox replica.
 * Unset/0 disables scaling — one sandbox per slug, the pre-scaling behavior.
 */
export const SANDBOX_MAX_SESSIONS = Number(process.env.SANDBOX_MAX_SESSIONS) || 0;

/**
 * Cap on sandboxes per slug on this replica (primary included) when scaling
 * is enabled. Saturation past the cap routes to the least-loaded sandbox
 * rather than spawning without bound.
 */
export const SANDBOX_MAX_REPLICAS = Number(process.env.SANDBOX_MAX_REPLICAS) || 4;

/**
 * 30 MB. Workers ship their own SDK runtime + provider SDKs (the CLI
 * wrapper's `__aaiCreateRuntime` — see worker-bundler.ts), which is ~8 MB
 * minified before any user code; the cap bounds user code + assets on top.
 */
export const MAX_WORKER_SIZE = 30_000_000;

/**
 * How long shutdown waits for live sessions to end before force-closing them.
 *
 * Must stay below the platform's container stop grace period (Modal's
 * `scaledown_window` in modal_deploy.py) with room for sandbox teardown
 * afterwards, or the process is SIGKILLed mid-drain and the wait
 * accomplishes nothing. Override with `SHUTDOWN_DRAIN_MS`.
 */
export const DEFAULT_SHUTDOWN_DRAIN_MS = 120_000;

/** How often the drain loop re-checks the live-session count. */
export const DRAIN_POLL_MS = 250;

// ── Storage layout ──
// Single source of truth for the `agents/{slug}` storage namespace.

/** Root storage prefix for everything belonging to one agent. */
export function agentPrefix(slug: string): string {
  return `agents/${slug}`;
}

/** Storage key for one file of an agent's bundle (manifest, worker, client assets). */
export function agentObjectKey(slug: string, file: string): string {
  return `${agentPrefix(slug)}/${file}`;
}

/**
 * Locate the built Node guest harness — the `aai-guest` workspace package's
 * single-file artifact (overridable via GUEST_HARNESS_PATH). Resolved
 * lazily at sandbox creation, so a missing build fails the spawn loudly
 * rather than the server boot.
 */
export function resolveHarnessPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GUEST_HARNESS_PATH) return env.GUEST_HARNESS_PATH;
  try {
    return createRequire(import.meta.url).resolve("aai-guest/harness");
  } catch (err) {
    throw new Error(
      "Guest harness not built — run `pnpm --filter aai-guest build` " +
        "(or set GUEST_HARNESS_PATH to a built harness.mjs)",
      { cause: err },
    );
  }
}
