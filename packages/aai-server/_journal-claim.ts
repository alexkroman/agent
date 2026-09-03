// Copyright 2026 the AAI authors. MIT license.
/**
 * The one retry the platform journal's FIRST-WRITE-WINS claims need.
 *
 * Its own module because both halves of the journal use it and one imports the
 * other: `platform-workflow-journal.ts` takes `HOOKS` from
 * `platform-workflow-journal-hooks.ts`, so the helper cannot live in either
 * without a cycle.
 *
 * @internal
 */

/**
 * How many times a FIRST-WRITE-WINS claim re-runs before it gives up.
 *
 * Three, and the round trip is the backoff — see {@link firstWriteWins}. A rival
 * holding the row uncommitted is a single autocommit statement, so its window is
 * shorter than one attempt's own latency to the database; nothing here needs a
 * timer, which is also what keeps this off `guard-invariants` rule 19.
 */
const CLAIM_ATTEMPTS = 3;

/**
 * Run a first-write-wins claim, re-running it while the answer is INDETERMINATE.
 *
 * `claimSleep`, `appendStep` and `claimHook` all have one shape: insert the row,
 * and if somebody already wrote it, adopt theirs. Each is now ONE statement —
 * `with mine as (insert … on conflict do nothing returning …) select from mine
 * union all select from <table> where …` — which works because the outer select
 * reads the statement's snapshot, taken BEFORE the CTE's insert: exactly one arm
 * can produce a row, so `rows[0]` is the answer either way.
 *
 * ## Why it is one statement now
 *
 * It was an insert and then a separate select, and on the platform arm every
 * journal call is a POST that holds one of `ADMIN_POOL_MAX` reservations for the
 * whole request — measured in production at ~840 ms of server time. `appendStep`
 * fires once per settled step and `claimSleep` on every walk past a wait, so the
 * pair was the last engine call paying two round trips for one answer.
 *
 * ## Why a retry is needed AT ALL, which is the part that is not about latency
 *
 * `on conflict do nothing` does not WAIT for a concurrent inserter — Postgres
 * declines and moves on — and the two statements were separate autocommit
 * transactions, so a rival's uncommitted row made the insert a no-op AND stayed
 * invisible to the read. Both arms empty, and the store threw `workflow step …
 * vanished`: a plain `Error`, which `withReserved` answers with a **503**, which
 * tells the guest to retry — spending the message's attempt budget on a race
 * whose winner it could simply have read. Collapsing to one statement does not
 * close that by itself, because the union's second arm reads the same snapshot
 * the insert conflicted against. Re-running the whole statement does: by the next
 * attempt the rival has committed (adopt its row) or aborted (win the insert).
 *
 * ## Why not `on conflict … do update`, which would need no retry
 *
 * It is the textbook fix — `do update` BLOCKS on the rival instead of declining,
 * so one statement always returns one row — and it is wrong here for a reason
 * specific to a journal: an update writes a new row version even when it changes
 * nothing, and `claimSleep` is called on EVERY walk of the body past a wait. So
 * the common path, which is a pure read, would leave a dead tuple behind each
 * time, and a long run with overlapping walks pays that per walk per wait. This
 * shape keeps the read a read.
 *
 * ## And `do nothing` really does keep it a read — MEASURED, the objection named
 *
 * The paragraph above was challenged on the grounds that it refutes itself:
 * `insert … on conflict do nothing` performs SPECULATIVE INSERTION — the heap
 * tuple and its index entries are written and then super-deleted once the
 * conflict is detected — so this shape would leave the very dead tuple per walk
 * per wait it claims to avoid, and `do update` would cost nothing extra.
 *
 * It does not, and the reason is that the speculative path is not the conflicting
 * path. Postgres PRE-CHECKS the arbiter index before writing anything
 * (`ExecCheckIndexConstraints`, ahead of the heap insert in `ExecInsert`); a
 * `do nothing` whose pre-check finds a COMMITTED conflicting row returns having
 * written no tuple. Speculative insertion — and its super-deletion — is reached
 * only when the pre-check passes and the index insert then races an inserter it
 * could not see, which is the same rival {@link firstWriteWins} exists for and is
 * not the walk.
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
 * The `1` is the row the measurement seeded, and the third line is the positive
 * control — without it a run of zeroes is indistinguishable from a harness that
 * cannot see a dead tuple. `explain analyze` states it with no arithmetic at all:
 * `Tuples Inserted: 0`, `Conflicting Tuples: 1`. {@link claimHook}'s BARE
 * `on conflict do nothing` was measured the same way, conflicting on the primary
 * key and on `workflow_hooks_token_idx` in turn, and answered `0` for both: with
 * no arbiter named the pre-check covers every unique index on the table.
 *
 * The middle line is the one to read before "fixing" this shape. Putting the
 * existing row in a leading CTE and guarding the insert with it saves NOTHING on
 * the read path — there was no write to remove — and adds an index probe to
 * every claim on the busiest journal call the engine makes.
 *
 * Exhausting the attempts throws, which is a 503 and correct: the store genuinely
 * cannot say what the row holds, and this call is idempotent.
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
