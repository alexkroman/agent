// Copyright 2026 the AAI authors. MIT license.
/**
 * Draining this guest before its host terminates it: the `studio/drain`
 * request (harness.ts) resolves once no turn is running here and none can
 * start.
 *
 * The host cannot answer that itself. Chat turns stream browser→guest
 * directly, so the host sees a turn only at its END (the guest's
 * `studio/sync-workspace` and `studio/persist-chat`) — and those two RPCs are
 * exactly what a host that exits early loses, because they ride its control
 * channel. A replica going down in a rolling deploy used to terminate its studio
 * guests mid-turn: the LLM loop and its tools (`test_agent` included) killed,
 * the partial reply never persisted. So the signal comes from here, where the
 * turn is.
 *
 * "Quiet" is two things, and the turn claim alone is only the first:
 *
 * 1. **The workspace claim** (`enterTurnWhenFree`, turn-stream.ts). Taken and
 *    HELD: it is handed over at the running turn's release, so a follow-up the
 *    tab queued cannot start a turn on a guest that is about to go away. It is
 *    never given back — a drained guest serves no more turns.
 * 2. **The turn's tail.** The claim is released when the RESPONSE closes
 *    (see `handleStudioRequest` in chat.ts) — on a client abort, before the
 *    turn has even reached `onFinish` — and the end-of-turn sync + persist run
 *    after that, fire-and-forget. chat.ts hands both the turn and its settle
 *    to {@link trackTurnWork}; terminating inside them would lose the turn's
 *    final workspace and the reply the user just watched stream.
 *
 * Draining is process state, like the gate, because the sandbox is one
 * project's for its whole life and every session-init re-installs into it.
 */

import { enterTurnWhenFree, resetTurnGate } from "./turn-stream.ts";

/**
 * Machine-readable marker on the 409 a draining guest answers a new turn or a
 * re-install with. The status is what the callers act on — the browser
 * re-brokers on a 409 (`resilient-fetch.ts`), a peer's adopt drops the
 * registry row (`studio-session-adopt.ts`) — and the code says why.
 */
export const DRAINING_CODE = "sandbox_draining";

/** Turn work not yet over (see {@link trackTurnWork}). */
const pending = new Set<Promise<unknown>>();

/** The one drain, once begun — repeated requests join it. */
let drained: Promise<void> | null = null;

/**
 * Count `work` as turn work until it settles, and hand it back. The caller
 * keeps its own rejection handling; this records only that the work exists.
 */
export function trackTurnWork<T>(work: Promise<T>): Promise<T> {
  pending.add(work);
  const done = (): void => {
    pending.delete(work);
  };
  void work.then(done, done);
  return work;
}

/** Has a drain begun? Then this guest takes no new turn and no re-install. */
export function isDraining(): boolean {
  return drained !== null;
}

/**
 * Begin draining (idempotent) and resolve once the guest is quiet: the
 * running turn — if any — has ended and its settle has written back. Never
 * rejects, and never times out: the HOST bounds the wait, because only the
 * host knows how much of its shutdown budget is left.
 */
export function drainTurns(): Promise<void> {
  drained ??= (async () => {
    // Held for the rest of this process — see the module doc.
    await enterTurnWhenFree();
    // A loop, not one wait: a turn tracked here starts its settle as it ends,
    // so the settle joins the set while the first batch is being awaited.
    while (pending.size > 0) await Promise.allSettled([...pending]);
  })();
  return drained;
}

/** Test-only: forget a drain — and the claim it holds, so the gate is reset too. */
export function resetTurnDrain(): void {
  drained = null;
  pending.clear();
  resetTurnGate();
}
