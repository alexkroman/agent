// Copyright 2025 the AAI authors. MIT license.
// Server-specific constants. SDK-level constants live in aai.

import { createRequire } from "node:module";

/** 64 KB. */
export const MAX_ENV_SIZE = 65_536;

export const DEFAULT_PORT = 8080;

/** Max concurrent WebSocket connections before the server rejects new upgrades. */
export const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 100;

/**
 * Idle time before a resident sandbox is evicted. Sessions connect to the
 * sandbox directly, so the sweep probes the guest's live session count
 * before killing (see sandbox-slots.ts).
 */
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

/**
 * Poll interval for the shutdown drain, whose count fans an RPC out to every
 * guest this replica owns (`liveGuestSessions`) rather than reading a local
 * socket set. Coarser than {@link DRAIN_POLL_MS} for that reason; a second of
 * extra shutdown latency against a 120s budget is not worth 4× the guest
 * chatter while a replica is going down.
 */
export const DRAIN_GUEST_POLL_MS = 1000;

/**
 * How long a sandbox superseded by a deploy/secret/storage mutation keeps
 * serving the sessions it already had, before its remaining calls are cut.
 *
 * A mutation does not end the conversations in flight on the old sandbox, so
 * terminating it on the spot cuts every one of them mid-word — the same
 * failure `DEFAULT_SHUTDOWN_DRAIN_MS` exists to avoid on scale-in, arriving
 * instead on every redeploy. Retirement detaches the sandbox from its slot
 * (the broker is the only routing point, so no NEW session can land on it)
 * and lets the old ones finish on the old code, which is what a client
 * already assumes for the duration of a call.
 *
 * Bounded, because a retired sandbox is a billed guest still running
 * superseded code: past the deadline the deploy wins and the stragglers are
 * closed. 10 minutes sits above a normal call and above session-core's own
 * 5-minute `idleTimeoutMs` (so an abandoned session self-reaps well inside
 * it) without letting one long call pin an old bundle indefinitely.
 * Override with `SANDBOX_RETIRE_DRAIN_MS`; 0 restores immediate termination.
 */
export const SANDBOX_RETIRE_DRAIN_MS = Number(process.env.SANDBOX_RETIRE_DRAIN_MS ?? 600_000);

/**
 * How often retirement re-probes a draining guest's session count.
 *
 * This is also the answer to "how long after the last call ends does the old
 * sandbox die": the drain loop only notices at a probe, so the lag is at most
 * one interval. Much coarser than {@link DRAIN_POLL_MS} because each probe is
 * a `status` RPC to the guest rather than a local counter read — but the
 * probe is cheap and the alternative is paying for an empty guest, so this
 * stays seconds, not the tens of seconds the minutes-long window would
 * otherwise invite. Note the FIRST probe happens before any sleep, so a
 * superseded sandbox with nobody on it is terminated immediately.
 */
export const RETIRE_POLL_MS = 5000;

/**
 * After the drain and sandbox teardown, how long to wait for the HTTP server's
 * remaining connections to close before exiting anyway.
 *
 * Distinct from {@link DEFAULT_SHUTDOWN_DRAIN_MS}, which bounds waiting for
 * live *sessions*: by the time this timer arms, sandboxes are already down and
 * a straggling connection is not a failed shutdown — so the fallback exits 0.
 */
export const SHUTDOWN_CLOSE_FALLBACK_MS = 3000;

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
