// Copyright 2026 the AAI authors. MIT license.
/**
 * The PLATFORM's delivery door: `POST /workflow-queue`.
 *
 * One route now, where there were three. `flow` and `step` were the Workflow
 * DevKit's own queue callbacks and went with it — the replay engine executes a
 * step INLINE during the walk rather than as its own message, so there is nothing
 * left for a per-step callback to do. The webhook route moved to `createServer`
 * (`workflow-webhook.ts`), which is the only place it could actually be reached.
 *
 * What remains is the door a deployed guest needs and no other deployment has: a
 * deployed guest's own timers die with a sandbox that self-exits, so the
 * platform's queue holds each run's schedule and a due message arrives here to
 * re-walk it. `workflow-queue-dispatch.ts` is the handler.
 *
 * ## The gate on this door is a CREDENTIAL, and it always was
 *
 * `allowRemote` is the platform's own bearer, injected because the credential is
 * the platform's and this package is also what a self-hoster runs. It fails
 * CLOSED: absent, the door is refused, which is right for `aai dev`, host mode
 * and a self-hosted server — none of them has a queue outside the process.
 *
 * ## Why `isLoopbackAddress` survives the routes it guarded
 *
 * It gated `flow` and `step`, which were unauthenticated BECAUSE loopback was
 * meant to be the whole gate — and for a while nothing checked, which is worth
 * keeping written down because it is the failure mode of a security property held
 * as a comment. A deployed agent guest binds `0.0.0.0` (Modal publishes the port
 * as a public HTTPS tunnel) and the public `GET /:slug/client-config` hands that
 * origin to every browser that asks, so
 * `POST <tunnel>/.well-known/workflow/v1/step` executed one of that tenant's
 * registered step functions, with the caller's arguments, for anyone on the
 * internet.
 *
 * Both routes are gone, so that hole is closed by CONSTRUCTION rather than by a
 * predicate. {@link isLoopbackAddress} survives them, and has NO reader today —
 * its own spec is the only caller. It is kept because the reasoning outlived the
 * routes: a caller's network POSITION is a fact this process can establish where
 * a header is not, and tunnel traffic arrives from outside the sandbox's network
 * namespace so it is never a loopback peer. The next door that has to tell a
 * loopback dial from a tunnel one should take this rather than write a fourth
 * spelling of the IPv4-mapped case. If none arrives, delete it and its spec.
 *
 * @internal
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PUBLIC_URL_UNCONFIGURED_MESSAGE,
  publishStepWebhookUrl,
} from "@alexkroman1/aai/host-internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import { consoleLogger, type Logger } from "./runtime-config.ts";
import { sendJson } from "./workflow-api-http.ts";
import { serveFetch } from "./workflow-http-adapter.ts";
import { deliverQueueMessage, WORKFLOW_QUEUE_PATH } from "./workflow-queue-dispatch.ts";

/**
 * The webhook ROUTE, and the prefix `webhookToken` slices a token off after it.
 *
 * Two names because the platform must register the slash-less path plus a token
 * segment while the parser needs the trailing slash — derived from one another so
 * the two cannot drift, which they did while `aai-server` spelled the slash-less
 * form as its own literal. See `server-routes.ts`.
 *
 * They stay in this module rather than moving to `workflow-webhook.ts` with the
 * handler because that module reaches the runtime's `Logger` and a
 * `WorkflowClient` — a dependency `server-routes.ts` has no business acquiring in
 * order to learn a path, and it is what `aai-server` reads the route table from.
 * The three readers are all in this package: `server-routes.ts`,
 * `workflow-webhook.ts` and `workflow-client.ts`.
 *
 * @internal
 */
export const WORKFLOW_WEBHOOK_PATH = "/.well-known/workflow/v1/webhook";
/** @internal */
export const WORKFLOW_WEBHOOK_PREFIX = `${WORKFLOW_WEBHOOK_PATH}/` as const;

/**
 * The URL a third party POSTs to in order to resolve one waitpoint — an origin
 * plus {@link WORKFLOW_WEBHOOK_PREFIX} plus the token, as ONE segment.
 *
 * Here rather than at its callers because the composition has three parts that
 * are each wrong in a way nothing can see. The PREFIX has to be the constant
 * this router parses, or the URL handed out and the path answering it drift —
 * and a run waiting on a hook that never arrives reports as healthily
 * suspended, so the 404 lands weeks later on somebody else's server. The token
 * has to be ENCODED, because the parser refuses a path carrying a second slash.
 * And the base has to be de-slashed: it arrives from a boot env var, a
 * container's `PUBLIC_URL` or an author's own string, and a copied-in origin
 * ending in `/` is the ordinary shape of all three.
 *
 * A blank base THROWS the same message `ctx.workflows.publicWebhookUrl` throws,
 * rather than composing a relative `/.well-known/…` that nothing can call back
 * on. `workflow-client.ts` still spells this composition inline and should be
 * folded onto this function — one behaviour, one copy.
 *
 * @internal
 */
export function workflowWebhookUrl(publicUrl: string, token: string): string {
  const base = publicUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error(PUBLIC_URL_UNCONFIGURED_MESSAGE);
  return `${base}${WORKFLOW_WEBHOOK_PREFIX}${encodeURIComponent(token)}`;
}

/**
 * Publish how this process mints a run's public webhook URL, for the STEP slot
 * (`stepWebhookUrl` on `@alexkroman1/aai/step`).
 *
 * The gap it closes: `ctx.workflows.publicWebhookUrl` needs a `ToolContext`, and
 * a workflow BODY and the steps it calls are handed none — so a `workflowApp()`
 * with no tools could not mint a callback at all and had to poll. A step's
 * env cannot supply the value either: the public URL is a boot parameter of the
 * DEPLOYMENT rather than one of the agent's own secrets. See
 * `sdk/step-webhook.ts` in `@alexkroman1/aai` for the slot and the rest of the
 * argument.
 *
 * What is published is a MINTER rather than the origin, so the route stays in
 * the package that answers it and the SDK never spells this path.
 *
 * A blank or absent `publicUrl` UNPUBLISHES: the deployment cannot mint one, and
 * the step helper's own throw then names the configuration — where a published
 * minter over an empty base would hand out a relative URL and fail at the far
 * end. Publishing again REPLACES, which is what a redeploy or a repeat bundle
 * load means.
 *
 * @internal
 */
export function publishWorkflowWebhookUrl(publicUrl: string | undefined): void {
  const base = publicUrl?.trim();
  publishStepWebhookUrl(base ? (token) => workflowWebhookUrl(base, token) : undefined);
}

/**
 * The delivery door's body cap.
 *
 * This door had NO cap, which is not the same severity as the unauthenticated
 * webhook beside it — `allowRemote` has to vouch for the caller first — but
 * "authenticated" is not "trusted with unbounded memory". The credential is a
 * per-sandbox manage bearer, and the process it spends is a guest also serving
 * live voice sessions, so an unbounded read makes one leaked or misbehaving
 * caller the author of this container's heap usage.
 *
 * ## Why this number
 *
 * The delivery body is the queue envelope's payload, and the platform's own
 * enqueue route is what decides how large one can ever be:
 * `MAX_ENQUEUE_BODY_BYTES` in `aai-server/workflow-enqueue-handler.ts` refuses a
 * larger message before it is stored, so nothing above this can be enqueued and
 * therefore nothing above it can be delivered. The cap is the same number,
 * RESTATED rather than imported — `aai-runtime` may not depend on `aai-server`,
 * and this package is also what a self-hoster runs, where there is no platform
 * enqueue route at all. A delivery that starts being refused here is the signal
 * that the two have drifted.
 *
 * `deliverQueueMessage` in fact reads nothing but the `x-vqs-queue-name` header
 * — the run id comes from the name and from nothing else — so today a cap of
 * almost zero would serve. That is deliberately not the number: it would bind
 * this constant to one implementation detail of the handler rather than to the
 * contract, and the first reader of the payload would silently start refusing
 * every real message.
 *
 * ## Not `MAX_WEBHOOK_BODY_BYTES`, though it is the same size today
 *
 * That one bounds a THIRD PARTY's notification on the public, credential-free
 * webhook route, and its number is a product statement ("a payload is a
 * notification, never a file"). Borrowing it would couple the two: a decision to
 * tighten the public surface would silently start refusing legitimate queue
 * deliveries, on an unrelated door, with the failure appearing as stalled runs.
 *
 * @internal
 */
export const MAX_QUEUE_DELIVERY_BODY_BYTES = 1_048_576;

/**
 * Is `address` a loopback peer — i.e. did this request originate INSIDE this
 * container?
 *
 * `undefined` is false, and that direction is deliberate: a socket with no peer
 * address is a socket whose position cannot be established, and the one thing
 * this predicate must never do is answer "internal" because it could not tell.
 *
 * Three spellings, all of which a real server produces: `127.0.0.0/8` (the
 * whole block, not just `127.0.0.1` — `localhost` resolves elsewhere in it on
 * some hosts), `::1`, and the IPv4-MAPPED form a dual-stack listener reports
 * for an IPv4 loopback dial. Missing the third would refuse an in-container
 * caller on any host that binds `::`.
 *
 * @internal
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const bare = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  if (bare === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/**
 * Serve the platform's delivery door, in the shape `createServer`'s `request`
 * hook wants: `true` when this handler claimed the request.
 *
 * A node↔fetch adapter sits behind it (`workflow-http-adapter.ts`) because the
 * handler is fetch-style while `createServer` is `node:http`; that module's own
 * doc says why it is temporary.
 *
 * @internal
 */
export function handleWorkflowRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
  opts: {
    /**
     * May this off-box caller reach the delivery door?
     *
     * Injected because the credential is the platform's and this package is also
     * what a self-hoster runs. Absent means the door is REFUSED — which is right
     * for `aai dev`, host mode and a self-hosted server, none of which have a
     * queue outside the process.
     */
    allowRemote?: ((req: IncomingMessage) => boolean) | undefined;
    /**
     * Where a failed delivery is reported.
     *
     * Optional with a console fallback because that is the behaviour it
     * replaced, and every caller here is a composition root that already has a
     * logger — a required field would be a breaking change to three doors for a
     * line that only prints on a fault.
     */
    logger?: Logger | undefined;
    /**
     * Resolves `AgentRuntime.deliverWorkflow` — re-walk one run.
     *
     * A THUNK, and that is load-bearing rather than a style. The guest supplies
     * it as a getter over `ensureRuntime`, so READING it builds the runtime; as a
     * plain value it was evaluated as an argument to this function, on every
     * request that reached the hook. Two consequences, both real: an
     * unauthenticated `GET /` on the public sandbox tunnel forced runtime
     * construction, and `ensureRuntime` THROWS for a bundle that has not loaded
     * or a missing provider credential — into `createServer`'s request hook,
     * which is called with no `try`, so it surfaced as an `uncaughtException` and
     * the guest's guard exited the process, taking every live voice session with
     * it.
     *
     * So it is resolved LAST: after the path, after the method, and after the
     * bearer. `createWorkflowApi`'s `engine` getter has had this shape all along.
     *
     * Resolving to `undefined` means this deployment has no engine — an agent
     * that declares no workflows — and the door then DECLINES, so the request
     * falls through rather than answering for a feature the agent lacks.
     */
    deliver?: (() => ((runId: string) => Promise<unknown>) | undefined) | undefined;
  } = {},
): boolean {
  if (method !== "POST" || url !== WORKFLOW_QUEUE_PATH) return false;

  // HOST-ONLY, and checked BEFORE the engine is resolved: resolving builds the
  // runtime in a guest, which is work an unauthenticated caller must not be able
  // to trigger. Fails closed when no predicate was supplied, which is every
  // composition that has no platform.
  if (!opts.allowRemote?.(req)) {
    sendJson(res, 401, { error: "unauthorized" });
    return true;
  }

  // A resolver that THREW could not build the runtime — a misconfigured agent
  // rather than one without workflows — so it answers 500 with the reason. The
  // catch is the point: this runs inside `createServer`'s request hook, which is
  // called with no `try`, so an escaping throw is an `uncaughtException` and the
  // guest's guard exits the process mid-call.
  // Resolved once, above the try: three readers now — the resolver's own
  // failure, `serveFetch`, and the delivery door's PARK report.
  const logger = opts.logger ?? consoleLogger;
  let deliver: ((runId: string) => Promise<unknown>) | undefined;
  try {
    deliver = opts.deliver?.();
  } catch (err: unknown) {
    logger.error("Workflow delivery unavailable", { error: errorMessage(err) });
    sendJson(res, 500, { error: `Workflow delivery unavailable: ${errorMessage(err)}` });
    return true;
  }
  // Nothing to deliver to. DECLINED rather than answered: this is
  // indistinguishable from an agent that declares no workflows, and claiming the
  // request would shadow whatever else the host serves on that path.
  if (!deliver) return false;

  const run = deliver;
  void serveFetch((request: Request) => deliverQueueMessage(run, request, { logger }), req, res, {
    logger,
    label: "Workflow delivery",
    // The platform RETRIES a 5xx, which is how a guest that was up and could not
    // finish gets another attempt. An unroutable message is a 400 decided inside
    // the handler and never reaches here — see `deliverQueueMessage`.
    failureStatus: 500,
    // Bounded AS IT IS READ. `readBody` counts per chunk and drops the overflow,
    // so `serveFetch` answers 413 before `deliverQueueMessage` sees a `Request`
    // at all — which is the property that makes this a cap rather than a
    // measurement taken after the damage. Applied here and not in the adapter
    // because the limit is this door's contract, not the shim's.
    //
    // **A 413 is TERMINAL, and the platform does not yet know that.** The
    // sender is `workflow-queue-deliver.ts`, whose caller
    // (`workflow-queue-sweep.ts`) throws on any non-2xx and lets the sweep back
    // off — so an oversized message is re-sent until the attempt budget runs
    // out, exactly as `deliverQueueMessage`'s 400 already is, despite its doc
    // saying a 400 means "do not retry this, it can never route". Classifying a
    // 4xx as abandon-now belongs on that side and is owed there. What this
    // change does buy in the meantime is that the retries are cheap: the body is
    // discarded as it arrives instead of being buffered whole, so a resend costs
    // bandwidth rather than another copy of the payload in a guest's heap.
    maxBodyBytes: MAX_QUEUE_DELIVERY_BODY_BYTES,
  });
  return true;
}
