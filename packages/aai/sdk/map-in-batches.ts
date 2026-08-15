// Copyright 2026 the AAI authors. MIT license.
/**
 * Bounded fan-out inside a durable workflow body — the one concurrency shape
 * that survives replay.
 *
 * A workflow body that fans out over a list wants two things at once: a bound,
 * because the far side of a step is usually a rate limit, and a call order that
 * is a pure function of the list, because the Workflow Development Kit
 * correlates a journal entry to a step call **by the order the call was
 * issued in** and nothing else. Those two pull against each other, and the
 * obvious way to satisfy the first breaks the second.
 *
 * ## Why a worker pool is not available here, at any size
 *
 * The WDK transform rewrites a `"use step"` function into a dispatcher that
 * stamps each invocation with `step_${ulid()}` from a monotonic factory seeded
 * off the run's `startedAt`. So the Nth step call ISSUED in a run gets the Nth
 * id, on the first execution and on every replay, and the step's name is only
 * cross-checked against that id — a mismatch is `ReplayDivergenceError`, not a
 * silent re-run.
 *
 * A work-stealing pool issues its next call only when a previous one SETTLES,
 * so its issue order tracks completion order, which is a property of how long
 * each call happened to take. A replay takes different times, therefore issues
 * in a different order, therefore hands the Nth id to a different call. Nothing
 * rescues it, because the DevKit exposes no caller-supplied step key — that is
 * the one piece of this repo's predecessor engine (`ctx.step("segment-3", …)`)
 * that did not survive the port.
 *
 * Sequential batches of `Promise.all` are the remaining option: every call in a
 * batch is issued synchronously in array order, and the batches run in index
 * order, so the issue order is decided entirely by `items`. The cost is the tail
 * of each batch — a batch is only as fast as its slowest member — and it is the
 * price of being replayable.
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
 * A rejection propagates and abandons the remaining batches, which is what a
 * workflow body wants: the finished siblings are already journaled, so a resume
 * replays them for free and re-issues only what is missing. Catching per item to
 * salvage a partial result is a decision only the caller can make — do it inside
 * `run`.
 *
 * @param items - What to map. An empty list runs nothing and resolves `[]`.
 * @param size - Most calls in flight at once. Rounded down, and floored at 1.
 *   A size of zero would otherwise never advance the cursor — a hang, not an
 *   error, and a hang inside a workflow body is a run that never completes. A
 *   non-finite size is worse and needs the same floor for a different reason:
 *   `from += NaN` makes the loop condition false on its first pass, so it
 *   silently maps NOTHING and resolves `[]`, which reads as an empty input.
 * @param run - Called once per item, with the item and its index in `items`.
 *   Inside a workflow body this is where a `"use step"` call goes.
 *
 * @example
 * ```ts no-check
 * // In a "use workflow" body: one step per segment, four at a time.
 * const cleaned = await mapInBatches(segments, 4, (text) => postProcess(text));
 * ```
 *
 * @public
 */
export async function mapInBatches<T, R>(
  items: readonly T[],
  size: number,
  run: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> {
  const width = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : 1;
  const results: R[] = [];
  for (let from = 0; from < items.length; from += width) {
    // `slice` + `Promise.all`, never a shared cursor over the whole list: the
    // map's callbacks are invoked synchronously, in array order, before any of
    // them settles. That is the property replay depends on.
    const batch = await Promise.all(
      items.slice(from, from + width).map((item, at) => run(item, from + at)),
    );
    // Appended one at a time, NOT `push(...batch)`: `size` is the caller's and
    // is uncapped, and a spread passes the whole batch through the argument
    // list — so a wide enough batch is `RangeError: Maximum call stack size
    // exceeded` from a line that reads as concatenation. The engine's argument
    // limit is around 64k and a fan-out over a large upload can reach it.
    for (const result of batch) results.push(result);
  }
  return results;
}
