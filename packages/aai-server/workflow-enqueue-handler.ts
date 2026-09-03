// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /:slug/workflow-enqueue` — the guest asking the platform to queue a
 * message for one of its own runs.
 *
 * The other direction of `workflow-queue-deliver.ts`, and the piece that makes
 * the queue platform-owned rather than merely platform-read: the guest no longer
 * holds graphile-worker's `LISTEN` connection or its worker pool against the
 * tenant's own database, so a workflow agent stops costing six app-database
 * connections it cannot share.
 *
 * ## The credential already exists, and finding that out changed the design
 *
 * This is the first guest→platform call that needs authenticating, and the plan
 * called for a new credential. It does not need one. `AAI_GUEST_TOKEN` is
 * `guestTokenFor(agentSandboxName(slug, version))` — an HMAC over the sandbox's
 * fleet-wide name, which every replica can recompute from the agents row (see
 * `guest-token.ts`, whose whole argument is that determinism). The platform hands
 * it to the guest at spawn so the guest can verify requests coming IN; the same
 * value, presented outbound, lets the platform verify a request coming out. One
 * secret, checked by whichever side is receiving.
 *
 * What that buys beyond less plumbing: the token is bound to ONE sandbox name,
 * so it authorizes exactly one slug. A guest that presents its token for another
 * app's slug is refused by construction — the comparison is against the token
 * THIS slug's current deploy would have — rather than by a check somebody has to
 * remember to write.
 *
 * ## Why it is not unauthenticated, when the other guest→platform edge is
 *
 * `_upload-blobs-brokered.ts` reaches the platform with no credential at all,
 * and argues correctly that it adds no reachability: an upload id is 122 bits of
 * entropy and the worst a stranger does is put bytes where they could already
 * put bytes. That argument does NOT transfer. A queue message is delivered into
 * a guest and handed to the flow or step entrypoint, so an unauthenticated
 * enqueue is arbitrary execution of a tenant's registered step functions with a
 * caller-supplied payload — exactly the hole that was open on the sandbox tunnel
 * until it was closed, reopened through a platform route with no tunnel
 * obscurity in front of it.
 *
 * ## A redeploy refuses the old guest, and the retry heals it
 *
 * Verification is against the CURRENT version's token, so a guest superseded
 * mid-run cannot enqueue. That is the same coupling `workflow-handler.ts` already
 * has in the other direction (it mints for the current version, which an old
 * guest would reject), and here it is self-healing rather than merely
 * consistent: the enqueue fails, the step fails, the sweep redelivers the
 * message that triggered it — to the NEW guest, which enqueues successfully. The
 * retry budget absorbs one attempt. Compare what the in-guest queue did with a
 * redeploy, which was to lose the jobs outright.
 */

import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { PLATFORM_ROUTES, queueNameKind } from "@alexkroman1/aai-runtime/internal";
import { HTTPException } from "hono/http-exception";
import { optionalString, requiredString } from "./_body-fields.ts";
import { guestSlug, guestTrace, notConfigured, withReserved } from "./_platform-route.ts";
import type { AppContext } from "./context.ts";
import { createLogger } from "./logger.ts";
import type { AdminDb } from "./platform-lock.ts";
import { enqueue } from "./workflow-queue-store.ts";

const log = createLogger("workflow.enqueue");

/**
 * Cap on an enqueue body.
 *
 * The payload is the DevKit's devalue envelope for one message — a run's input or
 * a step's arguments — base64'd, so 1 MiB of base64 is ~768 KiB of real payload.
 * Far above every real message and far below anything worth buffering on a route
 * that writes to the platform's own database. A run with a large input uses the
 * upload surface, which is what that surface is for.
 */
export const MAX_ENQUEUE_BODY_BYTES = 1_048_576;

/**
 * This route's own path under `/:slug`.
 *
 * NOT `GUEST_ROUTES.workflowQueue`, which is the guest's door for the opposite
 * direction and would read as the same surface. There is no guest counterpart to
 * this one at all — it is the platform answering — so it has no `GUEST_ROUTES`
 * entry and no exposure declaration to make.
 *
 * It does have a CALLER, though, and that is why the string comes from
 * `PLATFORM_ROUTES` rather than being spelled here: `aai-runtime`'s
 * `platform-endpoint.ts` is the guest half of this wire, and a literal on each
 * side is a rename away from a 404 nothing names.
 */
export const WORKFLOW_ENQUEUE_ROUTE = PLATFORM_ROUTES.workflowEnqueue;

/** What the guest sends. Mirrors `QueueOptions` plus the message itself. */
type EnqueueRequest = {
  queueName: string;
  /** The run this message belongs to — what the claim serializes on. */
  runId: string;
  /** The DevKit's opaque message body, base64. */
  data: string;
  deploymentId?: string;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  delaySeconds?: number;
};

/** A string map, or undefined when absent. Throws when present and wrong. */
function optionalHeaders(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  // Shape only. The contents are the DevKit's own `QueueOptions.headers`, echoed
  // back to this guest on delivery and never interpreted here — but a non-string
  // value would reach a header as `"[object Object]"`.
  if (!isRecord(raw) || Object.values(raw).some((v) => typeof v !== "string")) {
    throw new HTTPException(400, { message: "headers must be a string map" });
  }
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
}

/** A required non-empty string, or the 400 that names it. */
/** Parse and validate the body, or throw the 400 that names the field. */
function parseEnqueueRequest(raw: unknown): EnqueueRequest {
  if (!isRecord(raw)) throw new HTTPException(400, { message: "body must be a JSON object" });
  const delaySeconds = raw.delaySeconds;
  if (
    delaySeconds !== undefined &&
    (typeof delaySeconds !== "number" || !Number.isFinite(delaySeconds))
  ) {
    throw new HTTPException(400, { message: "delaySeconds must be a finite number" });
  }
  // `data` may legitimately be the empty string (an empty devalue body), so it is
  // checked for TYPE rather than through `requiredString`.
  if (typeof raw.data !== "string") {
    throw new HTTPException(400, { message: "data must be a base64 string" });
  }
  // The queue name decides how the DELIVERY CLAIM serializes this message —
  // orchestration one-per-run, steps fanned out — so a name it cannot classify is
  // refused here rather than stored. This is the SAME call the store then makes
  // to write `workflow_queue.kind`, which is what the claim compares: a name
  // this refuses would land as a null `kind` and be claimed by nobody, and the
  // catch-all that arrangement replaced turned a renamed DevKit topic into the
  // whole fleet silently serializing again. Refusing here is what makes the
  // claim's two `kind = …` predicates exhaustive over the table.
  const queueName = requiredString(raw, "queueName");
  if (queueNameKind(queueName) === undefined) {
    throw new HTTPException(400, {
      message: `queueName is not a workflow queue name: ${queueName}`,
    });
  }
  return {
    queueName,
    runId: requiredString(raw, "runId"),
    data: raw.data,
    ...omitUndefined({
      deploymentId: optionalString(raw, "deploymentId"),
      idempotencyKey: optionalString(raw, "idempotencyKey"),
      headers: optionalHeaders(raw.headers),
      delaySeconds,
    }),
  };
}

/**
 * Build the enqueue handler.
 *
 * `adminDb` is taken rather than read off the context because the route must not
 * exist as a silent no-op: a composition with no platform database has no queue,
 * and answering 200 to an enqueue that went nowhere would strand the run with a
 * success.
 *
 * @internal
 */
export function createWorkflowEnqueueHandler(
  adminDb: AdminDb | undefined,
): (c: AppContext) => Promise<Response> {
  return async (c) => {
    const slug = await guestSlug(c);
    // 501, not 503: there is no queue on this deployment and there will not be one
    // on a retry. A guest reading this knows to stop rather than back off.
    if (!adminDb) throw notConfigured("platform queue");

    const body = parseEnqueueRequest(await c.req.json().catch(() => undefined));
    const id = `wfq_${crypto.randomUUID().replaceAll("-", "")}`;
    return await withReserved(
      adminDb,
      {
        log,
        failure: "could not queue the message",
        logMessage: "enqueue failed",
        detail: { slug },
        trace: guestTrace(c),
      },
      async (sql) => {
        const result = await enqueue(sql, {
          id,
          slug,
          queueName: body.queueName,
          // The queue's OWN envelope: `runId` is at the TOP level because the
          // claim serializes a run's messages on it — the `run_id` column is
          // `generated always as (payload ->> 'runId')`, so this field is what
          // fills it — and `data` is the DevKit's opaque body. See
          // `QueueEnvelope`.
          payload: { runId: body.runId, data: body.data },
          ...omitUndefined({
            headers: body.headers,
            deploymentId: body.deploymentId,
            idempotencyKey: body.idempotencyKey,
            delaySeconds: body.delaySeconds,
          }),
        });
        // The MESSAGE ID the queue settled on, which is not always the one minted
        // above: an idempotency key collapses onto the row already queued, and the
        // DevKit uses the id it is given here to correlate.
        return c.json({ messageId: result.id }, 200);
      },
    );
  };
}
