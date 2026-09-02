// Copyright 2026 the AAI authors. MIT license.
/**
 * Two `start` calls racing for one minted run id.
 *
 * @module
 */

import type { Interleaving } from "./interleaving.ts";

/**
 * The only defect in this directory that SHIPPED, frozen.
 *
 * A run id is minted by the caller, so `JournalStore.createRun` promises that
 * "a collision means two starts raced and exactly one may win". The platform
 * store's `createRun` was `on conflict (slug, run_id) do nothing` with no
 * `returning`, which makes zero rows and one row the same answer:
 *
 * > Two racing starts on one id therefore both believed they had won and the
 * > loser's `input` was discarded, on the platform arm only, i.e. **for every
 * > deployed agent**.
 * > — `aai-server/platform-workflow-journal.ts`
 *
 * And nothing at this tier could see it: the conformance suite's platform arm is
 * a fake transport over the memory reference, which refuses a duplicate, so only
 * a Postgres scenario run could tell the two apart. `silentDuplicateCreate` puts
 * the shipped behaviour in front of the memory store instead, which is what
 * makes the claim checkable wherever the checker runs.
 *
 * Under this ordering the failure reads as the three sentences the bug actually
 * was — a start that won nothing, a caller holding an id, and the run carrying
 * the wrong input:
 *
 * ```text
 * 2 of 2 colliding starts won the id
 * the run carries input {"n":0}, not the winning start's {"n":1}
 * run wrun_concurrent was created twice
 * ```
 *
 * The ordering is the same one `double-terminal-move.ts` carries, and that is
 * not a copy: both shrink to the same minimal program — one ordinary step under
 * two deliveries — so the same schedule reaches both moments. They are kept
 * apart because a reader looking for the START race should not have to find it
 * inside a file named for the terminal one.
 */
export const collidingStart: Interleaving = {
  name: "colliding-start",
  description: "two starts race for one minted id, and the run carries the WINNER's input",
  program: [{ t: "step", name: "", value: 0 }],
  deliveries: 2,
  stepConcurrency: 1,
  arm: "direct",
  ordering: [2, 1, 4, 3, 5, 6, 8, 7, 9, 10, 12, 11, 13, 14, 15],
  catches: { defect: "silentDuplicateCreate", law: "colliding starts won the id" },
};
