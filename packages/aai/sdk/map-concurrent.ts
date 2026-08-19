// Copyright 2026 the AAI authors. MIT license.
/**
 * Bounded fan-out inside a durable workflow body — the one concurrency shape
 * that survives replay.
 *
 * A workflow body that fans out over a list wants two things at once: a bound,
 * because the far side of a step is usually a rate limit, and a call order that
 * is a pure function of the list, because the Workflow Development Kit
 * correlates a journal entry to a step call **by the order the call was issued
 * in** and nothing else.
 *
 * ## What replay really requires
 *
 * The WDK transform rewrites a `"use step"` function into a dispatcher that
 * stamps each invocation with `step_${ulid()}` from a monotonic factory seeded
 * off the run's `startedAt`. So the Nth step call ISSUED in a run gets the Nth
 * id, on the first execution and on every replay, and the step's name is only
 * cross-checked against that id — a mismatch is `ReplayDivergenceError`, not a
 * silent re-run.
 *
 * The requirement that falls out of this is narrower than it looks: **the
 * SEQUENCE OF ITEMS whose calls are issued must be a pure function of the
 * list.** It is not "no call may be issued after another settles" — a body that
 * awaits one step and then issues the next does exactly that, and is the most
 * ordinary workflow there is.
 *
 * A window over a shared cursor satisfies it. The cursor only ever hands out the
 * next index, so the Nth call issued is item N-1 whatever order the calls settle
 * in; what completion order decides is which SLOT runs which item, and no id
 * depends on that. So there is no barrier here: a slot that finishes early takes
 * the next item immediately instead of idling until its slowest sibling lands.
 *
 * **This was `mapInBatches`, and it ran sequential batches of `Promise.all` on
 * the belief that the above was unsafe.** It is not, and the batching cost was
 * real: a batch is only as fast as its slowest member and a run is the sum of
 * those, so a straggler — a `503` carrying `retry-after: 1` is the ordinary one
 * — was paid once per batch at p100. `transcription-workflow` measured the tail
 * it produced at 6.7x p50 on a wide fan-out.
 *
 * ## The rule that IS load-bearing, and applies to any shape
 *
 * **`run` must issue the same sequence of step calls for every item**, which in
 * practice means one, issued synchronously. A callback that awaits something
 * before its step call, or issues two steps in a row, interleaves with its
 * siblings by completion order — under a window and under batches alike, since
 * within one batch the second round of calls is issued as the first round
 * settles. Neither shape rescues it; a body that needs two steps per item runs
 * them as two fan-outs.
 *
 * ## It is not workflow-specific, and needs no workflow to run
 *
 * Nothing here imports the DevKit: this is a plain bounded map, so a tool body
 * can use it for a rate-limited API and a spec can call it directly. The rules
 * above are why it exists and why it is shaped the way it is.
 */

/**
 * Map `items` through `run`, at most `size` at a time, in a replay-safe order.
 *
 * Results come back in ITEM order however the individual calls settle, so it
 * substitutes directly for `Promise.all(items.map(run))` where a bound is
 * needed.
 *
 * A rejection propagates and stops the window taking new items, which is what a
 * workflow body wants: the finished siblings are already journaled, so a resume
 * replays them for free and re-issues only what is missing. Catching per item to
 * salvage a partial result is a decision only the caller can make — do it inside
 * `run`.
 *
 * @param items - What to map. An empty list runs nothing and resolves `[]`.
 * @param size - Most calls in flight at once. Rounded down, and floored at 1.
 *   A size of zero would otherwise start no slot at all — a hang, not an error,
 *   and a hang inside a workflow body is a run that never completes. A
 *   non-finite size is worse and needs the same floor for a different reason:
 *   `Math.min(NaN, n)` is `NaN`, so `Array.from({ length: NaN })` is empty and
 *   the map silently does NOTHING, which reads as an empty input.
 * @param run - Called once per item, with the item and its index in `items`.
 *   Inside a workflow body this is where a `"use step"` call goes, and it must
 *   be the only one — see the module doc.
 *
 * @example
 * ```ts no-check
 * // In a "use workflow" body: one step per segment, four in flight.
 * const cleaned = await mapConcurrent(segments, 4, (text) => postProcess(text));
 * ```
 *
 * @public
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  size: number,
  run: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> {
  const width = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : 1;
  // Sized up front and filled BY INDEX, never appended: results are in item
  // order by construction rather than by sorting, and there is no `push(...)`
  // whose argument list a wide fan-out could overflow.
  const results = new Array<R>(items.length);
  // The one piece of shared state, and the whole replay argument rests on it
  // being monotonic: whichever slot reads it next takes the next index, so the
  // Nth call issued is item N-1 however the calls settle.
  let cursor = 0;
  let stopped = false;

  const slot = async (): Promise<void> => {
    for (let at = cursor++; at < items.length && !stopped; at = cursor++) {
      try {
        // `as T` because `noUncheckedIndexedAccess` widens the read, and `at` is
        // bounded by the loop condition — a hole here is impossible for a real
        // array and would be the caller's sparse one.
        results[at] = await run(items[at] as T, at);
      } catch (err: unknown) {
        // Every other slot stops at its next check rather than working through
        // the rest of a list whose result is already lost. It cannot change the
        // issue ORDER — the cursor is still monotonic — only where it stops.
        stopped = true;
        throw err;
      }
    }
  };

  // Started synchronously, in order, so the first `width` calls are issued as
  // items 0..width-1 before any of them settles.
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, slot));
  return results;
}

/**
 * The former name of {@link mapConcurrent}.
 *
 * Kept because it is public API and named in every workflow template that has
 * shipped. It is the same function: the rename is what stopped the name
 * describing an implementation — sequential batches — that this no longer has
 * and never needed.
 *
 * @deprecated Use {@link mapConcurrent}.
 * @public
 */
export const mapInBatches = mapConcurrent;
