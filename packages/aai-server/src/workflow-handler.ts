// Copyright 2026 the AAI authors. MIT license.
/**
 * `/:slug/workflows/*` — the durable-workflow API, brokered to the agent's
 * sandbox.
 *
 * The route exists because of WHO calls it. A workflow app
 * (`workflowApp()`) is served by this platform at `GET /:slug/`,
 * and its page builds every request URL from `location.origin +
 * location.pathname` (`pageBaseUrl` in aai-ui) — so the calls land HERE, on the
 * platform, not on the guest. Unlike a voice session, which learns the sandbox
 * from the `/client-config` broker before it dials, `createWorkflowApi` has no
 * broker step at all: it cannot know a sandbox URL and must not, since the URL
 * changes on every respawn while the page holding a `runId` does not.
 *
 * So this is the SECOND routing point, and it is deliberately shaped like the
 * first (`client-config-handler.ts`): broker the sandbox — which boots it on the
 * first request, exactly as a page load does — and forward. The failure taxonomy
 * is `brokerSessionUrl`'s, shared with the client-config route and the
 * `/:slug/websocket` upgrade, so a still-booting agent is a retryable 503 rather
 * than a 404 denying that the workflow exists.
 *
 * **Both directions of that taxonomy are load-bearing, and the 404 half was
 * missing.** A DELETED agent reached this route twice over — once before the
 * forward, once as the forward's own failure — and left it as the booting
 * agent's 503, telling a caller to retry something that can never succeed. See
 * {@link gone}.
 *
 * **Bodies STREAM through; they are never buffered.** This process is
 * memory-bounded — `DEPLOY_BODY_CONCURRENCY` exists because the deploy path
 * buffers — and passing `c.req.raw.body` straight to `fetch` keeps peak memory
 * per request at one chunk instead of one payload.
 *
 * The broker→URL→header-filter→bounded-fetch sequence itself is
 * `guest-forward.ts`, shared with the other two guest proxies; the header
 * ALLOW-LISTS it applies are documented there.
 */

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { clientIp } from "./client-ip.ts";
import type { AppContext, HonoEnv } from "./context.ts";
import {
  forwardToGuest,
  GUEST_API_REQUEST_HEADERS,
  GUEST_API_RESPONSE_HEADERS,
  pickHeaders,
} from "./guest-forward.ts";
import { GUEST_ROUTES, guestHttpUrl } from "./guest-routes.ts";
import { guestTokenFor } from "./guest-token.ts";
import { registerLiveStream } from "./live-streams.ts";
import {
  createRateLimiter,
  type RateLimiter,
  WORKFLOW_IP_RATE_LIMIT,
  WORKFLOW_START_IP_RATE_LIMIT,
} from "./rate-limit.ts";
import {
  AGENT_UNAVAILABLE_MESSAGE,
  brokerSessionUrlOrThrow,
  notFoundMessage,
} from "./sandbox-broker.ts";
import { agentSandboxName } from "./sandbox-directory.ts";
import type { ResolveSandboxOpts } from "./sandbox-resolve.ts";
import {
  GUEST_PROXY_TOKEN_HEADER,
  WORKFLOW_PROXY_TIMEOUT_MS,
  WORKFLOW_PROXY_TRANSFER_TIMEOUT_MS,
} from "./workflow-proxy-constants.ts";

/** The 503 the forward answers with — the broker's own sentence, not a second one. */
function unavailable(cause?: unknown): HTTPException {
  return new HTTPException(503, { message: AGENT_UNAVAILABLE_MESSAGE, cause });
}

/**
 * The 404 for a slug whose agent is GONE — terminal, where {@link unavailable}
 * invites a retry.
 *
 * A deleted agent and a still-booting sandbox used to leave this route saying the
 * same thing: `503 agent unavailable, retry shortly`. Only one of them is
 * retryable. A delete drops the agents row and every workflow table cascades off
 * it (`workflow_queue`, `workflow_runs`, `workflow_uploads`, …), so there is no
 * run left to resume and no sandbox that will ever answer — while the sentence
 * tells the caller, and any retrying client, to come back and ask again.
 *
 * The reported case was an UPLOAD, where the split is visible inside one feature:
 * the byte windows go to `/:slug/uploads/:id/:offset`, whose `assertAgentExists`
 * answers 404 for this very condition, and the `?stored=1` notification that
 * follows each window comes through HERE and answered 503. So one half of one
 * upload loop was told "gone" and the other "try again", and the retry never
 * stopped.
 *
 * **404 with `notFoundMessage`, not a 410.** `Gone` claims the resource existed
 * and was removed, and nothing here can support that claim: a delete leaves no
 * tombstone, so a deleted slug and a slug nobody ever deployed are the same
 * absent row — the platform cannot tell them apart and should not pretend to. It
 * is also what the routes on either side of this one already answer
 * (`brokerSessionUrlOrThrow` for a slug with no bundle, `assertAgentExists` for
 * the upload bytes), which is what keeps "there is nothing of yours here" one
 * sentence on this surface rather than three.
 */
function gone(slug: string): HTTPException {
  return new HTTPException(404, { message: notFoundMessage(slug) });
}

/**
 * Resolve the slug's live guest, or throw the answer.
 *
 * The failure taxonomy is `brokerSessionUrl`'s, shared with `/client-config` and
 * the `/:slug/websocket` upgrade: no agent is a 404, and a sandbox that is
 * booting or failed to start is a retryable 503 (the failure hook detaches it,
 * so the next request rebuilds). A run is durable and the page re-reads, so
 * "retryable" is something the caller can actually act on here.
 */
async function brokerGuestOrigin(slug: string, broker: ResolveSandboxOpts): Promise<string> {
  const brokered = await brokerSessionUrlOrThrow(slug, broker);
  return new URL(guestHttpUrl(brokered.guestOrigin, GUEST_ROUTES.workflows)).origin;
}

/**
 * The guest URL for an incoming platform request.
 *
 * The sub-path is taken from the REQUEST rather than from Hono's route param, so
 * one expression covers `/workflows`, `/workflows/runs`, `/workflows/runs/:id`
 * and `/workflows/runs/:id/events` — and cannot disagree with the pattern the
 * route happens to be registered under.
 */
function guestTarget(requestUrl: string, slug: string, guestOrigin: string): URL {
  const incoming = new URL(requestUrl);
  const suffix = incoming.pathname.slice(`/${slug}${GUEST_ROUTES.workflows}`.length);
  return new URL(`${GUEST_ROUTES.workflows}${suffix}${incoming.search}`, guestOrigin);
}

/**
 * Build the workflow-API proxy handler.
 *
 * A factory taking the guest `fetch` for the same reason the client-config
 * broker's is injectable: the tests need a guest without a sandbox.
 */
export function createAgentWorkflowsHandler(
  fetchFn: typeof fetch = fetch,
): (c: AppContext, broker: ResolveSandboxOpts) => Promise<Response> {
  return async (c, broker) => {
    const slug = c.var.slug;
    const request = c.req.raw;
    const target = guestTarget(c.req.url, slug, await brokerGuestOrigin(slug, broker));
    const body = request.method === "GET" || request.method === "HEAD" ? null : request.body;

    // Prove to the guest that this request came THROUGH the platform, so its
    // workflow API can refuse a DIRECT dial of the public sandbox tunnel — the
    // path that otherwise bypasses the rate limiters this route is wrapped in.
    // The bearer is this sandbox's manage token, which a direct dialer cannot
    // forge; see GUEST_PROXY_TOKEN_HEADER and the guest's gate in
    // aai-guest/harness-agent-mode.ts. `getAgentVersion` is one indexed read and
    // gives the version the running guest's token was derived from (as
    // agent-logs.ts does for `/manage/*`).
    //
    // A null here is the agent being GONE, and it is reached without any race at
    // all: `resolveSandbox`'s fast path serves a live resident WITHOUT consulting
    // the row, and a delete's resident is terminated by the change stream and
    // drained over minutes — so for that whole window the broker above succeeds
    // for a slug whose row is already deleted, and every request through this
    // route lands here. It used to answer the retryable 503, which is advice
    // nothing can act on.
    const version = await c.env.store.getAgentVersion(slug);
    if (version === null) throw gone(slug);
    const requestHeaders = pickHeaders(request.headers, GUEST_API_REQUEST_HEADERS);
    requestHeaders.set(GUEST_PROXY_TOKEN_HEADER, guestTokenFor(agentSandboxName(slug, version)));

    let guestResponse: Response;
    try {
      guestResponse = await forwardToGuest({
        fetchFn,
        url: target,
        method: request.method,
        headers: requestHeaders,
        body,
        timeoutMs: WORKFLOW_PROXY_TIMEOUT_MS,
        // And once a body is MOVING the window is a different one, because what
        // it waits on is the guest's write bandwidth rather than a round trip:
        // undici buffers a stream body ahead of the socket, so a pull stall means
        // that buffer is full and it drains at the guest's pace. A flat 30s here
        // is what put 27 of these into an hour of production log as 503s, all
        // between 30.3s and 34.1s, on a guest that was storing fine.
        transferTimeoutMs: WORKFLOW_PROXY_TRANSFER_TIMEOUT_MS,
        // The deadline bounds neither body — and BOTH halves of that are a
        // route on this surface being legitimately unbounded.
        //
        // Not the RESPONSE body, because `GET /runs/:id/events` holds a stream
        // open for minutes: a still-armed signal would abort it mid-body, which
        // is precisely the truncated chunked response `live-streams.ts` exists
        // to prevent, on a healthy agent, at a fixed interval, looking like a
        // network fault.
        //
        // Not the REQUEST body, because `POST /workflows/uploads` carries a file
        // and the guest answers 201 only once the last byte is stored — so a
        // head deadline is transitively a deadline on the whole transfer, and
        // any total is really a claim about the caller's upstream bandwidth.
        // `"activity"` re-arms per chunk drained instead; see `guest-forward.ts`.
        bound: "activity",
      });
    } catch (cause) {
      // A DELETE landing mid-forward is the other thing that unreaches a guest,
      // and it is not retryable at all: it terminates the resident, so the
      // forward fails exactly as a crashed guest's does — `fetch failed <-
      // aborted`, which is the cause chain the reported 503 carried — and the row
      // is the only thing that tells the two apart. One indexed read, on the
      // FAILURE path only, so the forward that works pays nothing.
      //
      // A peer replica can still serve this slug's version out of its cache and
      // answer 503 once more; that window is one second (`VERSION_CACHE_TTL_MS`)
      // and is the staleness every route on this surface already has, where the
      // retry loop it replaces was bounded by nothing.
      if ((await c.env.store.getAgentVersion(slug)) === null) throw gone(slug);
      // The sandbox was ready a moment ago, so an unreachable guest is one that
      // went away between the broker and the forward — the same retryable
      // condition as a still-booting one, not a platform 500.
      throw unavailable(cause);
    }

    const headers = pickHeaders(guestResponse.headers, GUEST_API_RESPONSE_HEADERS);
    // A run-events stream is long-lived and terminates HERE, at this replica, so
    // it owes `live-streams.ts` a registration: without one, `server.close()`
    // waits it out and `process.exit` then DESTROYS the socket, cutting a
    // chunked body before its terminating frame. That is a protocol error to
    // whatever is reading, and in production the reader is Modal's in-container
    // proxy, which surfaces it as a transfer-encoding failure with nothing tying
    // it back to a scale-in.
    if (guestResponse.body && isEventStream(headers)) {
      return relayLiveStream(guestResponse.body, guestResponse.status, headers);
    }
    return new Response(guestResponse.body, { status: guestResponse.status, headers });
  };
}

/** Is this response a server-sent-event stream? */
function isEventStream(headers: Headers): boolean {
  return (headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}

/**
 * Relay a guest's event stream through a body THIS replica can end gracefully.
 *
 * The guest's own `ReadableStream` cannot be handed over directly, because
 * ending it on shutdown means closing the response we are streaming INTO, and
 * only a stream we construct gives us that handle. So the bytes are piped and
 * the controller is what `live-streams.ts` closes.
 *
 * Two properties. The registration is dropped when the stream ends on its own
 * (`registerLiveStream`'s contract — a registry that only grows is a leak, and
 * worse, would let shutdown end an already-finished response). And a shutdown
 * that has ALREADY happened ends this stream synchronously, which is why a page
 * that reconnects mid-shutdown — the common case, since the client's own
 * reconnect is shorter than the shutdown grace — gets a clean end rather than a
 * held-open socket.
 */
function relayLiveStream(
  body: ReadableStream<Uint8Array>,
  status: number,
  headers: Headers,
): Response {
  const reader = body.getReader();
  let unregister = (): void => undefined;
  const relayed = new ReadableStream<Uint8Array>({
    start(controller) {
      unregister = registerLiveStream(() => {
        // Cancel the upstream read FIRST: closing the controller while a pump is
        // awaiting `read()` would leave that pump enqueueing into a closed
        // stream.
        reader.cancel().catch(() => undefined);
        try {
          controller.close();
        } catch {
          // Already closed by the pump finishing at the same moment — harmless,
          // and worth swallowing rather than surfacing as a shutdown error.
        }
      });
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          unregister();
        }
      })();
    },
    cancel(reason) {
      // The CLIENT went away. Drop the upstream read and the registration;
      // leaving either would hold a guest connection open for a page that is
      // gone.
      unregister();
      return reader.cancel(reason);
    },
  });
  return new Response(relayed, { status, headers });
}

/**
 * Per-IP rate limiting for this surface: two limits, counted together.
 *
 * The surface limit is sized for a POLLING page (see `WORKFLOW_IP_RATE_LIMIT`);
 * the start limit is much tighter, because a `POST /runs` queues work that
 * OUTLIVES its request while everything else here is a read. A start is checked
 * against BOTH, in ascending tightness — counting the start limit INSTEAD would
 * make the one route whose cost outlives its reply the only route escaping the
 * surface cap, which is the inversion this ordering exists to prevent.
 *
 * It runs BEFORE the handler, so a refused request never brokers — and
 * brokering is the expensive part, since it boots a sandbox. A limiter placed
 * after would be a rate limit on the reply rather than on the work.
 *
 * Here rather than inline in `orchestrator.ts` because that function is at the
 * cognitive-complexity ceiling and this is the route's own policy, not the
 * app's.
 */
export function createWorkflowRateLimitMw(
  /**
   * Overrides, for a composition that wants Postgres-backed limiters (so the
   * limit holds fleet-wide) or a test that wants a tight one. The defaults are
   * built HERE rather than at the call site so the route's policy is one thing
   * in one place.
   */
  limiters: { surface?: RateLimiter | undefined; start?: RateLimiter | undefined } = {},
) {
  const surface = limiters.surface ?? createRateLimiter(WORKFLOW_IP_RATE_LIMIT);
  const start = limiters.start ?? createRateLimiter(WORKFLOW_START_IP_RATE_LIMIT);
  const startPath = `${GUEST_ROUTES.workflows}/runs`;
  return createMiddleware<HonoEnv>(async (c, next) => {
    const ip = clientIp(c.req.raw);
    const isStart = c.req.method === "POST" && c.req.path.endsWith(startPath);
    const applicable = isStart ? [surface, start] : [surface];
    // CONCURRENT, and the ordering above survives it: the verdicts are read back
    // in ascending tightness, so a start refused by both still reports the
    // surface limit's `Retry-After`. Serially this was two round trips on the
    // durable arm (`createPgRateLimiter` is one upsert each, on the shared admin
    // connection) in front of the one route whose work outlives its reply.
    //
    // It does change what gets COUNTED, which is the reason this is a comment and
    // not a one-line edit: a request the surface limit refuses now also increments
    // the start window, where the short-circuit used to spare it. For a
    // fixed-window abuse limit that is the stricter reading and the harmless one —
    // `CHECK_SQL` only moves `reset_at` when the window has expired, so extra
    // counting inside a window cannot extend it, and a caller already being
    // refused is not owed a spared counter.
    const verdicts = await Promise.all(applicable.map((limiter) => limiter.check(ip)));
    const refused = verdicts.find((verdict) => !verdict.ok);
    if (refused && !refused.ok) {
      return c.json({ error: "Too many workflow requests — try again later" }, 429, {
        "Retry-After": String(refused.retryAfterSeconds),
      });
    }
    await next();
  });
}
