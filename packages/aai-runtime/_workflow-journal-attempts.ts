// Copyright 2026 the AAI authors. MIT license.
/**
 * The attempt LEASE, as SQL. One row per outstanding attempt.
 *
 * Extracted from `workflow-journal-postgres.ts` at the 500-line cap, and the
 * seam is a concept rather than a convenience: everything else in that module
 * is a fact about a run's HISTORY — a step that settled, a wait that was
 * registered, a status that moved — and every one of those rows is permanent.
 * A lease is the opposite: it is a claim about the PRESENT, it has no meaning
 * once the step settles, and it is the only thing in the journal that expires.
 *
 * ## What a scalar counter could not do
 *
 * This was `n integer` keyed `(run_id, key)`, incremented by a claim and
 * decremented by a release. The number it answered was right, and the charge a
 * DEAD walk left was indistinguishable from a live one — so it stood forever,
 * and `maxAttempts` deaths on one step key refused that step permanently, with
 * `StepAbandonedError` reporting a run nobody could revive. Expiring individual
 * charges needs a timestamp per charge, which needs a row per charge, which
 * needs the holder in the primary key.
 *
 * `JournalStore.claimAttempt` carries the contract and
 * `ATTEMPT_LEASE_MS` (`workflow-replay-attempt.ts`) carries the window.
 *
 * @internal
 */

import type { CloseableDb } from "./postgres-db.ts";

/** Which lease, and how long a charge counts for. */
export type AttemptLease = {
  runId: string;
  key: string;
  /** The walk that holds it — `replayRun` mints one id per walk. */
  holder: string;
  /** How long ago a charge may have started and still count. */
  leaseMs: number;
};

/**
 * Charge one attempt, and answer how many are outstanding.
 *
 * ONE statement, and ONE ROW per `(run_id, key)` holding a map of holder to when
 * that holder claimed. Both halves of that are load-bearing.
 *
 * ## The row is what makes it ATOMIC, and a row per HOLDER was not
 *
 * The obvious shape — one row per outstanding attempt, `(run_id, key, holder)`
 * as the key — is what this was first written as, and it is WRONG under
 * concurrency. Two claims by different holders conflict on nothing, so each
 * inserts its own row and each counts under its own snapshot, in which the
 * other's insert does not exist. Both answer `1`, both read that as a first
 * reach, and a step's ceiling stops bounding anything. Measured on a real
 * Postgres: three concurrent claims answered `[1, 1, 3]` where the contract is
 * that no two ever agree.
 *
 * Colliding on ONE row restores what the scalar counter had: the second
 * statement blocks on the row lock, then re-evaluates `do update` against the
 * first's committed value. The map is the part the counter could not do.
 *
 * ## The map is what makes a charge EXPIRE
 *
 * A scalar `n` cannot: the charge a DEAD walk left is indistinguishable from a
 * live one, so it stood forever and `maxAttempts` deaths on one step key refused
 * that step permanently, with `StepAbandonedError` reporting a run nobody could
 * revive. Expiring individual charges needs an instant per charge, and a map of
 * holder to instant is that — pruned on every claim, so a dead walk's charge is
 * forgotten rather than merely uncounted.
 *
 * ## Three cases, and the `case` is the third one
 *
 * | | prune keeps self? | `||` adds self? | answer |
 * | --- | --- | --- | --- |
 * | a new holder | n/a (absent) | yes | correct |
 * | a LIVE holder re-claiming | yes, at its ORIGINAL instant | no | correct |
 * | an EXPIRED holder re-claiming | no | yes, at now | correct |
 *
 * The middle row is the contract: a re-claim by a live holder must NOT refresh
 * its instant, or a walk that keeps re-reaching one key holds its charge
 * indefinitely — the failure the expiry exists to end, by a slower route. That
 * is the whole of what the `case` is for, and an unconditional `||` would delete
 * it silently.
 *
 * **The CLAIMER always counts, and the `||` is what guarantees it** — not the
 * comparison. Whichever branch the `case` takes, this holder is in the map
 * afterwards: kept by the prune when it was live, added by the `||` when it was
 * not. So the answer is at least 1 for any window, including zero. That is
 * worth stating because the obvious reading is wrong: an earlier draft of this
 * counted the claimer out of a separate `live` subquery and answered `0` at a
 * window of zero, which `chargeAttempt` reads as neither a first reach nor a
 * spent budget.
 *
 * The cutoff comparison is inclusive (`>=`) by convention rather than by
 * necessity: it decides only whether a charge taken in the same millisecond as
 * the cutoff survives, which nothing observes.
 *
 * Instants are stored as TEXT inside the map. `jsonb` numbers are `numeric`, so
 * a round trip through one is a question about precision nobody needs to ask;
 * text with an explicit `::bigint` on the way out is one operator with nothing
 * to drift.
 *
 * @internal
 */
export async function claimAttemptLease(
  db: Pick<CloseableDb, "query">,
  table: string,
  lease: AttemptLease,
): Promise<number> {
  const at = Date.now();
  const rows = await db.query<{ n: number | string }>(
    `insert into ${table} (run_id, key, holders)
     values ($1, $2, jsonb_build_object($3::text, $4::text))
     on conflict (run_id, key) do update
        set holders = (
              select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                from jsonb_each_text(${table}.holders) as e
               where e.value::bigint >= $5
            ) || (
              case
                when (${table}.holders ->> $3) is not null
                 and (${table}.holders ->> $3)::bigint >= $5
                then '{}'::jsonb
                else jsonb_build_object($3::text, $4::text)
              end
            )
     returning (select count(*) from jsonb_object_keys(holders))::int as n`,
    [lease.runId, lease.key, lease.holder, String(at), String(at - lease.leaseMs)],
  );
  const n = rows[0]?.n;
  if (n === undefined) {
    throw new Error(`workflow attempt claim returned nothing for ${lease.runId}`);
  }
  return Number(n);
}

/**
 * Give one attempt back, by NAME.
 *
 * ONE statement, and `holders - $3` removes exactly that holder's entry rather
 * than decrementing a number it cannot attribute: a release that lands twice
 * removes nothing the second time, and it can no longer take another walk's
 * charge. A missing row is a no-op — there is nothing charged to give back.
 *
 * The row is LEFT BEHIND when its last holder releases, which is deliberate: an
 * empty map is what a fresh key looks like, so deleting the row buys nothing and
 * would have to be part of the same statement to be safe.
 *
 * @internal
 */
export async function releaseAttemptLease(
  db: Pick<CloseableDb, "query">,
  table: string,
  lease: Omit<AttemptLease, "leaseMs">,
): Promise<void> {
  await db.query(
    `update ${table} set holders = holders - $3::text where run_id = $1 and key = $2`,
    [lease.runId, lease.key, lease.holder],
  );
}
