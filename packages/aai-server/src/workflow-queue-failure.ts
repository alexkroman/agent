// Copyright 2026 the AAI authors. MIT license.
/**
 * What a FAILED delivery costs, and which budget it spends.
 *
 * Split from `workflow-queue-store.ts` at the 500-line cap, and the seam is the
 * one this change made real. That module is one message's LIFECYCLE — enqueue
 * it, read its envelope, ack it, reschedule it — each addressed by id and each
 * with one obvious thing to do. This is the part with a JUDGEMENT in it: a
 * delivery can go wrong in two ways that want different patience, and deciding
 * which one happened is now something the platform does rather than something
 * it conflates.
 *
 * ## Two budgets, because "it failed" was two facts
 *
 * | | the guest ANSWERED | the guest was never REACHED |
 * | --- | --- | --- |
 * | Cause | a step threw, a 4xx, a lost response | a boot still in flight, no deployed version |
 * | Says something about the message? | yes | no |
 * | Budget | {@link QUEUE_MAX_ATTEMPTS}, 5 | {@link QUEUE_MAX_UNREACHABLE_ATTEMPTS}, 7 |
 * | Backoff | {@link RETRY_BACKOFF_MS}, ~6 min | {@link UNREACHABLE_BACKOFF_MS}, ~10 min |
 *
 * One budget served both, so the cheapest infrastructure condition there is —
 * the broker answering 503 because a boot is still in flight, which is
 * literally "up but not ready" — spent the same attempt as a step that threw.
 * Five of those inside ~380 s dropped the message, and the run then waited out
 * `STALL_GRACE_MS` before `workflow-queue-reconcile.ts` brought it back:
 * sixteen minutes and six sandbox boots, over a condition that was never about
 * the message. `workflow-queue-deliver.ts`'s own comment had already recorded
 * the shape of it one failure class over — "the guest answered 401, the sweep
 * burned all five attempts".
 *
 * The delivery protocol this reproduces uses **48** attempts where we use five,
 * and the difference is what an attempt COSTS: theirs is an HTTP request to a
 * running executor, ours may boot a Modal sandbox. That is the argument for
 * splitting the budgets rather than raising the one — the expensive question
 * stays asked rarely, and the question that is cheap to be wrong about gets
 * room.
 *
 * @module
 */

import { createLogger } from "./logger.ts";
import type { SqlExec } from "./secret-store.ts";
import { ack } from "./workflow-queue-store.ts";

const log = createLogger("workflow.queue.failure");

/** Backoff for a delivery the guest REFUSED, indexed by the attempt just made. */
const RETRY_BACKOFF_MS = [1000, 5000, 15_000, 60_000, 300_000] as const;

/**
 * Attempts after which a message the guest REFUSED is abandoned.
 *
 * Bounded, because a message a guest keeps rejecting is not made more
 * deliverable by trying forever, and every attempt boots a sandbox. Past this
 * the row is dropped and the run stalls until `workflow-queue-reconcile.ts`
 * notices — the recovery this bound has always assumed, and which the replay
 * engine had to be given explicitly.
 */
export const QUEUE_MAX_ATTEMPTS = RETRY_BACKOFF_MS.length;

/**
 * Backoff for a delivery that never REACHED a guest, indexed by the unreachable
 * attempt just made.
 *
 * Longer and more patient than {@link RETRY_BACKOFF_MS}, because what it waits
 * for is different in kind: a sandbox finishing its boot
 * (`BROKER_READY_TIMEOUT_MS` is 20 s, so the first two entries clear one), or a
 * fleet-level blip. Nothing here is a fact about the message.
 *
 * The total — ~9.7 minutes over seven attempts — lands just INSIDE
 * `STALL_GRACE_MS` (10 minutes), and that is the constraint rather than a
 * coincidence. While a message still has unreachable attempts left it IS the
 * thing scheduled to deliver its run, so reconcile's predicate ("not finished
 * and nothing is scheduled to touch it") is false and the two mechanisms cannot
 * both enqueue. Widening this past the grace would make them race.
 */
const UNREACHABLE_BACKOFF_MS = [2000, 10_000, 30_000, 60_000, 120_000, 180_000, 180_000] as const;

/** Unreachable attempts after which even a blameless message is abandoned. */
export const QUEUE_MAX_UNREACHABLE_ATTEMPTS = UNREACHABLE_BACKOFF_MS.length;

/**
 * A delivery that never asked the guest anything.
 *
 * **Thrown only where NO REQUEST WAS SENT**, which is what makes the
 * classification sound rather than optimistic: the broker refusing (404 for a
 * slug whose agent is gone, 503 for a boot still in flight), or no deployed
 * version to derive a bearer from. A `fetch` that THROWS is deliberately not
 * one of these — the guest may have received the message and be running the
 * step, so a delivery whose response was lost is exactly the ambiguous case
 * that has to keep the stricter budget.
 */
export class GuestUnreachableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GuestUnreachableError";
  }
}

/** Whether `err` is a {@link GuestUnreachableError}. */
export function isGuestUnreachable(err: unknown): boolean {
  return err instanceof GuestUnreachableError;
}

/**
 * A message the guest REFUSED: back off, or abandon it.
 *
 * Reports which happened, because the two are different operational events — a
 * retry is noise and an abandonment is a stalled run.
 *
 * A delivery that never reached a guest goes to {@link failUnreachable} on a
 * budget of its own; {@link GuestUnreachableError} is where that line is drawn.
 */
export async function fail(
  sql: SqlExec,
  id: string,
  attempt: number,
): Promise<"retry" | "dropped"> {
  const next = attempt + 1;
  if (next >= QUEUE_MAX_ATTEMPTS) {
    await ack(sql, id);
    log.warn("message abandoned after the retry budget", { id, attempt: next });
    return "dropped";
  }
  // In range by construction: the guard above returned for every `attempt` the table
  // does not cover, so this is at most `QUEUE_MAX_ATTEMPTS - 2`. The `??` is what
  // `noUncheckedIndexedAccess` asks for, not a real branch. It used to carry TWO arms
  // that disagreed about the value — `.at(-1)` (300_000) and a literal 60_000 — so
  // whichever fired was a coin flip about intent; one arm, matching the table's own
  // longest wait, is the whole of what an unreachable fallback can honestly say.
  const backoffMs = RETRY_BACKOFF_MS[attempt] ?? 300_000;
  await sql(
    `update aai_platform.workflow_queue
        set attempt = $2,
            locked_at = null,
            available_at = now() + $3::bigint * interval '1 millisecond'
      where id = $1`,
    [id, next, String(backoffMs)],
  );
  // No {@link announce} here, and it is not an omission: every entry in
  // `RETRY_BACKOFF_MS` is positive, so a failed delivery is never due now and a
  // notification would wake every replica to find nothing.
  return "retry";
}

/**
 * A message whose guest could not be REACHED: back off patiently, or abandon it.
 *
 * **ONE statement on the happy path, and the increment is Postgres's.** The
 * backoff table crosses as a `bigint[]` and is subscripted by the INCREMENTED
 * counter, so the delay is chosen from the value that was stored — a
 * read-then-write would be two round trips and could disagree with itself.
 * `least` clamps the subscript, so a counter past the table's end (which only a
 * hand-edited row produces) reads its longest wait rather than NULL — which
 * would make `available_at` null and the message permanently invisible.
 *
 * `returning` reads the new count back, so the drop DECISION costs nothing
 * extra; only the drop itself takes a second statement.
 *
 * No {@link announce}, for the same reason {@link fail} does not: every entry in
 * {@link UNREACHABLE_BACKOFF_MS} is positive, so the message is never due now.
 */
export async function failUnreachable(sql: SqlExec, id: string): Promise<"retry" | "dropped"> {
  const rows = await sql(
    `update aai_platform.workflow_queue q
        set unreachable_attempts = q.unreachable_attempts + 1,
            locked_at = null,
            available_at = now()
              + ($2::bigint[])[least(q.unreachable_attempts + 1, $3)] * interval '1 millisecond'
      where q.id = $1
     returning q.unreachable_attempts`,
    [id, `{${UNREACHABLE_BACKOFF_MS.join(",")}}`, QUEUE_MAX_UNREACHABLE_ATTEMPTS],
  );
  // No row means the message is GONE — an agent deleted mid-pass cascades its
  // queue away. Nothing to abandon, and reporting a retry would promise a
  // delivery that will never come, so it reads as dropped.
  const spent = Number(rows[0]?.unreachable_attempts ?? QUEUE_MAX_UNREACHABLE_ATTEMPTS);
  if (spent < QUEUE_MAX_UNREACHABLE_ATTEMPTS) return "retry";
  await ack(sql, id);
  // WARN, and worded as the FLEET's problem rather than the message's: the
  // remedy is on the platform side, not in the tenant's workflow.
  log.warn("message abandoned — its guest was never reachable", {
    id,
    unreachableAttempts: spent,
  });
  return "dropped";
}
