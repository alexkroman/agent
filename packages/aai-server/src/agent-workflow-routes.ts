// Copyright 2026 the AAI authors. MIT license.
/**
 * Every `/:slug/*` route the durable-workflow feature needs, registered once.
 *
 * They arrived one at a time in `orchestrator.ts` until one pushed that file to two
 * lines under its cap. The seam is worth having on its own terms: these are the only
 * routes on the agent surface whose correctness is a claim about the DevKit's
 * contract rather than about this platform's, and the ones that answer several verbs
 * derive their METHOD LIST from `GUEST_ROUTE_EXPOSURE` instead of restating it —
 * which is the one thing a reader has to notice, and hard to notice spread across
 * sixty lines of unrelated registrations.
 *
 * They also disagree about direction and about authorization in a way worth seeing
 * together. The count is deliberately not stated: it has been wrong twice, and the
 * registrations below are the inventory.
 *
 * | Route | Caller | Authorization |
 * | --- | --- | --- |
 * | `…/webhook/:token` | a third party | the path token, on POST alone |
 * | `/workflows/*` | a page, or a script | the agent's own `AAI_WORKFLOW_API_TOKEN`, forwarded |
 * | `…/uploads/:id/:offset` | a browser, or the guest | an unguessable upload id |
 * | `/workflow-enqueue` | **this agent's guest** | the per-sandbox bearer, bound to one slug |
 * | `/session-state` | **this agent's guest** | the same, and every statement is slug-scoped |
 * | `/workflow-journal` | **this agent's guest** | the same, and every statement is slug-scoped |
 * | `/workflow-keys` | **this agent's guest** | the same, and every statement is slug-scoped |
 * | `/upload-records` | **this agent's guest** | the same |
 *
 * The split in that table is the point: the first three are open by design and each
 * carries its own argument for why that adds no reachability, while every
 * guest→platform call needs the per-sandbox bearer. See
 * `workflow-enqueue-handler.ts` for why the open-by-design argument does not extend
 * to an enqueue, and `guest-bearer.ts` for the one check the bottom five share.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HonoEnv } from "./context.ts";
import { GUEST_ROUTE_EXPOSURE, GUEST_ROUTES } from "./guest-routes.ts";
import type { AdminDb } from "./platform-lock.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { ResolveSandboxOpts } from "./sandbox-resolve.ts";
import {
  createSessionStateHandler,
  MAX_SESSION_STATE_BODY_BYTES,
  SESSION_STATE_ROUTE,
} from "./session-state-handler.ts";
import type { UploadBytes } from "./upload-bytes.ts";
import {
  createUploadBytesHandler,
  UPLOAD_BYTES_METHODS,
  UPLOAD_BYTES_ROUTE,
} from "./upload-handler.ts";
import {
  createUploadsHandler,
  MAX_UPLOAD_RECORD_BODY_BYTES,
  UPLOAD_RECORDS_ROUTE,
} from "./uploads-handler.ts";
import {
  createWorkflowEnqueueHandler,
  MAX_ENQUEUE_BODY_BYTES,
  WORKFLOW_ENQUEUE_ROUTE,
} from "./workflow-enqueue-handler.ts";
import { createAgentWorkflowsHandler, createWorkflowRateLimitMw } from "./workflow-handler.ts";
import {
  createWorkflowJournalHandler,
  MAX_WORKFLOW_JOURNAL_BODY_BYTES,
  WORKFLOW_JOURNAL_ROUTE,
} from "./workflow-journal-handler.ts";
import {
  createWorkflowKeysHandler,
  MAX_WORKFLOW_KEYS_BODY_BYTES,
  WORKFLOW_KEYS_ROUTE,
} from "./workflow-keys-handler.ts";
import {
  createWorkflowWebhookHandler,
  MAX_WEBHOOK_BODY_BYTES,
  WORKFLOW_WEBHOOK_ROUTE,
} from "./workflow-webhook-handler.ts";

export type AgentWorkflowRouteOptions = {
  /** The broker's dependency set, already assembled by the caller. */
  broker: ResolveSandboxOpts;
  /** Injectable guest `fetch`, so a spec can assert what crossed. */
  guestFetch?: typeof fetch | undefined;
  /** The platform's admin connection. Absent means there is no queue. */
  adminDb?: AdminDb | undefined;
  /** Where an upload's bytes go — the platform's bucket, never a guest's disk. */
  uploadBytes: UploadBytes;
  workflowRateLimiter?: RateLimiter | undefined;
  workflowStartRateLimiter?: RateLimiter | undefined;
};

/** A 413 with a body, rather than Hono's default empty response. */
function limit(maxSize: number) {
  return bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  });
}

/**
 * Register them all on the `/:slug` router.
 *
 * @internal
 */
export function registerAgentWorkflowRoutes(
  agents: Hono<HonoEnv>,
  opts: AgentWorkflowRouteOptions,
): void {
  // Durable-run webhook delivery. No auth of ours — the path token is the only
  // authorization on this endpoint, at the guest and here.
  //
  // The methods come STRAIGHT off the exposure declaration rather than being
  // restated, and that declaration is POST alone. It used to be all five, on
  // "the guest answers any verb the third party chose" — which was true and was
  // the bug: a delivery is permanent, so a crawler's `GET` on a leaked callback
  // URL resolved a run's waitpoint with `{}`. The guest gates POST now, and
  // narrowing here matters more than usual because this handler BROKERS — a
  // forwarded `GET` boots a Modal sandbox before the guest can refuse it. The
  // subset-of-the-guest's-verbs bug guest-routes.ts exists to catch (a `DELETE`
  // that worked in dev and 404'd deployed) is guarded from the other side:
  // guest-routes.test.ts pins this list against the runtime's route table.
  const handleWorkflowWebhook = createWorkflowWebhookHandler(opts.guestFetch);
  agents.on(
    [...GUEST_ROUTE_EXPOSURE.workflowWebhook.methods],
    WORKFLOW_WEBHOOK_ROUTE,
    limit(MAX_WEBHOOK_BODY_BYTES),
    (c) => handleWorkflowWebhook(c, opts.broker),
  );

  // The reverse of every other route here: the GUEST asking the platform to
  // queue a message for one of its own runs. Authenticated by the bearer the
  // platform already gave that sandbox, which binds it to one slug — so it is
  // not `existingOwnerMw` (the caller is a guest, not the author) and it is not
  // open (a queue message executes a tenant's step code).
  agents.post(
    WORKFLOW_ENQUEUE_ROUTE,
    limit(MAX_ENQUEUE_BODY_BYTES),
    createWorkflowEnqueueHandler(opts.adminDb),
  );

  // Two routes used to sit here: the guest's run-storage RPC and the live stream
  // read beside it, both forwarding to the DevKit's world on the platform's own
  // database. They went with that world — the replay engine's journal is
  // `/workflow-journal` below, and its progress streams are the guest's own.

  // The guest's session slots and event log — turn-level durability with no tenant
  // database. Same bearer as the routes above, and its scoping is simpler than run
  // storage's because this schema is the platform's own: the slug is part of every
  // statement rather than something a per-method table has to decide.
  agents.post(
    SESSION_STATE_ROUTE,
    limit(MAX_SESSION_STATE_BODY_BYTES),
    createSessionStateHandler(omitUndefined({ adminDb: opts.adminDb })),
  );

  // The replay engine's JOURNAL — what makes a deployed durable run durable at
  // all. The engine's other two backends are a `Map` and a store over the agent's
  // own `DATABASE_URL`, and the platform provisions neither, so before this route
  // every deployed run journaled into a sandbox that self-exits. Same bearer and
  // the same slug-in-every-statement scoping as session state.
  agents.post(
    WORKFLOW_JOURNAL_ROUTE,
    limit(MAX_WORKFLOW_JOURNAL_BODY_BYTES),
    createWorkflowJournalHandler(omitUndefined({ adminDb: opts.adminDb })),
  );

  // The correlation-key INDEX — `(workflow, key) -> runId`, which is how a
  // caller's next call finds the run their last one started. Same bearer and the
  // same slug-in-every-statement scoping as the journal above, and it closes the
  // same gap one table over: the index's other two backends are a `Map` and the
  // agent's own `DATABASE_URL`, so before this route a deployed agent kept the
  // only pointer to its durable runs in a sandbox that self-exits. The run
  // survived and the pointer did not, which reads as a caller who never called.
  agents.post(
    WORKFLOW_KEYS_ROUTE,
    limit(MAX_WORKFLOW_KEYS_BODY_BYTES),
    createWorkflowKeysHandler(omitUndefined({ adminDb: opts.adminDb })),
  );

  // The guest's workflow UPLOAD records — the last piece of a guest's durable state
  // that lived on local disk. Its bytes do not come through here: those go to the
  // bucket through the upload broker. Same bearer and the same slug-in-every-
  // statement scoping as session state; `platform-uploads.ts` has why it moved and
  // what keeping it on disk cost.
  agents.post(
    UPLOAD_RECORDS_ROUTE,
    limit(MAX_UPLOAD_RECORD_BODY_BYTES),
    createUploadsHandler(omitUndefined({ adminDb: opts.adminDb })),
  );

  // The durable-workflow API, brokered to the guest. Registered even though a
  // programmatic caller could reach the guest directly, because a WORKFLOW APP's
  // page cannot: this platform serves it at `GET /:slug/`, so its
  // `createWorkflowApi()` builds every URL under `/:slug/` and lands here. No
  // auth by default; the guest's own `AAI_WORKFLOW_API_TOKEN` gate is what closes
  // it, and the bearer is forwarded. See workflow-handler.ts.
  const handleWorkflows = createAgentWorkflowsHandler(opts.guestFetch);
  agents.on(
    // The methods come STRAIGHT off the exposure declaration, for the same
    // reason the webhook route above does it: the guest answers GET, POST and
    // DELETE, and a platform serving a subset is the exact bug guest-routes.ts
    // exists to catch — `api.cancel(runId)` is a DELETE.
    [...GUEST_ROUTE_EXPOSURE.workflows.methods],
    // The guest's own constant, so the two sides of the proxy cannot name
    // different paths.
    [GUEST_ROUTES.workflows, `${GUEST_ROUTES.workflows}/:path{.+}`],
    createWorkflowRateLimitMw({
      surface: opts.workflowRateLimiter,
      start: opts.workflowStartRateLimiter,
    }),
    (c) => handleWorkflows(c, opts.broker),
  );

  // One window of a workflow upload's bytes. NOT brokered and not a guest route:
  // the guest holds no bucket credential, so both the browser's parts and the
  // guest's own reads come here. `upload-handler.ts` carries the argument, the key
  // derivation and why reads redirect while writes do not.
  agents.on(
    [...UPLOAD_BYTES_METHODS],
    UPLOAD_BYTES_ROUTE,
    // The admin connection, because a WRITE asks the upload's own record one
    // question: is this upload already finished, in which case its windows are
    // immutable. See `assertUploadOpen` there for why that read is worth a round
    // trip and why "the object exists" is the wrong condition.
    createUploadBytesHandler(opts.uploadBytes, omitUndefined({ adminDb: opts.adminDb })),
  );
}
