// Copyright 2026 the AAI authors. MIT license.
/**
 * Connection draining for graceful shutdown.
 *
 * A voice session is a long-lived WebSocket, so the difference between closing
 * sockets on SIGTERM and waiting for them shows up directly as dropped calls:
 * rolling and bluegreen deploys both replace every machine, so without a drain
 * every conversation in flight is cut mid-sentence and the client reconnects
 * into a fresh session with no history.
 *
 * The wait is bounded because the platform force-kills the process a grace
 * period after the stop signal — a drain longer than that window is not a
 * drain, it is a SIGKILL with extra steps. Keep `SHUTDOWN_DRAIN_MS` below
 * the container stop grace period, with slack for sandbox teardown after it.
 */

import { performance } from "node:perf_hooks";
import { sleep as defaultSleep } from "./_sleep.ts";
import { DRAIN_POLL_MS } from "./constants.ts";

export type DrainResult = {
  /** True when every session ended on its own before the deadline. */
  drained: boolean;
  /** Sessions still connected — non-zero only when the deadline was hit. */
  remaining: number;
};

/**
 * Poll `activeCount` until it reaches zero or `timeoutMs` elapses.
 *
 * `sleep` and `now` are injectable so the shutdown path is testable without
 * real timers. Polling rather than event-driven counting keeps this decoupled
 * from how sessions are tracked: the caller passes any counter, and there is no
 * subscription to leak if shutdown races a closing socket.
 *
 * The counter may be async, because the other drain in this server cannot be
 * synchronous: sessions on a retired guest sandbox live in the guest, so its
 * count is an RPC round trip (see sandbox-retire.ts), not a local number.
 */
export async function waitForIdle(opts: {
  activeCount: () => number | Promise<number>;
  timeoutMs: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<DrainResult> {
  const pollMs = opts.pollMs ?? DRAIN_POLL_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => performance.now());

  const startedAt = now();
  let remaining = await opts.activeCount();
  while (remaining > 0 && now() - startedAt < opts.timeoutMs) {
    await sleep(pollMs);
    remaining = await opts.activeCount();
  }
  return { drained: remaining === 0, remaining };
}
