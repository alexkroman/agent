// Copyright 2026 the AAI authors. MIT license.
/**
 * Every `/:slug/*` route the durable-workflow feature needs, registered once.
 *
 * Four of them, and they arrived one at a time in `orchestrator.ts` until the
 * fourth pushed that file to two lines under its cap. The seam is worth having on
 * its own terms: these four are the only routes on the agent surface whose
 * correctness is a claim about the DevKit's contract rather than about this
 * platform's, and three of them derive their METHOD LIST from
 * `GUEST_ROUTE_EXPOSURE` instead of restating it — which is the one thing a reader
 * has to notice, and hard to notice spread across sixty lines of unrelated
 * registrations.
 *
 * They also disagree about direction in a way worth seeing together:
 *
 * | Route | Caller | Authorization |
 * | --- | --- | --- |
 * | `…/webhook/:token` | a third party | the DevKit's path token |
 * | `/workflows/*` | a page, or a script | the agent's own `AAI_WORKFLOW_API_TOKEN`, forwarded |
 * | `/workflow-enqueue` | **this agent's guest** | the per-sandbox bearer, bound to one slug |
 * | `…/uploads/:id/:offset` | a browser, or the guest | an unguessable upload id |
 *
 * Only the third is a guest→platform call that needs a credential, and the
 * asymmetry is the point: the other three are open by design and each carries its
 * own argument for why that adds no reachability. See
 * `workflow-enqueue-handler.ts` for why the same argument does not extend to an
 * enqueue.
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
  createWorkflowStorageHandler,
  MAX_STORAGE_BODY_BYTES,
  WORKFLOW_STORAGE_ROUTE,
} from "./workflow-storage-handler.ts";
import type { PlatformWorldStorage } from "./workflow-storage-world.ts";
import { createWorkflowStreamHandler, WORKFLOW_STREAM_ROUTE } from "./workflow-stream-handler.ts";
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
  /**
   * The DevKit's world on the platform's database. Absent means this deployment
   * serves no run storage, which the route answers 501 for.
   */
  runStorage?: PlatformWorldStorage | undefined;
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
 * Register all four on the `/:slug` router.
 *
 * @internal
 */
export function registerAgentWorkflowRoutes(
  agents: Hono<HonoEnv>,
  opts: AgentWorkflowRouteOptions,
): void {
  // Durable-run webhook delivery. No auth of ours — the DevKit's path token is
  // the only authorization on this endpoint, at the guest and here.
  //
  // The methods come STRAIGHT off the exposure declaration rather than being
  // restated: the guest answers any verb the third party chose, and a platform
  // route serving a subset of them is the exact bug guest-routes.ts exists to
  // catch (a `DELETE` that worked in dev and 404'd deployed).
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

  // The guest's run-storage calls, scoped to this agent and forwarded to the
  // DevKit's world running on the platform's own database. Same bearer as the
  // enqueue route beside it, and the same reason it is neither `existingOwnerMw`
  // nor open: the caller is this agent's guest, and what it reaches is run state.
  agents.post(
    WORKFLOW_STORAGE_ROUTE,
    limit(MAX_STORAGE_BODY_BYTES),
    createWorkflowStorageHandler({
      ...omitUndefined({ adminDb: opts.adminDb }),
      ...omitUndefined({ storage: opts.runStorage }),
    }),
  );

  // The seventh Streamer member: a LIVE read, which is a streaming response rather
  // than one request and one reply, so it cannot share the RPC route above. Its
  // tenant boundary is the qualified stream NAME rather than a run check — that
  // method has no run id — see `workflow-stream-handler.ts`.
  agents.get(
    WORKFLOW_STREAM_ROUTE,
    createWorkflowStreamHandler(omitUndefined({ storage: opts.runStorage })),
  );

  // The guest's session slots and event log — turn-level durability with no tenant
  // database. Same bearer as the routes above, and its scoping is simpler than run
  // storage's because this schema is the platform's own: the slug is part of every
  // statement rather than something a per-method table has to decide.
  agents.post(
    SESSION_STATE_ROUTE,
    limit(MAX_SESSION_STATE_BODY_BYTES),
    createSessionStateHandler(omitUndefined({ adminDb: opts.adminDb })),
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
    createUploadBytesHandler(opts.uploadBytes),
  );
}
