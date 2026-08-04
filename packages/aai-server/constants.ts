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
 * How long a sandbox superseded by a deploy/secret/storage mutation keeps
 * serving the sessions it already had, before its remaining calls are cut.
 *
 * A mutation does not end the conversations in flight on the old sandbox, so
 * terminating it on the spot cuts every one of them mid-word.
 * Retirement detaches the sandbox from its slot
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
 * How long a BROKER call waits for a booting sandbox before answering 503.
 *
 * Deliberately far below the boot budget itself (`AGENT_HEALTH_TIMEOUT_MS`,
 * 120s in warm-harness.ts). Those are two different questions that shared
 * one number: how long a guest may take to come up, and how long a CLIENT
 * should be left holding a request while it does. An agent whose top-level
 * code blocks never becomes ready, so every broker call hung for two full
 * minutes before returning the 503 — permanently, and for every caller.
 *
 * Timing out here does NOT cancel the boot: the sandbox is already attached
 * to its slot and reports `alive()` while pending, so it keeps booting and
 * the next call attaches to the SAME readiness promise rather than spawning
 * a second sandbox. The cost of tripping this on a healthy-but-slow boot is
 * therefore one client reconnect, not a failure — `session-core.ts`
 * re-brokers per attempt and only an ANSWERED lookup latches anything.
 *
 * Override with `BROKER_READY_TIMEOUT_MS`; 0 disables the cap and restores
 * waiting for the full boot budget.
 */
export const BROKER_READY_TIMEOUT_MS = envMs(process.env.BROKER_READY_TIMEOUT_MS, 20_000);

/**
 * After sandbox teardown, how long to wait for the HTTP server's remaining
 * connections to close before exiting anyway. By the time this timer arms,
 * guests are already retired, and a straggling connection is not a failed
 * shutdown — so the fallback exits 0.
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
