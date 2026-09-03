// Copyright 2026 the AAI authors. MIT license.
/**
 * Graceful retirement of a superseded guest sandbox — FIRE-AND-FORGET.
 *
 * A deploy replaces the code a slug runs, but it says nothing about the
 * conversations already in flight on the old sandbox. Retirement splits the
 * two things "terminate" would conflate:
 *
 * 1. **Stop new traffic — synchronously.** The caller (`retireSlot`)
 *    detaches the sandbox from its slot before calling this; the broker is
 *    the only routing point, so no new client can reach it.
 * 2. **Let the old sessions finish — in the GUEST.** One
 *    `POST /manage/drain` carrying the drain budget: the guest refuses new
 *    direct-dial sessions from that moment, exits the instant its last
 *    session ends, and exits at the deadline regardless (a retired sandbox
 *    is a billed guest running superseded code — one long call must not pin
 *    it indefinitely). The host keeps NO drain state and runs no poll loop;
 *    Modal's sandbox `timeoutMs` is the backstop behind everything.
 *
 * An unreachable guest (drain rejects) is terminated on the spot — nothing
 * to drain.
 *
 * Retirement is for sandboxes that are *superseded*, not ones that are gone.
 * A failed VM, an exited guest, or a deleted agent stays on `terminateSlot`.
 */

import { errorMessage } from "@alexkroman1/aai";
import { SANDBOX_RETIRE_DRAIN_MS } from "./constants.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("sandbox.retire");

/** The slice of a sandbox retirement needs. */
export type RetirableSandbox = {
  shutdown(): Promise<void>;
  /** Deadline-carrying guest drain; stand-ins without one are terminated. */
  drain?: (deadlineMs?: number) => Promise<void>;
};

/**
 * Hand `sandbox` its drain budget. Never rejects. Resolves once the drain
 * request was DELIVERED (or the fallback terminate finished) — not when the
 * guest finishes draining; the guest owns that, so there is nothing further
 * to wait for.
 *
 * Callers on a request path (deploy handover) fire-and-forget the returned
 * promise — a deploy must not block for the length of someone else's call.
 * Process shutdown AWAITS it (teardown-sandboxes.ts): the process is about
 * to exit, and an undelivered drain request is a guest that never learns it
 * was retired.
 */
export async function retireSandbox(
  sandbox: RetirableSandbox,
  opts: { slug: string; reason: string; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? SANDBOX_RETIRE_DRAIN_MS;
  // No window, or no drain surface: this is just a terminate.
  if (timeoutMs <= 0 || !sandbox.drain) {
    await sandbox.shutdown().catch(() => undefined);
    return;
  }
  try {
    await sandbox.drain(timeoutMs);
    log.info("retired sandbox draining in-guest", {
      slug: opts.slug,
      reason: opts.reason,
      timeoutMs,
    });
  } catch (err: unknown) {
    // Unreachable guest — drained by definition; reclaim it now.
    log.warn("retired sandbox unreachable for drain; terminating", {
      slug: opts.slug,
      error: errorMessage(err),
    });
    await sandbox.shutdown().catch(() => undefined);
  }
}
