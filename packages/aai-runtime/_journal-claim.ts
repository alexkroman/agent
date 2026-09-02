// Copyright 2026 the AAI authors. MIT license.
/**
 * The one retry the Postgres journal's FIRST-WRITE-WINS claims need.
 *
 * Its own module for the reason the twin's is
 * (`aai-server/_journal-claim.ts`): `workflow-journal-postgres.ts` is at the
 * file-length cap, and the helper's argument is longer than the helper.
 *
 * @internal
 */

/**
 * How many times a FIRST-WRITE-WINS claim re-runs before it gives up.
 *
 * The round trip is the backoff: a rival holding the row uncommitted is a single
 * autocommit statement, so its window is shorter than one attempt's own latency
 * to the database and nothing here needs a timer — which is also what keeps this
 * off `guard-invariants` rule 19.
 */
const CLAIM_ATTEMPTS = 3;

/**
 * Run a first-write-wins claim, re-running it while the answer is INDETERMINATE.
 *
 * Three operations in that store have one shape: insert the row, and if somebody
 * already wrote it, adopt theirs. Each is ONE statement — `with mine as (insert …
 * on conflict do nothing returning …) select from mine union all select from
 * <table> where …` — which works because the outer select reads the statement's
 * snapshot, taken BEFORE the CTE's insert: exactly one arm can produce a row.
 *
 * **The retry is what the collapse does not buy on its own.** `on conflict do
 * nothing` does not WAIT for a concurrent inserter — Postgres declines and moves
 * on — and the union's second arm reads the very snapshot the insert conflicted
 * against, so a rival's UNCOMMITTED row leaves both arms empty. As two separate
 * statements that surfaced as `workflow step … vanished`; here it surfaces as
 * nothing at all, because by the next attempt the rival has committed (adopt its
 * row) or aborted (win the insert).
 *
 * **Not `on conflict … do update`**, which would block on the rival and need no
 * retry: an update writes a new row version even when it changes nothing, and
 * `claimSleep` is called on every walk of the body past a wait — so the common
 * path, a pure read, would leave a dead tuple behind each time.
 *
 * The twin on the platform's own database is `aai-server/_journal-claim.ts`,
 * which carries the same argument with the platform's latency numbers. The two
 * stores mirror each other's statements deliberately (see
 * `workflow-journal-postgres.ts`'s header), so this mirrors its retry too.
 *
 * @internal
 */
export async function firstWriteWins<T>(
  attempt: () => Promise<T | undefined>,
  vanished: () => string,
): Promise<T> {
  for (let left = CLAIM_ATTEMPTS; left > 0; left--) {
    const row = await attempt();
    if (row !== undefined) return row;
  }
  throw new Error(vanished());
}
