// Copyright 2026 the AAI authors. MIT license.
/**
 * `/:slug/workflows/*` — the durable-workflow API, brokered to the agent's
 * sandbox.
 *
 * The route exists because of WHO calls it. A static-page agent
 * (`agent({ page: "static" })`) is served by this platform at `GET /:slug/`,
 * and its page builds every request URL from `location.origin +
 * location.pathname` (`pageBaseUrl` in aai-ui) — so the calls land HERE, on the
 * platform, not on the guest. `GUEST_ROUTES.workflows` used to note that
 * "nothing host-side routes to it: a page and a programmatic caller both reach
 * the guest directly", which is true of a `curl` caller who knows the sandbox
 * URL and was never true of the page: unlike a voice session, which learns the
 * sandbox from the `/client-config` broker before it dials, `createWorkflowApi`
 * has no broker step at all. Every upload from a deployed
 * `transcription-desk` therefore 404'd on the platform's own `notFound`,
 * reported to the user as `Could not start: Not found`.
 *
 * So this is the SECOND routing point, and it is deliberately shaped like the
 * first (`client-config-handler.ts`): broker the sandbox — which boots it on
 * the first request, exactly as a page load does — and forward. The failure
 * taxonomy is `brokerSessionUrl`'s, shared with the client-config route and the
 * `/:slug/websocket` upgrade, so a still-booting agent is a retryable 503
 * rather than a 404 denying that the workflow exists.
 *
 * **Bodies STREAM through; they are never buffered.** A blob upload is the
 * whole point of the API (`transcription-desk` posts ~2 MB per 60 s of audio)
 * and this process is memory-bounded — `DEPLOY_BODY_CONCURRENCY` exists
 * because the deploy path buffers. Passing `c.req.raw.body` straight to
 * `fetch` keeps peak memory per request at one chunk instead of one payload,
 * which is what makes proxying these acceptable at all.
 */

import { HTTPException } from "hono/http-exception";
import { WORKFLOW_PROXY_TIMEOUT_MS } from "./constants.ts";
import type { AppContext } from "./context.ts";
import { GUEST_ROUTES, guestHttpUrl } from "./guest-routes.ts";
import { registerLiveStream } from "./live-streams.ts";
import { brokerSessionUrl } from "./sandbox-broker.ts";
import type { ResolveSandboxOpts } from "./sandbox-resolve.ts";

/**
 * Request headers forwarded to the guest.
 *
 * An allowlist rather than a copy of the incoming set. `Authorization` is the
 * only one that carries authority — the guest's own gate is
 * `AAI_WORKFLOW_API_TOKEN` — and `Content-Type` is what tells `putBlob` the
 * media type to store. Everything else is either this hop's business (`Host`,
 * `X-Forwarded-*`, `Connection`) or the browser's (`Cookie`, `Origin`), and
 * forwarding those would make the guest's view of the caller a description of
 * the platform instead.
 */
const FORWARDED_REQUEST_HEADERS = ["authorization", "content-type"] as const;

/**
 * Response headers forwarded back.
 *
 * Every route answers JSON, so this is `Content-Type` plus the length when the
 * guest declared one. `Content-Encoding` and `Transfer-Encoding` are
 * deliberately absent: `fetch` has already decoded the body we are re-emitting,
 * so echoing them describes bytes that no longer exist.
 */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "content-length"] as const;

/** The 503 both the broker and the forward answer with — one sentence, one place. */
function unavailable(cause?: unknown): HTTPException {
  return new HTTPException(503, { message: "agent unavailable, retry shortly", cause });
}

/**
 * Resolve the slug's live guest, or throw the answer.
 *
 * The failure taxonomy is `brokerSessionUrl`'s, shared with `/client-config`
 * and the `/:slug/websocket` upgrade: no agent is a 404, and a sandbox that is
 * booting or failed to start is a retryable 503 (the failure hook detaches it,
 * so the next request rebuilds). A run is durable and the page polls, so
 * "retryable" is something the caller can actually act on here.
 */
async function brokerGuestOrigin(slug: string, broker: ResolveSandboxOpts): Promise<string> {
  const brokered = await brokerSessionUrl(slug, broker);
  if (!brokered.ok) {
    if (brokered.status === 404) throw new HTTPException(404, { message: `Not found: ${slug}` });
    throw unavailable(brokered.cause);
  }
  return new URL(guestHttpUrl(brokered.guestOrigin, GUEST_ROUTES.workflows)).origin;
}

/**
 * The guest URL for an incoming platform request.
 *
 * The sub-path is taken from the REQUEST rather than from Hono's route param,
 * so one expression covers `/workflows`, `/workflows/runs`,
 * `/workflows/runs/:id` and `/workflows/blobs` — and cannot disagree with the
 * pattern the route happens to be registered under.
 */
function guestTarget(requestUrl: string, slug: string, guestOrigin: string): URL {
  const incoming = new URL(requestUrl);
  const suffix = incoming.pathname.slice(`/${slug}${GUEST_ROUTES.workflows}`.length);
  return new URL(`${GUEST_ROUTES.workflows}${suffix}${incoming.search}`, guestOrigin);
}

/** Copy an allowlisted subset of `from` into a fresh `Headers`. */
function pickHeaders(from: Headers, names: readonly string[]): Headers {
  const picked = new Headers();
  for (const name of names) {
    const value = from.get(name);
    if (value !== null) picked.set(name, value);
  }
  return picked;
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

    let guestResponse: Response;
    try {
      guestResponse = await fetchFn(target, {
        method: request.method,
        headers: pickHeaders(request.headers, FORWARDED_REQUEST_HEADERS),
        // `duplex: "half"` is REQUIRED whenever the body is a stream — undici
        // rejects the request outright rather than buffering it, which is the
        // trade we want but not one it may assume.
        ...(body ? { body, duplex: "half" } : {}),
        signal: AbortSignal.timeout(WORKFLOW_PROXY_TIMEOUT_MS),
      });
    } catch (cause) {
      // The sandbox was ready a moment ago, so an unreachable guest is one that
      // went away between the broker and the forward — the same retryable
      // condition as a still-booting one, not a platform 500.
      throw unavailable(cause);
    }

    const headers = pickHeaders(guestResponse.headers, FORWARDED_RESPONSE_HEADERS);
    // A run-events stream is long-lived and terminates HERE, at this replica, so it
    // owes `live-streams.ts` a registration: without one, `server.close()` waits it
    // out and `process.exit` then DESTROYS the socket, cutting a chunked body before
    // its terminating frame. That is a protocol error to whatever is reading, and in
    // production the reader is Modal's in-container proxy, which surfaces it as a
    // transfer-encoding failure with nothing tying it to a scale-in. The relayed
    // stream is the same shape the removed split deployment needed
    // `gracefulEventStream` for.
    if (guestResponse.body && isEventStream(headers)) {
      return relayLiveStream(guestResponse.body, guestResponse.status, headers);
    }
    return new Response(guestResponse.body, {
      status: guestResponse.status,
      headers,
    });
  };
}

/** Is this response a server-sent-event stream? */
function isEventStream(headers: Headers): boolean {
  return (headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}

/**
 * Relay a guest's event stream through a body THIS replica can end gracefully.
 *
 * The guest's own `ReadableStream` cannot be handed over directly, because ending
 * it on shutdown means closing the response we are streaming INTO, and only a
 * stream we construct gives us that handle. So the bytes are piped and the
 * controller is what `live-streams.ts` closes.
 *
 * Two properties. The registration is dropped when the stream ends on its own
 * (`registerLiveStream`'s contract — a registry that only grows is a leak, and
 * worse, would let shutdown end an already-finished response). And a shutdown that
 * has ALREADY happened ends this stream synchronously, which is why a page that
 * reconnects mid-shutdown — the modal case, since the client's backoff is shorter
 * than the shutdown grace — gets a clean end rather than a held-open socket.
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
        // awaiting `read()` would leave that pump enqueueing into a closed stream.
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
      // The CLIENT went away. Drop the upstream read and the registration; leaving
      // either would hold a guest connection open for a page that is gone.
      unregister();
      return reader.cancel(reason);
    },
  });
  return new Response(relayed, { status, headers });
}
