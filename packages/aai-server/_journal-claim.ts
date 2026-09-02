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
