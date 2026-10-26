// Copyright 2026 the AAI authors. MIT license.
/**
 * The run's `StartOptions.key`, journaled as ONE step entry so a body reads
 * it back as `ctx.key` on every walk.
 *
 * The key index (`workflow/keys.ts`) maps `(workflow, key)` to run ids and
 * answers nothing in the other direction, and the run record has no column for
 * it in any of the three backends — the platform's table is one no tenant may
 * migrate. The journal's STEP table is in every backend already and is read
 * whole at the top of every walk, so the key rides there: `start` appends it
 * before the first dispatch, under a key in the `!` space no author's
 * `ctx.step` can mint (`workflow/replay/waits.ts` states the grammar), and the
 * walk's opening read carries it for free.
 *
 * Read with a `reach`, exactly as a determinism read is: the entry is in the
 * divergence watch's unread set, and an unrecorded reach gets the next real
 * step refused on a healthy run. A run with NO entry — started with no key, or
 * before this existed — simply reads `undefined`, and reaches nothing.
 *
 * @internal
 */

import type { StepEntry } from "../journal/types.ts";
import type { DivergenceWatch } from "./divergence.ts";

/** The journal key the run's correlation key is stored under. */
export const RUN_KEY_STEP = "key!";

/** The entry `start` appends for `key`. No attempt was charged — `attempts: 0`, as a determinism read records. */
export function runKeyEntry(key: string, now: number = Date.now()): StepEntry {
  return {
    key: RUN_KEY_STEP,
    name: "key",
    status: "ok",
    output: key,
    attempts: 0,
    startedAt: now,
    finishedAt: now,
  };
}

/**
 * The run's key out of the walk's opening snapshot, reached, or `undefined`.
 *
 * @internal
 */
export function readRunKey(
  settled: ReadonlyMap<string, StepEntry>,
  divergence: DivergenceWatch,
): string | undefined {
  const entry = settled.get(RUN_KEY_STEP);
  if (entry === undefined) return undefined;
  divergence.reach(RUN_KEY_STEP, "key", entry);
  return typeof entry.output === "string" ? entry.output : undefined;
}
