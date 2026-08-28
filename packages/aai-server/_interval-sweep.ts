// Copyright 2026 the AAI authors. MIT license.
/**
 * A background pass on a fixed interval that never overlaps itself and never
 * holds the process up.
 *
 * Two sweeps in this package had written this by hand — `workflow-wake.ts` and
 * `orphan-previews.ts` — and the two copies were IDENTICAL down to their
 * comments ("Serialized rather than overlapped…", "The sweep must never be the
 * reason the process stays up"). That is the concentration AGENTS.md calls a
 * missing seam: one narrowing every call site goes through, rather than the same
 * twelve lines maintained in parallel.
 *
 * ## The overrun policy is DROP, and it is a choice
 *
 * Three policies are available when a pass is still running as its next tick
 * fires, and they are not interchangeable:
 *
 * - **drop the tick** — what its callers want, and what this implements. A pass
 *   re-reads its whole candidate set from the database, so a tick skipped while
 *   the previous pass is still going loses nothing: the next one sees everything
 *   the skipped one would have.
 * - **coalesce into one trailing run** — `createCoalescingRunner`
 *   (`@alexkroman1/aai/host-internal`), which is in this tree and is the WRONG
 *   primitive here. It exists for work triggered by an EVENT, where "a run was
 *   already in flight" does not vouch for the change that arrived mid-run. A
 *   tick is not an event: nothing is waiting on this pass, so a trailing run
 *   started the instant an overrunning pass settles is just the queueing below
 *   with one slot.
 * - **queue** — nobody wants this. A pass holds a reserved admin connection for
 *   its duration, so backing them up against each other is how one slow pass
 *   becomes a connection pile-up.
 *
 * ## `unref`, always
 *
 * A sweep must never be the reason a process stays alive: the guest's idle
 * controller and the replica's drain decide that, and a ref'd interval would
 * outvote both. This is also the property most third-party schedulers do not
 * have — holding the loop open is generally their job — and it is a large part
 * of why this is twelve lines here rather than a dependency.
 *
 * ## What it deliberately does NOT do
 *
 * **Leader election.** A caller that needs one takes `pg_try_advisory_xact_lock`
 * INSIDE its pass, on a reserved connection, because a try-lock needs connection
 * affinity and the lock has to be held across the pass's own reads. That is a
 * property of the pass, not of the schedule, and a scheduler that tried to own it
 * would need a database handle it has no other use for. The one caller left needs
 * none — `workflow-queue-sweep.ts` argues why its claim IS the coordination — so
 * this is a statement about where the concern belongs, not about what is in use.
 *
 * **A pass on `start()`.** A caller accepts one interval of latency at boot; an
 * immediate pass would fire on every replica the moment a deploy rolls, which is
 * the one moment they are all contending for whatever they contend for.
 */

/**
 * A started sweep's handle: the interval, and the stop that owns it.
 *
 * @internal
 */
export type IntervalSweep = {
  /**
   * Begin ticking every `intervalMs`; the returned function stops it.
   *
   * Idempotent, and `intervalMs <= 0` starts nothing — the documented kill
   * switch both callers expose through an env-overridable constant. Either way
   * the return is a live stop, so a caller never has to branch on whether it
   * got one.
   */
  start(intervalMs: number): () => void;
};

/**
 * Run `pass` every `intervalMs`, skipping any tick that fires while the previous
 * pass is still running.
 *
 * `pass` is expected not to reject — both callers log and swallow inside their
 * own pass, because a sweep that dies on one bad tick stops being a sweep — but
 * a rejection here is contained rather than trusted: it releases the in-flight
 * flag and is otherwise dropped, so a throwing pass cannot wedge the interval
 * into never running again. Wedging is the failure mode that matters, since the
 * whole point of these sweeps is that nothing else is watching.
 *
 * @internal
 */
export function createIntervalSweep(pass: () => Promise<unknown>): IntervalSweep {
  let timer: NodeJS.Timeout | undefined;
  // OUTSIDE `start`, which is the one behaviour change from the two copies this
  // replaces. They declared it inside, so `start()` → `stop()` → `start()` built
  // a fresh flag while the first pass could still be in flight — letting two
  // passes overlap, which is the single thing the flag exists to prevent. Latent
  // rather than live (a composition calls `start` once), and gone by
  // construction here rather than by call-site discipline.
  let running = false;

  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  return {
    start(intervalMs: number): () => void {
      if (timer || intervalMs <= 0) return stop;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        void Promise.resolve()
          .then(pass)
          .catch(() => undefined)
          .finally(() => {
            running = false;
          });
      }, intervalMs);
      timer.unref?.();
      return stop;
    },
  };
}
