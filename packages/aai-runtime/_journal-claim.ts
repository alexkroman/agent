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
 * **`do nothing` really is free on that path, and it is MEASURED now, because
 * the paragraph above was challenged.** The objection: `insert … on conflict do
 * nothing` performs SPECULATIVE INSERTION — Postgres writes the heap tuple and
 * its index entries, then super-deletes them on detecting the conflict — so this
 * shape would leave the same dead tuple per walk per wait that it claims to
 * avoid, and the argument would be self-defeating. It is not. Postgres
 * PRE-CHECKS the arbiter index BEFORE writing anything
 * (`ExecCheckIndexConstraints`, ahead of the heap insert in `ExecInsert`), and a
 * `do nothing` whose pre-check finds a COMMITTED conflicting row returns having
 * written no tuple at all. Speculative insertion, and the super-deletion that
 * does leave a dead tuple, happen only where the pre-check passes and the index
 * insert then races an inserter it could not see — the rare race the retry above
 * exists for, and never the walk.
 *
 * PostgreSQL 16.13, 1000 conflicting claims of one already-claimed row, on a
 * table with `autovacuum_enabled = false` so nothing reclaims behind the count:
 *
 * | shape | `n_tup_ins` | `n_tup_upd` | dead tuples |
 * | --- | --- | --- | --- |
 * | this one — `on conflict do nothing` | 1 | 0 | **0** |
 * | a leading `existing` CTE guarding the insert | 1 | 0 | **0** |
 * | the rejected `on conflict … do update` | 1 | 1000 | **24** |
 *
 * The `1` is the row the measurement seeded; the third line is the positive
 * control, and is what proves the harness can see a dead tuple at all.
 * `explain analyze` states it without arithmetic — `Tuples Inserted: 0`,
 * `Conflicting Tuples: 1`. `claimHook`'s BARE `on conflict do nothing` was
 * measured the same way and behaves identically on both of its unique indexes:
 * with no arbiter named the pre-check covers every unique index on the table.
 *
 * So the middle line is the one to read before "optimising" this. Guarding the
 * insert with a leading read of the row saves NOTHING — there was no write to
 * remove — and costs an extra index probe on every claim.
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
