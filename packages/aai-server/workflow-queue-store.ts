// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable-workflow queue, as rows the platform owns.
 *
 * `$n::text::jsonb`, never `$n::jsonb`, is the repo's binding for a jsonb
 * parameter, and the difference is not cosmetic: a value written through BOTH
 * `JSON.stringify` and a bare `::jsonb` round-trips DOUBLE-ENCODED — the column
 * holds the JSON as a jsonb *string*, so `payload->>'runId'` is null for every
 * row. That silently collapsed this module's `distinct on` to a single candidate,
 * caught only by the real-Postgres tier, which is precisely the bug
 * `jsonb-encoding.scenario.test.ts` and the `normalize_double_encoded_jsonb`
 * migration already exist for. A fake cannot see it: a fake holds JS values.
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

import { omitUndefined } from "@alexkroman1/aai/utils";
import { createLogger } from "./logger.ts";
import type { SqlExec } from "./secret-store.ts";

const log = createLogger("workflow.queue");

/**
 * How long a claim may go unfinished before the sweep may take it again.
 *
 * A replica that dies mid-delivery leaves `locked_at` set, and nothing else would
 * ever release it — the partial index the sweep reads excludes claimed rows by
 * design. Two minutes is well past a delivery (a POST into a guest, with the
 * broker's own 20s readiness cap in front of it) and well under the interval a
 * human would notice a stalled run over.
 *
 * The alternative — a heartbeat on the claim — buys precision this does not need:
 * a redelivery is safe, because the DevKit's journal is what makes a step
 * idempotent, and it is exactly what a crashed replica's messages need.
 */
export const QUEUE_CLAIM_STALE_MS = 120_000;

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
export async function enqueue(sql: SqlExec, params: EnqueueParams): Promise<{ id: string }> {
  const delaySeconds = Math.max(0, params.delaySeconds ?? 0);
  const rows = await sql(
    `insert into aai_platform.workflow_queue
       (id, slug, queue_name, payload, headers, deployment_id, idempotency_key, available_at)
     values ($1, $2, $3, $4::text::jsonb, $5::text::jsonb, $6, $7,
             now() + ($8 || ' seconds')::interval)
     on conflict do nothing
     returning id`,
    [
      params.id,
      params.slug,
      params.queueName,
      JSON.stringify(params.payload ?? null),
      params.headers === undefined ? null : JSON.stringify(params.headers),
      params.deploymentId ?? null,
      params.idempotencyKey ?? null,
      String(delaySeconds),
    ],
  );
  const inserted = rows[0]?.id;
  if (typeof inserted === "string") return { id: inserted };

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
 * Claim up to `limit` due messages, at most ONE PER RUN.
 *
 * Four properties, and each is a way this goes wrong:
 *
 * - **One per run, counting what is already IN FLIGHT.** A run's journal is
 *   replayed on every delivery, so two messages for one run in flight together
 *   interleave two replays of the same log — measured as a bounded fan-out
 *   returning `failed` instead of `completed`. `distinct on` picks one candidate
 *   per run, and the `not exists` is the half that is easy to miss: without it a
 *   run whose earlier message is still being delivered hands out a second one.
 * - **Disjoint under concurrency, WITHOUT `for update`.** Postgres refuses
 *   `FOR UPDATE … DISTINCT` outright (`FOR UPDATE is not allowed with DISTINCT
 *   clause`), so the claim is the UPDATE itself: the trailing unclaimed
 *   predicate is re-evaluated under the row lock the UPDATE takes, so a second
 *   sweep blocked on the first re-checks after it commits, fails the predicate,
 *   and simply does not appear in its own `returning`. Two sweeps therefore take
 *   disjoint sets with no explicit locking at all.
 * - **A stale claim is reclaimable** ({@link QUEUE_CLAIM_STALE_MS}), or a replica
 *   that died mid-delivery holds its messages forever — the due index excludes
 *   claimed rows, so nothing else would ever look at them.
 * - **Scoped by tenant AND run.** Run ids are ULIDs and collision is not the
 *   worry; sharing the key across tenants would be, because one tenant's traffic
 *   would then gate another's.
 */
export async function claimDue(
  sql: SqlExec,
  limit: number,
  staleMs = QUEUE_CLAIM_STALE_MS,
): Promise<QueuedMessage[]> {
  const rows = await sql(
    `with candidates as (
       select distinct on (q.slug, q.payload->>'runId') q.id
       from aai_platform.workflow_queue q
       where q.available_at <= now()
         and (q.locked_at is null or q.locked_at < now() - ($2 || ' milliseconds')::interval)
         and not exists (
           select 1 from aai_platform.workflow_queue o
           where o.slug = q.slug
             and o.payload->>'runId' is not distinct from q.payload->>'runId'
             and o.locked_at is not null
             and o.locked_at >= now() - ($2 || ' milliseconds')::interval
         )
       order by q.slug, q.payload->>'runId', q.available_at
       limit $1
     )
     update aai_platform.workflow_queue q
        set locked_at = now()
      where q.id in (select id from candidates)
        and (q.locked_at is null or q.locked_at < now() - ($2 || ' milliseconds')::interval)
     returning q.id, q.slug, q.queue_name, q.payload, q.headers, q.deployment_id, q.attempt`,
    [limit, String(staleMs)],
  );
  return rows.map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    queueName: String(r.queue_name),
    payload: r.payload,
    attempt: Number(r.attempt),
    ...omitUndefined({
      headers: (r.headers ?? undefined) as Record<string, string> | undefined,
      deploymentId: (r.deployment_id ?? undefined) as string | undefined,
    }),
  }));
}

/** A message that was delivered. Removed, not marked — a delivered row is done. */
export async function ack(sql: SqlExec, id: string): Promise<void> {
  await sql("delete from aai_platform.workflow_queue where id = $1", [id]);
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
  const backoffMs = RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS.at(-1) ?? 60_000;
  await sql(
    `update aai_platform.workflow_queue
        set attempt = $2,
            locked_at = null,
            available_at = now() + ($3 || ' milliseconds')::interval
      where id = $1`,
    [id, next, String(backoffMs)],
  );
  return "retry";
}
