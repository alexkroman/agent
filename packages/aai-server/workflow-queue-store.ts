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
import { createLogger } from "./logger.ts";
import type { SqlExec } from "./secret-store.ts";

const log = createLogger("workflow.queue");

/** Backoff for a delivery that failed, indexed by the attempt just made. */
const RETRY_BACKOFF_MS = [1000, 5000, 15_000, 60_000, 300_000] as const;

/**
 * Attempts after which a message is abandoned.
 *
 * Bounded, because a message whose guest cannot be reached is not made more
 * deliverable by trying forever, and every attempt boots a sandbox. Past this the
 * row is dropped and the run stalls — which the DevKit already recovers from on
 * any later boot, since its world re-enqueues active runs on `start()`.
 */
export const QUEUE_MAX_ATTEMPTS = RETRY_BACKOFF_MS.length;

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
 * Tell a listening replica to look, when the message is due NOW.
 *
 * Skipped for a delayed message, which is the whole reason this is a condition
 * rather than an unconditional notify: a `NOTIFY` says "look now" and there is
 * nothing to find until `available_at` passes, so announcing a 30-second sleep
 * would wake every replica to run a query that returns nothing. A parked message
 * is what the periodic pass is FOR — see {@link WORKFLOW_QUEUE_CHANNEL} — and it
 * is the one thing a notification cannot express.
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
 * already due. The rule above is unchanged and is what makes this safe: the test
 * is the delay, not the caller, so a real `sleep()` still announces nothing.
 *
 * The delay is in MILLISECONDS, which is the unit both call sites already hold —
 * `reschedule` rounds a fractional `delaySeconds` into them, and passing seconds
 * from one caller and milliseconds from the other would make the `> 0` test read
 * differently on each.
 */
async function announce(sql: SqlExec, delayMs: number): Promise<void> {
  if (delayMs > 0) return;
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

/**
 * A message whose delivery failed: back off, or abandon it.
 *
 * Reports which happened, because the two are different operational events — a
 * retry is noise and an abandonment is a stalled run.
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
