// Copyright 2026 the AAI authors. MIT license.
/**
 * A bounded read, re-armed from the SETTLED read — the loop both workflow
 * watchers are built out of.
 *
 * `pollUntilTerminal` (`use-workflow-run.ts`) and `readProgressUntilComplete`
 * (`use-workflow-progress.ts`) each open a request, decide from its answer
 * whether to come back, and stop when told to. What they had in common was not
 * the decision — one reads a snapshot, the other drains an SSE body — but the
 * scaffold around it, and that scaffold is where the two rules live:
 *
 * - **Re-armed from the settled read, never on an interval.** A slow response
 *   would otherwise stack overlapping requests on an agent that is already
 *   struggling, and on the platform every one of them BROKERS.
 * - **Cancellation is a signal, not a flag.** The teardown has to reach the
 *   in-flight request too — an abandoned progress read otherwise keeps pulling
 *   chunks out of a run for a page that has navigated away — so `step` is
 *   handed the signal rather than being trusted to check a boolean.
 */

/**
 * Call `step` until it reports it is finished, or until the returned stop
 * function is called.
 *
 * `step` resolves `true` when there is nothing left to come back for. It is
 * responsible for its own failures: a rejection would leave the loop stopped
 * with nobody told, so each caller decides whether its failure is terminal or
 * just another reason to try again.
 *
 * @internal
 */
export function repeatUntil(
  intervalMs: number,
  step: (signal: AbortSignal) => Promise<boolean>,
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    const finished = await step(controller.signal);
    if (finished || controller.signal.aborted) return;
    timer = setTimeout(() => void tick(), intervalMs);
  };
  void tick();

  return () => {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
  };
}
