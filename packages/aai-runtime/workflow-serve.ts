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
 * predicate. The predicate stays exported because the reasoning behind it
 * outlived them: a caller's network POSITION is a fact this process can
 * establish where a header is not, and tunnel traffic arrives from outside the
 * sandbox's network namespace so it is never a loopback peer. The guest's manage
 * surface reads it to tell a loopback dial from a tunnel one.
 *
 * @internal
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { consoleLogger, type Logger } from "./runtime-config.ts";
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
 * handler because `aai-server` imports them to register its proxy, and that
 * module reaches the runtime's `Logger` and a `WorkflowClient` — a dependency the
 * platform's route table has no business acquiring in order to learn a path.
 *
 * @internal
 */
export const WORKFLOW_WEBHOOK_PATH = "/.well-known/workflow/v1/webhook";
/** @internal */
export const WORKFLOW_WEBHOOK_PREFIX = `${WORKFLOW_WEBHOOK_PATH}/` as const;

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
 * handler is fetch-style while `createServer` is `node:http`. It is small and it
 * is temporary — once the session server is on Hono (`c.req.raw` is already a
 * `Request`) this mounts directly and the function goes away.
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
     * Re-walk one run. `AgentRuntime.deliverWorkflow`.
     *
     * Absent means this deployment has no engine to deliver to — an agent that
     * declares no workflows — and the door then DECLINES, so the request falls
     * through to the rest of the server rather than answering for a feature the
     * agent does not have.
     */
    deliver?: ((runId: string) => Promise<unknown>) | undefined;
  } = {},
): boolean {
  if (method !== "POST" || url !== WORKFLOW_QUEUE_PATH) return false;
  const deliver = opts.deliver;
  // Nothing to deliver to. DECLINED rather than answered: this is
  // indistinguishable from an agent that declares no workflows, and claiming the
  // request would shadow whatever else the host serves on that path.
  if (!deliver) return false;

  // HOST-ONLY: a caller the composition does not vouch for is refused even on
  // loopback. Fails closed when no predicate was supplied, which is every
  // composition that has no platform.
  if (!opts.allowRemote?.(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return true;
  }

  void serveFetch((request: Request) => deliverQueueMessage(deliver, request), req, res, {
    logger: opts.logger ?? consoleLogger,
    label: "Workflow delivery",
    // The platform RETRIES a 5xx, which is how a guest that was up and could not
    // finish gets another attempt. An unroutable message is a 400 decided inside
    // the handler and never reaches here — see `deliverQueueMessage`.
    failureStatus: 500,
  });
  return true;
}
