// Copyright 2026 the AAI authors. MIT license.
/**
 * Graceful retirement of a superseded guest sandbox.
 *
 * A deploy (or secret/storage mutation) replaces the code a slug runs, but it
 * says nothing about the conversations already in flight on the old sandbox.
 * Terminating it inline — which is what every mutation path used to do —
 * closes those WebSockets mid-word, so shipping a fix during business hours
 * dropped every call on that agent. That is the same failure `_drain.ts`
 * exists to prevent on scale-in, arriving instead on every redeploy.
 *
 * Retirement splits the two things "terminate" was conflating:
 *
 * 1. **Stop new traffic — synchronously, before any await.** The caller
 *    detaches the sandbox from its slot. The broker (`resolveSandbox`) is the
 *    only routing point, so a detached sandbox can never be handed to another
 *    client; the deploy is fully live for everyone arriving from here on.
 * 2. **Let the old sessions finish.** Sessions live in the guest and connect
 *    to its tunnel directly, so "are you empty yet" is a `status` RPC, polled
 *    until zero or the deadline.
 *
 * The deadline is what keeps this from being a leak: a retired sandbox is a
 * billed guest still running superseded code, so `SANDBOX_RETIRE_DRAIN_MS`
 * caps how long one long call may pin an old bundle. Past it the deploy wins.
 *
 * Retirement is for sandboxes that are *superseded*, not ones that are gone.
 * A failed VM, an exited guest, or a deleted agent has nothing to drain (and
 * in the delete case nothing worth keeping alive) — those stay on
 * `terminateSlot`.
 */

import { errorMessage } from "@alexkroman1/aai";
import { waitForIdle } from "./_drain.ts";
import { RETIRE_POLL_MS, SANDBOX_RETIRE_DRAIN_MS } from "./constants.ts";

/** The slice of a sandbox retirement needs: ask it, then close it. */
export type RetirableSandbox = {
  shutdown(): Promise<void>;
  /** Live guest sessions; absent stand-ins are treated as already empty. */
  activeSessions?: () => Promise<number>;
};

/**
 * Sandboxes detached from their slot but still serving the calls that were on
 * them. Nothing else can reach them — that is the point — so process teardown
 * consults this to avoid leaking a guest that was mid-drain at SIGTERM.
 */
const draining = new Set<RetirableSandbox>();

/** Sandboxes currently draining, for shutdown teardown. */
export function drainingSandboxes(): RetirableSandbox[] {
  return [...draining];
}

/**
 * Drain `sandbox`'s remaining sessions, then shut it down. Resolves when the
 * sandbox is down; callers on a request path should NOT await it (a deploy
 * must not block for the length of someone else's call).
 *
 * Never throws: retirement is best-effort cleanup, and the shutdown runs from
 * a `finally` so a probe that blows up still releases the guest.
 */
export async function retireSandbox(
  sandbox: RetirableSandbox,
  opts: {
    slug: string;
    reason: string;
    timeoutMs?: number;
    /**
     * Probe interval. A seam for tests, like `_drain.ts`'s `sleep`/`now`:
     * the deadline path is measured with `performance.now()` from
     * `node:perf_hooks`, which fake timers do not intercept, so exercising
     * it means real (tiny) durations rather than a faked clock.
     */
    pollMs?: number;
  },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? SANDBOX_RETIRE_DRAIN_MS;
  const probe = sandbox.activeSessions;
  // No window, or nothing to ask: this is just a terminate.
  if (timeoutMs <= 0 || !probe) {
    await shutdownQuietly(sandbox, opts.slug);
    return;
  }

  draining.add(sandbox);
  try {
    const { drained, remaining } = await waitForIdle({
      // A dead or unreachable guest answers 0 — same convention as idle
      // eviction — so the loop exits instead of polling a corpse to deadline.
      activeCount: () => probe.call(sandbox).catch(() => 0),
      timeoutMs,
      pollMs: opts.pollMs ?? RETIRE_POLL_MS,
    });
    if (drained) {
      console.info("Retired sandbox drained", { slug: opts.slug, reason: opts.reason });
    } else {
      console.warn("Retired sandbox still had sessions at the drain deadline; closing", {
        slug: opts.slug,
        reason: opts.reason,
        remaining,
      });
    }
  } catch (err: unknown) {
    console.warn("Retired sandbox drain failed; closing", {
      slug: opts.slug,
      error: errorMessage(err),
    });
  } finally {
    draining.delete(sandbox);
    await shutdownQuietly(sandbox, opts.slug);
  }
}

async function shutdownQuietly(sandbox: RetirableSandbox, slug: string): Promise<void> {
  try {
    await sandbox.shutdown();
  } catch (err: unknown) {
    console.warn("Failed to shut down retired sandbox", { slug, error: errorMessage(err) });
  }
}
