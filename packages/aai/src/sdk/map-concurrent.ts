// Copyright 2026 the AAI authors. MIT license.
/**
 * Bounded fan-out inside a durable workflow body — the one concurrency shape
 * that survives replay.
 *
 * A workflow body that fans out over a list wants two things at once: a bound,
 * because the far side of a step is usually a rate limit, and a call order that
 * is a pure function of the list, because the engine correlates a journal entry
 * to a step call **by the order the call was issued in** and nothing else.
 *
 * ## What replay really requires
 *
 * A step is called through `ctx.step(name, fn)`, and its journal key is the name
 * plus the number of times THAT name has already been reached in this walk —
 * `segment#0`, `segment#1`, … (see `WorkflowContext` in `sdk/workflow-ctx.ts`). So
 * the Nth call issued under a given name reads the Nth entry under it, on the
 * first execution and on every replay.
 *
 * **Nothing cross-checks that the Nth call is the same WORK it was last time.**
 * A body whose call order changes between walks does not fail — it silently
 * reads another item's journaled result. That is what makes the rule below
 * load-bearing rather than advisory, and it is why this module exists instead of
 * a hand-rolled pool at each call site.
 *
 * **The engine DOES now refuse a walk that changes a step's NAME**
 * (`aai-runtime/workflow-replay-divergence.ts`, which is where the
 * `ReplayDivergenceError` this doc once promised finally lives). That is a
 * different fault from this one and it is worth being precise about which is
 * which, because the two look alike in prose: a changed name mints a journal
 * key nobody ever reached, and the engine can see that. A fan-out reordered
 * UNDER ONE NAME mints no new key at all — every call still reads
 * `segment#0..N`, in the same order, and the only thing that moved is which
 * ITEM call N was for. There is nothing for the journal to disagree with, so
 * the rule below remains the whole defence.
 *
 * The requirement that falls out of this is narrower than it looks: **the
 * SEQUENCE OF ITEMS whose calls are issued must be a pure function of the
 * list.** It is not "no call may be issued after another settles" — a body that
 * awaits one step and then issues the next does exactly that, and is the most
 * ordinary workflow there is.
 *
 * A window over a shared cursor satisfies it. The cursor only ever hands out the
 * next index, so the Nth call issued is item N-1 whatever order the calls settle
 * in; what completion order decides is which SLOT runs which item, and no
 * journal key depends on that. So there is no barrier here: a slot that finishes early takes
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
 * ## The WINDOW is not the concurrency — the ENGINE's step gate is
 *
 * `width` bounds how many step calls this body has in flight. How many of them
 * EXECUTE at once is decided one layer down, by `DEFAULT_STEP_CONCURRENCY` in
 * `@alexkroman1/aai-runtime` — **16**. So a window of 32 runs sixteen wide, and
 * past sixteen a wider window buys nothing while still costing a queued job per
 * item.
 *
 * That number used to be three, inherited from graphile-worker's default on the
 * `DATABASE_URL` path and never measured against the thing it bounds. It is
 * sixteen now because it was: in a real libkrun microVM at Modal's GUARANTEED
 * reservation (1 CPU / 1024 MB, `SANDBOX_MEMORY_MB` — the cap above it is
 * elastic and a default may not depend on it), a concurrent transcription
 * segment costs 26.1 MB at 48 kHz stereo, so sixteen sits at 576 MB of 982 MB
 * usable. The gate's own doc carries the table.
 *
 * Two things follow. **Size the window against the far side's latency, not
 * against the item count**: the engine spends ~38ms per step (measured, and
 * steady across three far-side latencies), so a window only pays where the far
 * side costs meaningfully more than that — which is why a real provider taking
 * seconds rewards 8 or 17 and a loopback stub does not. Against a FAST far side
 * a wide window is actively worse: 32 loopback steps took 903ms at window 2 and
 * 1587ms at window 16, a 76% penalty for asking for eight times the concurrency.
 * And **the ceiling is an operator's knob, not an author's** —
 * `AAI_WORKFLOW_STEP_CONCURRENCY`, read from the SERVER's process environment (a
 * project's `.env` is the agent env and does not reach it), so a deployment that
 * has sized its guest larger can raise it.
 *
 * ## It is not workflow-specific, and needs no workflow to run
 *
 * Nothing here imports the engine: this is a plain bounded map, so a tool body
 * can use it for a rate-limited API and a spec can call it directly. The rules
 * above are why it exists and why it is shaped the way it is.
 */

/**
 * Map `items` through `run`, at most `width` at a time, in a replay-safe order.
 *
 * Results come back in ITEM order however the individual calls settle, so it
 * substitutes directly for `Promise.all(items.map(run))` where a bound is
 * needed.
 *
 * A rejection stops the window taking new items and then propagates once the
 * calls already in flight have SETTLED — not the instant it happens. That order
 * is what a workflow body wants: every sibling that finished is journaled, so a
 * resume replays it for free and re-issues only what is missing, where throwing
 * immediately would discard siblings that were mid-call and have the resume pay
 * for them a second time. Catching per item to salvage a partial result is a
 * decision only the caller can make — do it inside `run`.
 *
 * @param items - What to map. An empty list runs nothing and resolves `[]`.
 * @param width - Most calls in flight at once. Rounded down, and floored at 1.
 *   A width of zero would otherwise start no slot at all — a hang, not an error,
 *   and a hang inside a workflow body is a run that never completes. A
 *   non-finite width is worse and needs the same floor for a different reason:
 *   `Math.min(NaN, n)` is `NaN`, so `Array.from({ length: NaN })` is empty and
 *   the map silently does NOTHING, which reads as an empty input.
 * @param run - Called once per item, with the item and its index in `items`.
 *   Inside a workflow body this is where a `ctx.step` call goes, and **it must
 *   be the only one, issued synchronously** — a callback that awaits before its
 *   step call, or issues two in a row, interleaves with its siblings by
 *   completion order and a resume hands the Nth journal entry to a different
 *   call. A body needing two steps per item runs them as two fan-outs. The
 *   module doc above carries why, and why the window itself needs no barrier.
 *
 * @example
 * ```ts no-check
 * // In a workflow body: one step per segment, four in flight.
 * const cleaned = await mapConcurrent(segments, 4, (text) => postProcess(text));
 * ```
 *
 * @public
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  width: number,
  run: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> {
  const slots = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  // Sized up front and filled BY INDEX, never appended: results are in item
  // order by construction rather than by sorting, and there is no `push(...)`
  // whose argument list a wide fan-out could overflow.
  const results = new Array<R>(items.length);
  // The one piece of shared state, and the whole replay argument rests on it
  // being monotonic: whichever slot reads it next takes the next index, so the
  // Nth call issued is item N-1 however the calls settle.
  let cursor = 0;
  let stopped = false;
  /**
   * The first failure IN TIME, which in a fan-out is the CAUSAL one.
   *
   * Every later rejection is downstream of this one — `stopped` turned it into a
   * no-op for the slots that had not started, and a caller that aborts its
   * siblings on failure (the parts uploader does exactly this) turns it into an
   * `aborted` for the ones that had. Reporting any of those would name the
   * symptom: "aborted" for a caller whose real problem is that a part was
   * refused.
   */
  let firstFailure: { reason: unknown } | undefined;

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
        firstFailure ??= { reason: err };
        throw err;
      }
    }
  };

  // Started synchronously, in order, so the first `slots` calls are issued as
  // items 0..slots-1 before any of them settles.
  //
  // DRAINED, then thrown. `Promise.all` rejects the moment one slot does, and
  // `stopped` only stops a slot taking a NEW item — so a slot already inside
  // `await run(...)` is abandoned mid-call, with its result discarded whether or
  // not the call went on to succeed. In a durable fan-out those are the calls
  // that have already been paid for: their journal entries never
  // land, so the resume re-issues and re-bills work that had SUCCEEDED. Draining
  // first costs the tail of whatever is in flight — bounded by those calls' own
  // deadlines, and they are running either way — and buys every one of their
  // results.
  //
  // Issue ORDER is untouched, which is what replay correlation rests on: the
  // cursor is still monotonic and still read synchronously, so the Nth call
  // issued is still item N-1.
  await Promise.allSettled(Array.from({ length: Math.min(slots, items.length) }, slot));
  // `firstFailure` rather than the settled results, because WHICH rejection is
  // raised matters as much as raising one — see its declaration. Boxed so a
  // rejection whose reason is itself `undefined` is still a failure.
  if (firstFailure !== undefined) throw firstFailure.reason;
  return results;
}
