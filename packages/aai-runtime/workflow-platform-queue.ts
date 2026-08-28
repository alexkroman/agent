// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest half of the platform-owned queue: `queue()` becomes one HTTP request
 * instead of a `graphile_worker.add_job`.
 *
 * ## What this replaces, and what it costs the tenant today
 *
 * `@workflow/world-postgres` runs graphile-worker INSIDE the guest, against the
 * tenant's own database. That is a `LISTEN` connection held for the life of the
 * process plus a worker pool, and `sdk/app-db-budget.ts` counts the total: six of
 * an app role's connections, none of them shareable, on a cluster whose
 * `max_connections` every other app is drawing from too. It is the ceiling a load
 * test found — not the broker, which was fine at 23k rps.
 *
 * The platform already owns a queue table, a claim, a delivery sweep and a
 * bearer-gated door into each guest. What was missing was this: the guest asking
 * for a message to be queued rather than queueing it itself.
 *
 * ## Only ONE of the Queue's three methods is replaced
 *
 * `Queue` is `getDeploymentId`, `queue`, and `createQueueHandler`. The last is a
 * pure request→handler adapter — `world-postgres` delegates it straight to the
 * LOCAL world, and it touches no database and no worker — so the composition
 * keeps the postgres world's own and overrides `queue` alone. That is also why
 * this module is small enough to be obvious: the interesting behaviour (per-run
 * ordering, backoff, abandonment, `sleep`) all moved to the platform in earlier
 * increments, and what is left here is one POST.
 *
 * ## Failing is CORRECT, and the platform's retry is why
 *
 * A rejection here fails the step that was enqueueing, which fails the delivery
 * that ran it, which the sweep retries with backoff — against a freshly brokered
 * guest. So the failure modes that would be alarming in a queue client are
 * routine: a redeploy invalidates this sandbox's bearer (the retry lands on the
 * new guest and succeeds), a connection shortage answers 503 (the retry waits),
 * a partitioned platform database answers 503 the same way. What must NOT happen
 * is reporting success for a message that was not written, so nothing here is
 * best-effort and nothing is swallowed.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import { PLATFORM_ROUTES, type PlatformEndpoint } from "./platform-endpoint.ts";
import { platformPost } from "./platform-rpc.ts";
import { encodeTypedJson } from "./workflow-typed-json.ts";

/**
 * How long one enqueue may take.
 *
 * A single indexed INSERT on the platform's database, reached over the platform's
 * own network — so this bounds a hung socket rather than real work. Short, because
 * a step is BLOCKED on it: the DevKit awaits `queue()` inside the handler that is
 * dispatching the next message, and a step parked on a dead socket holds a
 * delivery slot on the platform side too.
 */
const ENQUEUE_TIMEOUT_MS = 15_000;

/** What the platform's `POST /:slug/workflow-enqueue` accepts. */
type EnqueueBody = {
  queueName: string;
  runId: string;
  data: string;
  deploymentId?: string | undefined;
  idempotencyKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  delaySeconds?: number | undefined;
};

/**
 * What this client needs to reach the platform.
 *
 * An alias of {@link PlatformEndpoint}: the four platform clients take exactly the
 * same credential pair, which is why one `resolvePlatformQueue()` result is already
 * handed to three of them. The name is kept because it is what the call sites read.
 */
export type PlatformQueueOptions = PlatformEndpoint;

/**
 * The run id a queue payload belongs to.
 *
 * The platform serializes a run's messages against each other on this, so a
 * message with no run id would be ordered against nothing. Every real payload has
 * one: `WorkflowInvokePayloadSchema` carries `runId`, a step payload carries
 * `workflowRunId`, and the DevKit's health-check payload carries a
 * `correlationId` — which is the right key for it, since a health check is its own
 * one-message run.
 *
 * @internal
 */
export function payloadRunId(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  for (const key of ["runId", "workflowRunId", "correlationId"]) {
    const value = message[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/**
 * Post one message to the platform's enqueue route.
 *
 * Returns the message id the platform SETTLED on, which is not always a new one:
 * an idempotency key collapses onto a row already queued, and the DevKit uses the
 * id it is handed back to correlate.
 *
 * The one platform route that answers OUTSIDE the `{result}` envelope, which is
 * why this reads the reply itself rather than going through `platformResult`. A
 * 200 whose body will not parse has to read as "no message id" — the same failure
 * as a 200 that omits it — because a syntax error here would say nothing about
 * what the DevKit is missing.
 *
 * @internal
 */
export async function enqueueToPlatform(
  opts: PlatformQueueOptions,
  body: EnqueueBody,
): Promise<string> {
  // The error carries the platform's own reply: it answers 400 naming the field it
  // rejected, and 501 when the deployment has no queue at all. Without it the only
  // record is a status code on a step that failed for no stated reason.
  const text = await platformPost(opts, {
    route: PLATFORM_ROUTES.workflowEnqueue,
    label: "enqueue",
    timeoutMs: ENQUEUE_TIMEOUT_MS,
    body: JSON.stringify(body),
  });
  const messageId = messageIdOf(text);
  if (messageId === undefined) {
    // A 200 with no id is a platform that changed its contract. Throwing means the
    // step retries and the run survives; returning a made-up id would let the
    // DevKit correlate against something that does not exist.
    throw new Error("enqueue answered 200 without a messageId");
  }
  return messageId;
}

/** The `messageId` out of an enqueue reply, or `undefined` for any body without one. */
function messageIdOf(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const messageId = parsed.messageId;
  return typeof messageId === "string" && messageId !== "" ? messageId : undefined;
}

/**
 * Build the one `Queue` method that changes.
 *
 * Typed against its own narrow signature rather than the DevKit's `Queue`, which
 * this package does not import: `@workflow/world` is a transitive dependency it
 * does not declare, and the composition site supplies the real type by spreading
 * this over a world that already has one.
 *
 * @internal
 */
export function createPlatformQueueSend(opts: PlatformQueueOptions): (
  queueName: string,
  message: unknown,
  queueOpts?: {
    deploymentId?: string | undefined;
    idempotencyKey?: string | undefined;
    headers?: Record<string, string> | undefined;
    delaySeconds?: number | undefined;
  },
) => Promise<{ messageId: string | null }> {
  return async (queueName, message, queueOpts = {}) => {
    const runId = payloadRunId(message);
    if (runId === undefined) {
      // Loud, and it fails the step rather than inventing a key. A payload with no
      // run id cannot be ordered against that run's other messages, which is the
      // one guarantee the platform's claim provides.
      throw new Error(`queue payload for ${queueName} carries no run id`);
    }
    const messageId = await enqueueToPlatform(opts, {
      queueName,
      runId,
      // devalue's output is binary, and the platform's payload column is jsonb
      // because its claim reads `runId` out of it — so the bytes ride as base64.
      // The inner encoding is the DevKit's own tagged-envelope JSON, which is what
      // their `createQueueHandler` reads back (`workflow-typed-json.ts`).
      data: Buffer.from(encodeTypedJson(message)).toString("base64"),
      ...queueOpts,
    });
    return { messageId };
  };
}
