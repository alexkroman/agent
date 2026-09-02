// Copyright 2026 the AAI authors. MIT license.
/**
 * `/:slug/.well-known/workflow/v1/webhook/:token` — webhook delivery to a
 * parked durable run.
 *
 * The DevKit's `createWebhook()` hands a URL OUT of the system: to a payment
 * provider, to an approval mail, to whatever the run is waiting on. That URL
 * has to keep working for as long as the run does, which is the one thing a
 * sandbox tunnel cannot promise — a Modal tunnel changes on every respawn, and
 * an agent guest self-exits after `AGENT_IDLE_EXIT_MS` with no sessions. A
 * durable run is by definition the thing that outlives the call that started
 * it, so by the time the delivery arrives the usual state is NO SANDBOX AT ALL.
 *
 * So this route brokers one, exactly as `GET /:slug/client-config` does: the
 * run's state lives in the app's own database (the Postgres world — see
 * `aai/host/workflow-world.ts`), not in the guest's memory, so a freshly booted
 * guest resumes a hook parked days ago. The platform stays out of the workflow
 * itself; it forwards one request and returns one response.
 *
 * ## Why a proxy and not a redirect
 *
 * A 302 to the sandbox tunnel would be cheaper and is not available: the sender
 * is a third-party system with its own redirect policy (many do not follow one
 * on a POST, and those that do drop the body), and the tunnel URL is a moving
 * target the sender may cache. The platform URL is the stable one, which is the
 * whole reason it exists.
 *
 * ## Auth posture: the token, and nothing else
 *
 * Same as the guest's own endpoint, and the DevKit is explicit that the token
 * in the URL is the only authorization performed. That matches `/client-config`
 * and `/:slug/phone` beside it — public routes that boot a sandbox — so this
 * adds no reachability an unauthenticated caller did not already have. A
 * workflow that needs more should use `createHook()` behind its own route.
 *
 * **What crosses into the guest is the SENDER's message, minus this hop's
 * credentials.** The request is passed through rather than allow-listed,
 * because the run receives it whole and a signature header is what a payment
 * provider's own verification needs — but `Cookie`, `Authorization` and
 * `X-Forwarded-*` describe the caller to US and stop here. See
 * `guest-forward.ts`.
 *
 * ## What this route does NOT fix
 *
 * The URL the DevKit MINTS still names the guest's own origin
 * (`http://localhost:<port>/…`, from `getWorkflowMetadata().url`) — it derives
 * that from the process it is running in, and the only override it honours is
 * Vercel's, which brings a `process.exit(1)` replay guard with it that a voice
 * guest must not have. So an author composes the durable URL from the hook's
 * `token` and their agent's public origin; this is the route that answers it.
 */

import { errorMessage } from "@alexkroman1/aai";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "./context.ts";
import {
  forwardToGuest,
  GUEST_WEBHOOK_RESPONSE_HEADERS,
  passThroughHeaders,
  pickHeaders,
} from "./guest-forward.ts";
import { GUEST_ROUTES, guestHttpUrl } from "./guest-routes.ts";
import { createLogger } from "./logger.ts";
import { AGENT_UNAVAILABLE_MESSAGE, brokerSessionUrl, notFoundMessage } from "./sandbox-broker.ts";
import type { ResolveSandboxOpts } from "./sandbox-resolve.ts";

const log = createLogger("workflow.webhook");

/**
 * This route's own path under `/:slug`.
 *
 * Must match `GUEST_ROUTE_EXPOSURE.workflowWebhook`'s path + `suffix` —
 * `guest-routes.test.ts` is what holds the two together, which is the same
 * check that catches a missing method.
 */
export const WORKFLOW_WEBHOOK_ROUTE = `${GUEST_ROUTES.workflowWebhook}/:token`;

/**
 * Cap on the request body a webhook may carry.
 *
 * The route is public and boots sandboxes, so the bytes are bounded before
 * anything buffers them. A webhook payload is a small JSON document (a
 * provider's event, a form post); 1 MiB is far above every real one and far
 * below anything worth buffering per request.
 */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

/**
 * How long the guest has to answer one delivery.
 *
 * The DevKit answers `202 Accepted` immediately unless the workflow asked for
 * `respondWith: "manual"`, in which case the response is written from inside
 * the run and can legitimately take seconds. 30s clears that with room while
 * still bounding a request the platform is holding open.
 */
const WORKFLOW_WEBHOOK_TIMEOUT_MS = 30_000;

/** What a sender is told to wait when the sandbox is still booting. */
const RETRY_AFTER_SECONDS = 5;

/**
 * The guest's own webhook URL for this token.
 *
 * The token is re-encoded because Hono handed it over decoded, and the guest
 * parses a SINGLE segment (`webhookToken` rejects an embedded `/` before
 * decoding) — so a token containing a slash has to arrive percent-encoded, as
 * the DevKit minted it.
 */
function guestWebhookUrl(guestOrigin: string, token: string, search: string): string {
  const url = new URL(guestHttpUrl(guestOrigin, GUEST_ROUTES.workflowWebhook));
  url.pathname = `${url.pathname}/${encodeURIComponent(token)}`;
  url.search = search;
  return url.toString();
}

/**
 * Build the webhook-proxy handler.
 *
 * A factory for the same reason the client-config broker is one: the guest
 * `fetch` is injectable, so a spec can assert what crossed to the sandbox
 * without standing one up.
 *
 * @internal
 */
export function createWorkflowWebhookHandler(
  fetchFn: typeof fetch = fetch,
): (c: AppContext, broker: ResolveSandboxOpts) => Promise<Response> {
  return async (c, broker) => {
    const slug = c.var.slug;
    const token = c.req.param("token") ?? "";

    const brokered = await brokerSessionUrl(slug, broker);
    if (!brokered.ok) {
      if (brokered.status === 404) throw new HTTPException(404, { message: notFoundMessage(slug) });
      // Still booting. A 503 is the honest answer and the recoverable one:
      // the boot continues server-side and the sender's retry joins the same
      // readiness promise (see BROKER_READY_TIMEOUT_MS), which is the same
      // deal a browser gets for free by re-brokering.
      log.debug("Workflow webhook arrived while the sandbox was booting", { slug });
      // Not `brokerSessionUrlOrThrow`: this route answers with `Retry-After`
      // rather than a thrown `HTTPException`, because a webhook sender has its
      // own retry loop to steer. The SENTENCE is still the broker's, so the two
      // shapes cannot disagree about what the state is.
      return c.json({ error: AGENT_UNAVAILABLE_MESSAGE }, 503, {
        "Retry-After": String(RETRY_AFTER_SECONDS),
      });
    }

    // Bytes, not a stream: the body is already capped (MAX_WEBHOOK_BODY_BYTES)
    // and a duplex stream would have to outlive this handler's timeout.
    const body = await c.req.arrayBuffer();
    try {
      const res = await forwardToGuest({
        fetchFn,
        url: guestWebhookUrl(brokered.guestOrigin, token, new URL(c.req.url).search),
        method: c.req.method,
        // PASS-THROUGH, not the allow-list the API hop uses, and the exception
        // is load-bearing: the DevKit hands the whole `Request` to the run as
        // the hook's payload, so a workflow verifying `Stripe-Signature` or
        // `X-Hub-Signature-256` reads a header nothing here can enumerate.
        // `NEVER_FORWARDED` still strips the hop-by-hop set AND the three
        // credential-bearing headers (`Cookie`, `Authorization`,
        // `X-Forwarded-*`) that used to reach tenant code through this route.
        headers: passThroughHeaders(c.req.raw.headers),
        ...(body.byteLength > 0 ? { body } : {}),
        // The whole response is buffered below, so the deadline covers it.
        timeoutMs: WORKFLOW_WEBHOOK_TIMEOUT_MS,
      });
      return new Response(await res.arrayBuffer(), {
        // An ALLOW-LIST, unlike the request direction above: a webhook sender
        // reads a status code and the body it can interpret from a content type,
        // and everything a tenant guest could otherwise say here is said in the
        // platform's own voice on an origin it shares with the studio. See
        // `GUEST_WEBHOOK_RESPONSE_HEADERS`, which also carries the `location`
        // decision and what omitting it costs.
        status: res.status,
        headers: pickHeaders(res.headers, GUEST_WEBHOOK_RESPONSE_HEADERS),
      });
    } catch (err: unknown) {
      // The sandbox was brokered and then would not answer — a fault worth a
      // steady-state line, unlike the booting case above. 502 rather than 503:
      // every sender retries a 5xx, and this one says the hop that failed was
      // ours to the guest.
      log.warn("delivery failed", { slug, error: errorMessage(err) });
      throw new HTTPException(502, { message: "workflow webhook delivery failed", cause: err });
    }
  };
}
