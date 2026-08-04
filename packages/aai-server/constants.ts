// Copyright 2025 the AAI authors. MIT license.
// Server-specific constants. SDK-level constants live in aai.

import { createRequire } from "node:module";

/** 64 KB. */
export const MAX_ENV_SIZE = 65_536;

/**
 * Parse a millisecond env override where `0` is meaningful (so `|| default`
 * would swallow it): unset/empty or unparseable falls back to `fallback`,
 * an explicit non-negative number — including 0 — is honored. Without the
 * finite check, `SANDBOX_RETIRE_DRAIN_MS="10m"` becomes NaN, every
 * comparison against the deadline is false, and the drain window silently
 * collapses to zero — cutting live calls on every redeploy, which is the
 * exact failure the window exists to prevent.
 */
function envMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : fallback;
}

export const DEFAULT_PORT = 8080;

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
export const SANDBOX_RETIRE_DRAIN_MS = envMs(process.env.SANDBOX_RETIRE_DRAIN_MS, 600_000);

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
