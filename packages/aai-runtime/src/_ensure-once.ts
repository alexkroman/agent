// Copyright 2026 the AAI authors. MIT license.
/**
 * Run one-time async setup at most once, and never remember a failure as done.
 *
 * The shape both workflow stores need for their `create table if not exists`:
 * `record`/`lookup` and the wake-hint publisher are all called concurrently, so
 * the memo has to be on the PROMISE rather than a boolean flipped after the
 * await — several callers running the DDL at once is not a lost update so much
 * as a deadlock, because concurrent `create table if not exists` on one name
 * take conflicting locks.
 *
 * **A rejection clears the memo.** That is the half the two hand-rolled copies
 * disagreed on: `workflow-wake-hint.ts` cleared its flag in its runner's catch
 * (its comment argues the case — a transient privilege or connection fault has
 * to be recoverable without a redeploy), while `workflow-keys.ts` kept the
 * rejected promise, so one failed DDL made every later `record` and `lookup`
 * re-throw that same error for the life of the store. One primitive is what
 * stops two halves of one feature answering a transient fault differently.
 *
 * Note the retry is on the NEXT call, not automatic: nothing here loops or
 * backs off, because both callers already have their own cadence (a tool call,
 * a publish interval) and a retry loop underneath one would fight it.
 *
 * @internal
 */
export function ensureOnce(run: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return pending;
    // Wrapped so a SYNCHRONOUS throw inside `run` becomes a rejection like any
    // other. Clearing from inside a `try`/`catch` around the call does not work
    // for that case and looks like it does: the catch would run during the
    // memo's own assignment expression, so it clears a variable that is then
    // assigned the rejected promise — cached forever, which is the exact
    // failure this helper exists to prevent.
    const started = (async () => {
      await run();
    })();
    pending = started;
    // Cleared BY OWNERSHIP: a later caller may already have started a fresh
    // attempt by the time this one settles, and clearing unconditionally would
    // evict the successor's in-flight promise. Attached rather than chained
    // into the return value, so callers still see the original rejection.
    started.catch(() => {
      if (pending === started) pending = undefined;
    });
    return started;
  };
}
