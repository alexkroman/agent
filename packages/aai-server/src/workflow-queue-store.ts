// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable-workflow queue, as rows the platform owns.
 *
 * `$n::text::jsonb`, never `$n::jsonb`, is the repo's binding for a jsonb
 * parameter, and the difference is not cosmetic: a value written through BOTH
 * `JSON.stringify` and a bare `::jsonb` round-trips DOUBLE-ENCODED — the column
 * holds the JSON as a jsonb *string*, so `payload->>'runId'` is null for every
 * row. The `run_id` column is `generated always as (payload ->> 'runId')`, so
 * that bug now makes every row's `run_id` null and {@link claimDue} claims NONE
 * of them, where it used to collapse the `distinct on` to a single candidate and
 * keep delivering. Either way it is caught only by the real-Postgres tier, which
 * is precisely what `jsonb-encoding.scenario.test.ts` and the
 * `normalize_double_encoded_jsonb` migration exist for. A fake cannot see it: a
 * fake holds JS values.
 *
 * A DELAY crosses as `$n::bigint * interval '1 millisecond'`, never
 * `($n || ' milliseconds')::interval`. The old spelling concatenated a parameter
 * into a string and cast the result, so the parameter's TYPE was decided by
 * whatever text it happened to hold and a bad value was a runtime SQL error
 * rather than a rejected bind; and the three statements below plus the claim's
 * five sites had to keep spelling the same trick the same way. Every delay here
 * is in milliseconds for the same reason: one unit, so `announce`'s "is this due
 * now" test reads identically wherever it is called from.
 *
 * `aai_platform.workflow_queue`'s own migration carries why this exists at all —
 * graphile-worker's `LISTEN` connection is the thing being given back, and it
 * could not route per tenant anyway. What is here is the four operations a queue
 * needs and nothing else: enqueue, claim, ack, and fail.
 *
 * ## Delivery is OUT OF BAND, and a spike is why
 *
 * `enqueue` writes a row and returns. It does not deliver, and it must not: a
 * `"use workflow"` handler enqueues a message for its OWN run, so a queue that
 * awaited delivery inside the enqueue call stack blocks the handler behind a
 * message the handler is itself waiting for. Measured on a stand-in that did
 * exactly that — six deliveries entered, none completed, and the whole chain
 * timed out. graphile-worker never has this because its `enqueue` is a row and
 * its delivery is a later poll; this is that shape.
 *
 * The corollary is that per-run ORDERING belongs to the claimer rather than to
 * the enqueue, which is what {@link claimDue}'s one-per-run rule is for. An
 * earlier stand-in with no ordering at all took a bounded fan-out from
 * `completed` to `failed`.
 *
 * ## What is deliberately NOT here
 *
 * The HTTP delivery itself, and the interval that drives it. This module is the
 * store: it says which messages are due and moves them between states, so it can
 * be tested against a real Postgres without a guest, a broker or a sandbox. The
 * sweep that consumes it is the caller's.
 *
 * @module
 */

import { isRecord } from "@alexkroman1/aai/utils";
import { queueNameKind } from "@alexkroman1/aai-runtime/internal";
import { envMs } from "./constants.ts";
import { createLogger } from "./logger.ts";
import type { SqlExec } from "./secret-store.ts";

const log = createLogger("workflow.queue");

/** One queued message, as the sweep sees it. */
export type QueuedMessage = {
  id: string;
  slug: string;
  queueName: string;
  payload: unknown;
  headers?: Record<string, string> | undefined;
  deploymentId?: string | undefined;
  attempt: number;
};

/** What {@link enqueue} is given. */
/**
 * What a queue row's `payload` holds — the queue's OWN envelope, not the
 * DevKit's message.
 *
 * The distinction matters twice. The column is `jsonb`, because the `run_id`
 * column the claim serializes on is `generated always as (payload ->> 'runId')`
 * — an opaque `bytea` could not be projected that way, and per-run ordering is
 * the one thing this queue has to get right. But what a run actually sends is
 * BINARY: the DevKit serializes with devalue and its executor is handed those
 * bytes verbatim. So the bytes ride in `data` as base64, and the platform never
 * parses them — a queue that understood that payload would be a second
 * implementation of somebody else's serialization format.
 *
 * Base64 rather than a `bytea` column beside the jsonb for the same reason
 * `@workflow/world-postgres` does it ("graphile-worker is using JSON under the
 * hood, so we need to base64 encode the body to ensure binary safety"): one
 * value means one write, one read, and no way for the two halves of a message to
 * disagree about which row they belong to.
 *
 * @internal
 */
export type QueueEnvelope = {
  /** The run these messages are ordered within. See {@link claimDue}. */
  runId: string;
  /** The DevKit's opaque message body, base64. */
  data: string;
};

/**
 * Read an envelope off a row, or throw naming what was wrong with it.
 *
 * THROWS rather than returning undefined because every caller's only recourse is
 * to fail the delivery, and a thrown error carries the diagnosis. It is also a
 * PERMANENT failure — a malformed row will not become valid — so it burns the
 * message's retry budget and is then abandoned with a warning. That is accepted
 * rather than optimal: a distinct "drop this now" outcome would be machinery for
 * a case that means the enqueue side wrote a row it should not have, and the
 * warning names it either way.
 */
export function parseEnvelope(payload: unknown): QueueEnvelope {
  if (!isRecord(payload)) throw new Error("queue payload is not an object");
  const { runId, data } = payload;
  if (typeof runId !== "string" || runId === "") {
    throw new Error("queue payload has no runId");
  }
  if (typeof data !== "string") throw new Error("queue payload has no data");
  return { runId, data };
}

/** The DevKit's message body, decoded from an envelope. */
export function envelopeBody(envelope: QueueEnvelope): Buffer {
  return Buffer.from(envelope.data, "base64");
}

export type EnqueueParams = {
  id: string;
  slug: string;
  queueName: string;
  payload: unknown;
  headers?: Record<string, string> | undefined;
  deploymentId?: string | undefined;
  idempotencyKey?: string | undefined;
  /** `QueueOptions.delaySeconds` — how `sleep` is implemented. */
  delaySeconds?: number | undefined;
};

/**
 * Write one message. Resolves the id that will be delivered, which is NOT always
 * the id passed in.
 *
 * **An idempotency key collapses a duplicate, and the winner's id is returned.**
 * `QueueOptions.idempotencyKey` means "this message is the same message", so a
 * second enqueue must not produce a second delivery — and the caller needs the id
 * that really exists, not the one it offered. `on conflict … do nothing` plus a
 * read-back rather than `do update`: touching the existing row would move a
 * message that may already be claimed, which is how a duplicate becomes a
 * double delivery.
 */
/**
 * The longest delay whose arrival is still worth ANNOUNCING — the sweep's own
 * `WORKFLOW_QUEUE_INTERVAL_MS`, read from the same variable with the same
 * default.
 *
 * DECLARED rather than imported, and the duplication is deliberate: the sweep
 * imports this module, so importing it back would make a cycle out of a constant
 * both ends only read. The expression is identical, so the two cannot drift by
 * configuration; `workflow-queue-due-soon.test.ts` pins them equal so they cannot
 * drift by edit either.
 *
 * Why the interval is the right ceiling, from both sides. AT OR UNDER it, a row
 * can become due before the next tick and the tick is therefore the wrong
 * instrument — see {@link announce}. ABOVE it, a tick is already going to run
 * before the row is due, so an announcement buys nothing and costs every replica
 * a wakeup.
 */
export const QUEUE_DUE_SOON_MS = envMs(process.env.WORKFLOW_QUEUE_INTERVAL_MS, 1000);

/**
 * Tell a listening replica to look, when the message is due NOW or SOON.
 *
 * A `NOTIFY` says "look now" and there is nothing to find until `available_at`
 * passes, so this used to skip a delayed message entirely: announcing a
 * 30-second sleep would wake every replica to run a query that returns nothing,
 * and a parked message is what the periodic pass is FOR — see {@link
 * WORKFLOW_QUEUE_CHANNEL}.
 *
 * ## Which made the interval a latency FLOOR for a SHORT sleep
 *
 * That argument holds for a sleep measured in minutes and fails for one measured
 * in milliseconds. Nothing announces a row parked for 100 ms, so it waits for the
 * next tick — and the tick is on its own cadence, so `ctx.sleep("beat", 100)` and
 * `ctx.sleep("beat", 900)` resumed at the SAME moment, one full
 * `WORKFLOW_QUEUE_INTERVAL_MS` from the enqueue on average, with a poll-shaped
 * body paying it per iteration. `workflow-platform-dispatch.ts` measured the
 * residual at ~780 ms and named this line as the cause.
 *
 * So a delay at or under {@link QUEUE_DUE_SOON_MS} announces too. The pass that
 * wakes CLAIMS NOTHING — the row is not due yet, which is exactly the objection
 * above — and that is not the point of it: a pass also reads
 * {@link msUntilNextDue}, so what the wakeup really buys is the sweep learning
 * "due at T" and scheduling one extra look for it. The notification still says
 * only "look", and carries no payload, so nothing here can be tempted into
 * delivering FROM it.
 *
 * A pass triggered this way is one indexed claim plus one indexed read, and the
 * scheduler's coalescing runner collapses a burst of them, so a fan-out of short
 * sleeps costs one wakeup rather than one per branch.
 *
 * Failures are swallowed, deliberately: the row is committed and the periodic pass
 * will find it, so a failed announcement costs latency and nothing else. Letting
 * it reject would turn a successful enqueue into a caller-visible error.
 *
 * **{@link reschedule} announces through here too, and did not.** A guest that
 * parks with `{"timeoutSeconds": 0}` — a busy walk asking to be re-presented
 * immediately, which is what `queueDeliveryBusySeconds` answers for a walk that
 * has barely started — was re-parked with `available_at = now()` and NO notify,
 * so it waited out a whole `WORKFLOW_QUEUE_INTERVAL_MS` for a message that was
 * already due. The test is the DELAY and not the caller, which is what keeps one
 * rule over both call sites.
 *
 * The delay is in MILLISECONDS, which is the unit both call sites already hold —
 * `reschedule` rounds a fractional `delaySeconds` into them, and passing seconds
 * from one caller and milliseconds from the other would make the test read
 * differently on each.
 */
async function announce(sql: SqlExec, delayMs: number): Promise<void> {
  if (delayMs > QUEUE_DUE_SOON_MS) return;
  try {
    await sql("select pg_notify($1, '')", [WORKFLOW_QUEUE_CHANNEL]);
  } catch (error) {
    log.debug("queue notify failed; the periodic pass will pick this up", {
      error: String(error),
    });
  }
}

/**
 * The `NOTIFY` channel an enqueue announces on, and the sweep listens to.
 *
 * Exported because two modules must not spell it differently — a mismatch is
 * silent, and its only symptom is every step-to-step hop paying the poll interval
 * again, which reads as "durable workflows are just slow".
 *
 * ## What a notification is, and is not
 *
 * It is a HINT that work may be due, carrying no payload. It is NOT the record
 * that work exists — that is the row this function inserts. A notification is
 * dropped rather than queued when nothing is listening, and a listener
 * re-establishing its connection misses everything committed in between, so the
 * periodic pass is not a fallback for a broken deployment but a permanent part of
 * the design.
 *
 * The payload is deliberately empty. A payload would tempt a reader into
 * delivering FROM it, and a message delivered from a signal Postgres may drop is
 * a message that silently never runs.
 */
export const WORKFLOW_QUEUE_CHANNEL = "aai_workflow_queue";

/**
 * Which of {@link claimDue}'s two serialization domains this message belongs to,
 * decided at the DOOR and stored.
 *
 * The DevKit's queue-name grammar is applied here, once, in TypeScript. It used
 * to be applied in the CLAIM instead, as two POSIX-ERE patterns crossing the
 * package boundary as SQL parameters, and the column is not merely faster: a
 * value written at enqueue records what the classifier said AT THE TIME, so a
 * DevKit that renames a topic cannot reclassify a row already in the table. A
 * generated column would have the same defect as the regexes, with the grammar
 * duplicated into the DDL as well.
 *
 * `null` for a name the grammar does not recognise, and that is not a fallback:
 * the claim requires `kind = 'workflow'` or `kind = 'step'` positively, so such
 * a row is claimed by NOBODY. It also cannot arrive through the real route —
 * `workflow-enqueue-handler.ts` answers 400 before calling this — which is what
 * makes the two predicates exhaustive over the table. The table's own
 * `check (kind in ('workflow', 'step'))` then refuses any THIRD value, so a new
 * kind that nobody taught the claim about fails at the insert rather than
 * sitting unclaimable.
 */
function queueKind(queueName: string): "workflow" | "step" | null {
  return queueNameKind(queueName) ?? null;
}

export async function enqueue(sql: SqlExec, params: EnqueueParams): Promise<{ id: string }> {
  const delayMs = Math.max(0, Math.round((params.delaySeconds ?? 0) * 1000));
  const rows = await sql(
    // `kind` is written HERE and nowhere else, which is what makes the claim's
    // two `kind = …` predicates exhaustive over the table — see
    // {@link queueKind}. `run_id` is not in this list on purpose: it is a
    // GENERATED column over `payload`, so naming it would be an error rather
    // than a duplication.
    `insert into aai_platform.workflow_queue
       (id, slug, queue_name, kind, payload, headers, deployment_id, idempotency_key,
        available_at)
     values ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb, $7, $8,
             now() + $9::bigint * interval '1 millisecond')
     on conflict do nothing
     returning id`,
    [
      params.id,
      params.slug,
      params.queueName,
      queueKind(params.queueName),
      JSON.stringify(params.payload ?? null),
      params.headers === undefined ? null : JSON.stringify(params.headers),
      params.deploymentId ?? null,
      params.idempotencyKey ?? null,
      String(delayMs),
    ],
  );
  const inserted = rows[0]?.id;
  if (typeof inserted === "string") {
    await announce(sql, delayMs);
    return { id: inserted };
  }

  // Conflicted. With a key, the existing row IS this message; without one the
  // only unique column is the id, so a conflict means this exact id is already
  // queued and returning it is equally correct.
  if (params.idempotencyKey === undefined) return { id: params.id };
  const existing = await sql(
    `select id from aai_platform.workflow_queue
     where slug = $1 and idempotency_key = $2`,
    [params.slug, params.idempotencyKey],
  );
  const id = existing[0]?.id;
  if (typeof id === "string") {
    log.debug("duplicate collapsed", { slug: params.slug, id });
    return { id };
  }
  // The conflicting row was delivered and removed between the insert and this
  // read. The message is genuinely new again, so retry once WITHOUT the key
  // rather than reporting a duplicate that no longer exists. `omitUndefined`
  // would widen every field to optional here, so the key is dropped by
  // destructuring instead.
  const { idempotencyKey: _dropped, ...withoutKey } = params;
  return enqueue(sql, withoutKey);
}

/**
 * How long until the earliest PARKED message becomes due, or `undefined` when
 * nothing is parked.
 *
 * ## What it is for: the interval is a latency FLOOR for a short sleep
 *
 * A `NOTIFY` means "look now" and there is nothing to find until `available_at`
 * passes, so nothing announced a future-dated row and a parked message waited
 * for the periodic pass. That is right for a `sleep()` measured in minutes and
 * badly wrong for one measured in milliseconds: everything below
 * `WORKFLOW_QUEUE_INTERVAL_MS` cost the SAME as one full interval, so an author's
 * `ctx.sleep("beat", 100)` and `ctx.sleep("beat", 900)` resumed at the same
 * moment and a poll-shaped body paid that per iteration.
 * `workflow-platform-dispatch.ts`'s own note measured the residual at ~780 ms and
 * named it as the cause.
 *
 * So a short park announces (see {@link announce}), the pass it wakes ASKS this,
 * and the sweep schedules one extra look at the answer — see
 * `startWorkflowQueueSweep`. That expresses "due at T", which is exactly what a
 * notification cannot, and it does it without a payload: a duration read out of
 * the table names no message, so nothing here can be tempted into delivering
 * FROM the signal — the rule {@link WORKFLOW_QUEUE_CHANNEL} states and
 * `CloseableDb.listen` drops the payload to enforce.
 *
 * ## It is one index scan, and that is what makes it affordable per pass
 *
 * `workflow_queue_due_idx` is `(available_at) where locked_at is null` — partial
 * on the CLAIM, not on the clock — so a future row is in it and in order. The
 * query is therefore an ordered index scan stopping at the first row, on the
 * connection the claim already holds; it is not a `min()` over the table.
 *
 * The delay is computed by POSTGRES, like every other timestamp arithmetic here,
 * so a replica with a skewed clock cannot schedule its extra look into another
 * replica's past. It is a FLOOR rather than an instant for the same reason a
 * caller may always be answered late and never early: the row was still parked
 * when this ran, so a pass this many milliseconds from now cannot be early.
 */
export async function msUntilNextDue(sql: SqlExec): Promise<number | undefined> {
  const rows = await sql(
    `select ceil(extract(epoch from (available_at - now())) * 1000)::bigint as ms
       from aai_platform.workflow_queue
      where locked_at is null and available_at > now()
      order by available_at
      limit 1`,
  );
  const ms = Number(rows[0]?.ms);
  // NOT `?? undefined`: an empty queue, a non-numeric answer and a row that
  // became due while this ran are all "nothing to schedule a look for", and the
  // caller's only alternative would be to invent a delay.
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

// The DELIVERY CLAIM — `claimDue`, `QUEUE_CLAIM_STALE_MS` and
// `WORKFLOW_QUEUE_STEPS_PER_RUN` — is `workflow-queue-claim.ts`. It came out at the
// 500-line cap, on the seam this module already had: everything here is one
// message's own lifecycle (enqueue, envelope, ack, reschedule, fail), where the
// claim is a question asked of the whole TABLE and is the only part of the queue
// that has an opinion about how a run's messages are allowed to overlap.

/** A message that was delivered. Removed, not marked — a delivered row is done. */
export async function ack(sql: SqlExec, id: string): Promise<void> {
  await sql("delete from aai_platform.workflow_queue where id = $1", [id]);
}

/**
 * A message the guest asked to be brought back LATER, rather than one that
 * failed.
 *
 * This is how `sleep()` works, and it is the third outcome of a delivery — not
 * the second. The DevKit's queue callback answers `200` with a
 * `{"timeoutSeconds": n}` body when the run parked itself, and the queue is
 * expected to re-present the same message after that long. Reading it as
 * "completed" silently strands every run that sleeps; reading it as "failed"
 * would work by accident for a few minutes and then abandon the run at the
 * retry budget, which is worse — a wedge that looks like a delivery problem.
 *
 * So the ATTEMPT IS NOT TOUCHED. A sleeping run consumes no retry budget: a run
 * that parks itself thirty times is healthy, and charging it thirty attempts
 * would cap the number of times a workflow may sleep at five.
 *
 * `available_at` is computed by POSTGRES, deliberately — every other timestamp
 * in this table is, so a replica with a skewed clock cannot schedule a message
 * into another replica's past (or future). The delay is clamped at zero because
 * the value comes from tenant code by way of the DevKit, and a negative
 * interval would make the message due before it was written.
 *
 * **A zero-delay re-park ANNOUNCES**, like an immediate {@link enqueue}, and did
 * not: the row went back due-now with nothing telling a listener to look, so a
 * guest re-parking a busy walk paid a full `WORKFLOW_QUEUE_INTERVAL_MS` per hop.
 * {@link announce} carries the rest, including why a real `sleep()` still says
 * nothing.
 */
export async function reschedule(sql: SqlExec, id: string, delaySeconds: number): Promise<void> {
  const delayMs = Math.max(0, Math.round(delaySeconds * 1000));
  await sql(
    `update aai_platform.workflow_queue
        set locked_at = null,
            available_at = now() + $2::bigint * interval '1 millisecond'
      where id = $1`,
    [id, String(delayMs)],
  );
  await announce(sql, delayMs);
}
