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
export function envMs(raw: string | undefined, fallback: number): number {
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
 * How many deploy bodies may be buffered and parsed AT ONCE.
 *
 * `MAX_INFLATED_BODY_BYTES` bounds one request; nothing bounded how many
 * arrive together, so peak memory was a function of arrival rate — a number
 * the caller picks, not the server. Measured against the real orchestrator, a
 * single max-size deploy costs ~164 MB of RSS (the compressed buffer, the
 * inflated buffer, the re-wrapped body, then `JSON.parse`'s UTF-16 string and
 * object), from **28 KB on the wire** because the worker gzips ~1000:1 when
 * it is compressible. Six concurrent cost ~388 MB against a container
 * provisioned at 2048 MiB.
 *
 * 2 keeps the worst case near ~330 MB while leaving deploys able to overlap.
 * It is low because it can afford to be: a deploy is a rare, human-initiated
 * operation, not a request-path one, and the queue below absorbs bursts. Note
 * the cap is what makes the SIZE limit survivable, so the two move together
 * — raising `MAX_WORKER_SIZE` (bundles do grow) means re-checking this.
 * Override with `DEPLOY_BODY_CONCURRENCY`.
 */
export const DEPLOY_BODY_CONCURRENCY = (() => {
  const raw = Number(process.env.DEPLOY_BODY_CONCURRENCY);
  return Number.isInteger(raw) && raw >= 1 ? raw : 2;
})();

/**
 * How long a deploy waits for one of those slots before answering 503.
 *
 * A waiter holds only its unread request stream — none of the buffers above —
 * so queueing is cheap and this can be generous relative to the ~1s a deploy
 * body takes to inflate and parse. Bounded anyway: an unbounded queue trades
 * the memory problem for a latency problem and keeps every socket open while
 * it does. `Retry-After` rides the 503, and the CLI already retries them.
 * Override with `DEPLOY_BODY_WAIT_MS`.
 */
export const DEPLOY_BODY_WAIT_MS = envMs(process.env.DEPLOY_BODY_WAIT_MS, 15_000);

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
 * How long a TEARDOWN path — `Sandbox.drain`, `Sandbox.shutdown` — waits on a
 * sandbox that has not finished booting.
 *
 * Both go through the spawn's readiness promise, because reaching a guest
 * needs a handle. That promise is bounded by the BOOT budget
 * (`GUEST_READY_TIMEOUT_MS`, 120s), which is the right answer for a broker
 * waiting on a sandbox it is about to serve and the wrong one for a process
 * that is exiting: retirement then blocks for two minutes on a guest that has
 * no sessions to drain, because it has never served one.
 *
 * Bounding it cannot orphan the guest, which is the only reason waiting was
 * ever justified. An agent-mode guest owns its own idleness and self-exits
 * after `AGENT_IDLE_EXIT_MS` with zero sessions (see
 * `packages/aai-guest/CLAUDE.md`), and Modal's `idleTimeoutMs`/`timeoutMs` sit
 * behind that — so a boot we walk away from is reclaimed on the guest's clock.
 * Waiting out the full budget does not reclaim it any better; it just spends
 * the container's stop grace, and a SIGKILL orphans the guest anyway while
 * cutting every teardown that would otherwise have finished.
 *
 * Five seconds, so a boot that is nearly done is still drained.
 * Override with `SANDBOX_TEARDOWN_READY_MS`. Unlike the two constants above,
 * 0 is NOT a distinct behaviour here — it is clamped to 1ms at the call site,
 * since giving up on a pending boot is what any small value already does.
 */
export const SANDBOX_TEARDOWN_READY_MS = envMs(process.env.SANDBOX_TEARDOWN_READY_MS, 5000);

/**
 * The whole service teardown's deadline — the general net under
 * {@link SANDBOX_TEARDOWN_READY_MS}'s specific one.
 *
 * `createShutdownHandler` awaits `onShutdown()` before arming any timer, so
 * for a long time the one bound on shutdown protected the fast half (waiting
 * for connections to close) and not the slow half (retiring every resident
 * guest). The bounded work in there now adds up to
 * `SHUTDOWN_GRACE_MS` (3s) + {@link SANDBOX_TEARDOWN_READY_MS} (5s) +
 * `MANAGE_REQUEST_TIMEOUT_MS` (5s) = 13s, run in PARALLEL across guests — but
 * the Modal control-plane calls underneath (`sandbox.terminate()`) carry no
 * timeout of their own, so the sum is a floor rather than a bound. This is
 * what makes it one.
 *
 * 20s leaves margin over that 13s; with {@link SHUTDOWN_CLOSE_FALLBACK_MS}
 * after it the process exits within ~23s of the signal, which must stay inside
 * the platform's container stop grace — Modal SIGKILLs at the end of it, and a
 * SIGKILL is the failure this whole ordering exists to avoid (see
 * live-streams.ts). Raising `SHUTDOWN_GRACE_MS` means raising this too.
 * Override with `SHUTDOWN_TEARDOWN_TIMEOUT_MS`; 0 disables the net.
 */
export const SHUTDOWN_TEARDOWN_TIMEOUT_MS = envMs(process.env.SHUTDOWN_TEARDOWN_TIMEOUT_MS, 20_000);

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
