// Copyright 2026 the AAI authors. MIT license.
/**
 * A bounded fan-out where a failed item is a VALUE rather than the end of the
 * run — `mapConcurrent` with the per-item `try`/`catch` written once.
 *
 * `mapConcurrent` propagates the first rejection, and that is right for a
 * workflow body, where a step that cannot be done means the run cannot. A
 * TOOL on a live call wants the other policy: a caller on the phone would
 * rather hear eleven scores and one apology than an error, and the one that
 * failed should be NAMED so the desk can offer to run it again. Three
 * templates wrote that policy by hand — a `try` inside the callback returning
 * `{ ok: true, value } | { ok: false, error }`, then a filter for the
 * failures, then the sentence for "every one of them failed" — and the four
 * copies of that sentence had already drifted on how they narrowed the first
 * failure.
 *
 * ## The shape: a flat list, and a partition over it
 *
 * `mapSettled` answers one {@link Settled} per item, IN ITEM ORDER, because two
 * of the three adopters key what they store by the item (`scores[candidate.id]
 * = verdict`) and need each success beside its input. `partitionSettled` is the
 * second function rather than a second field on the result, and it is the
 * smaller API for a reason that is not the export count: a result that carried
 * `{ settled, ok, failed }` would hand every caller three views of one list
 * whether it wanted them or not, and the ones that iterate `settled` once (all
 * three, for the store) would be paying for two filters they then re-derive
 * anyway. A caller that wants the split asks for it; the failure list it gets
 * back is typed, so `failed[0]?.error` needs no `.ok === false` narrowing —
 * which is the drift the four sentences had.
 *
 * ## Replay
 *
 * Nothing here changes the issue order: the callback wraps `run` and the window
 * is `mapConcurrent`'s, so the SEQUENCE of items whose calls are issued is
 * still a pure function of the list, and everything that module's doc says
 * about a step call inside `run` holds here. What is different is the second
 * half of its rule — `run` must issue one step, synchronously — which matters
 * as much for a settled map as a raced one. An unbounded fan-out
 * (`Promise.allSettled(items.map(run))`, `briefing-desk`'s shape) is
 * `width: Infinity`, spelled out below.
 */

import { mapConcurrent } from "./map-concurrent.ts";
import { errorMessage } from "./utils.ts";

/**
 * What one item of a {@link mapSettled} came back as: its value, or the reason
 * it failed, beside the item itself.
 *
 * `error` is a STRING (via `errorMessage`) rather than the thrown value, because
 * the reason exists to be spoken or stored — a `ToolFailure` sentence, a slot's
 * `unscored` list — and a template that wants the raw cause has `mapConcurrent`
 * and its own `catch`.
 *
 * @public
 */
export type Settled<T, R> =
  | { readonly item: T; readonly ok: true; readonly value: R }
  | { readonly item: T; readonly ok: false; readonly error: string };

/**
 * Map `items` through `run`, at most `width` at a time, settling each item
 * rather than racing to the first rejection.
 *
 * Results come back in ITEM order however the calls settle. A `run` that throws
 * (or rejects) for one item produces `{ ok: false, error }` for that item and
 * nothing else changes: the window keeps taking items, and every sibling's
 * result is kept.
 *
 * @param items - What to map. An empty list runs nothing and resolves `[]`.
 * @param width - Most calls in flight at once — `mapConcurrent`'s bound, with
 *   one addition: **`Infinity` means every item at once**, the shape
 *   `Promise.allSettled(items.map(run))` had. `mapConcurrent` alone floors a
 *   non-finite width to 1, which would turn an author's "all at once" into
 *   "one at a time" without a word; here the one non-finite value that has an
 *   obvious meaning gets it. Any other width is passed through unchanged, floors
 *   included.
 * @param run - Called once per item, with the item and its index. Inside a
 *   workflow body this is where the step call goes, and the rule
 *   `mapConcurrent`'s doc states — one step per item, issued synchronously —
 *   applies unchanged.
 *
 * @example
 * ```ts
 * import { mapSettled, partitionSettled } from "@alexkroman1/aai/step";
 *
 * async function score(name: string): Promise<number> {
 *   if (name === "") throw new Error("blank");
 *   return name.length;
 * }
 *
 * const settled = await mapSettled(["ann", "", "bo"], 2, score);
 * // [{ item: "ann", ok: true, value: 3 }, { item: "", ok: false, error: "blank" }, …]
 * const { ok, failed } = partitionSettled(settled);
 * if (ok.length === 0) throw new Error(`Every name failed: ${failed[0]?.error}`);
 * ```
 *
 * @public
 */
export function mapSettled<T, R>(
  items: readonly T[],
  width: number,
  run: (item: T, index: number) => Promise<R> | R,
): Promise<Settled<T, R>[]> {
  const bound = width === Number.POSITIVE_INFINITY ? items.length : width;
  return mapConcurrent(items, bound, async (item, index): Promise<Settled<T, R>> => {
    try {
      return { item, ok: true, value: await run(item, index) };
    } catch (err: unknown) {
      return { item, ok: false, error: errorMessage(err) };
    }
  });
}

/**
 * Split what {@link mapSettled} answered into the successes and the failures,
 * each still beside its item and each list typed as its own arm.
 *
 * The typing is the point: a `.filter((one) => !one.ok)` over the union keeps
 * the union, so reading `failed[0].error` afterwards needs a re-narrowing
 * (`failed[0]?.ok === false ? failed[0].error : …`) that three templates each
 * wrote slightly differently. Both lists keep ITEM order.
 *
 * @public
 */
export function partitionSettled<T, R>(
  settled: readonly Settled<T, R>[],
): {
  ok: Extract<Settled<T, R>, { ok: true }>[];
  failed: Extract<Settled<T, R>, { ok: false }>[];
} {
  const ok: Extract<Settled<T, R>, { ok: true }>[] = [];
  const failed: Extract<Settled<T, R>, { ok: false }>[] = [];
  for (const one of settled) {
    if (one.ok) ok.push(one);
    else failed.push(one);
  }
  return { ok, failed };
}
