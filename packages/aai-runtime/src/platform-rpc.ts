// Copyright 2026 the AAI authors. MIT license.
/**
 * One request to the platform: the POST, the deadline, and the status check that
 * every guest-side client was making for itself.
 *
 * `platform-endpoint.ts` collapsed the credential pair and the five paths. What it
 * left behind was four `call()` bodies — `session-state-platform.ts`,
 * `uploads-platform.ts`, `workflow-platform-storage.ts` and
 * `workflow-platform-queue.ts` — each spelling out the same seven steps: resolve
 * the fetch seam, build the URL, set `authorization` and `content-type`, wrap the
 * whole thing in `pTimeout`, read the body, throw on non-2xx with the status and a
 * 500-character slice of the reply, and unwrap `result`. Four copies of a
 * transport is four places for one of them to drift — and three of them already
 * had, in a way no test could see: a body that fails MID-READ on a non-2xx
 * response rejected with the read error and threw the HTTP status away, so a
 * platform answering 503 while its connection dropped was indistinguishable from
 * a network fault. Only the enqueue client guarded that (`.catch(() => "")`).
 *
 * ## The differences are PARAMETERS and a SPLIT, not four transports
 *
 * They are real and they are decisions, which is why this is a shared body with
 * declared seams rather than one function the four call identically. Two exports
 * rather than one, because the reply is where the four stop agreeing:
 *
 * - **{@link platformResult} is the `{result}` envelope**, and session state and
 *   upload records are the two routes that reply in it.
 * - **{@link platformPost} is the transport under all four**, and is what the
 *   other two take because each reads a reply of its own. Storage speaks the
 *   DevKit's typed-JSON envelope in both directions (a run's `input`/`output` are
 *   `Uint8Array` at `specVersion >= 2`) and discriminates on `ok` rather than
 *   `"result" in body` — a void method encodes as `{}` and tripped the latter.
 *   The enqueue route replies `{messageId}`, and a 200 whose body will not parse
 *   has to read as "no message id" rather than as a syntax error, because the
 *   DevKit correlates on that id.
 * - **{@link PlatformCall.errorFor} is a caller's own error for a non-2xx**, and
 *   two routes have one for opposite reasons. The upload record route's 409 is
 *   `claim` refusing an id, which is that backend WORKING. Storage's 404 has to
 *   reach its caller as the DevKit's own `WorkflowRunNotFoundError`, because a
 *   plain error there became a 500 where the right answer was 404.
 * - **Only the live stream read has no deadline**, which is why it is not here at
 *   all: it is a GET whose response is MEANT to stay open, so a timeout would cut
 *   a healthy read at its own interval. It shares {@link platformBearer} and
 *   nothing else.
 *
 * ## The timeout message names the deadline, not the URL
 *
 * `pTimeout`'s message is read by whoever is looking at a step that failed for no
 * other stated reason, and the actionable fact is WHICH of the four deadlines
 * elapsed — they are 10s, 15s, 15s and 20s, set for four different reasons. So it
 * is `<label> timed out after <ms>ms`, matching `_upload-blobs-brokered.ts`, which
 * already had it right. The enqueue client's message used to interpolate the URL
 * instead; that was an artifact of the URL having once been built twice per call,
 * and the base is one operator-set value the label does not need to repeat.
 *
 * ## The transport is a SOCKET first, and HTTP is the fallback
 *
 * `platform-socket.ts` is preferred and `rpcFetch` answers whenever there is not
 * an open one. Everything above {@link platformPost} reads a status and a body
 * and cannot tell which carried it, which is what let the five clients keep their
 * error handling unchanged; `aai-server/PLATFORM-SOCKET-CLAUDE.md` is the wire.
 *
 * @module platform-rpc
 */

import { RETRYABLE_STATUS } from "@alexkroman1/aai/host-internal";
import { isRecord } from "@alexkroman1/aai/utils";
import pTimeout from "p-timeout";
import { rpcFetch } from "./_egress-fetch.ts";
import { newTraceparent, traceIdOf } from "./_trace-context.ts";
import { type PlatformEndpoint, type PlatformRoute, platformUrl } from "./platform-endpoint.ts";
import { isPlatformSocketUnavailable } from "./platform-socket.ts";
import { platformSocketFor } from "./platform-socket-registry.ts";
import { consoleLogger } from "./runtime-config.ts";
import { PLATFORM_UNAVAILABLE_CODE } from "./workflow-api-error-status.ts";

/** One POST to the platform, as its caller declares it. */
export type PlatformCall = {
  /** Which of `PLATFORM_ROUTES` this call is for. */
  route: PlatformRoute;
  /**
   * What every error this call raises calls it — `session-state load`,
   * `storage runs.get`, `upload-records claim`, `enqueue`.
   *
   * The method is IN the label rather than a field of its own because the four
   * routes name their methods differently (a bare verb, a dotted DevKit path, or
   * none at all for the enqueue route, which has one operation).
   */
  label: string;
  /**
   * An extra path segment under {@link PlatformCall.route}, or `undefined` to
   * post to the route itself.
   *
   * What it is FOR is the request LOG, and `platformUrl`'s own note carries the
   * argument: a route serving a dozen methods behind a body field prints one line
   * per call whatever the method was, so `POST /:slug/workflow-journal` had to be
   * decomposed by counting requests. It is not how the SERVER decides what to do
   * — the method stays in the body as well — because a guest and the platform it
   * calls are deployed independently and a bundle older than this field must keep
   * working. See `workflow-journal-handler.ts`, which reads the path first and
   * falls back to the body.
   *
   * **It reaches the HTTP fallback ONLY.** A socket frame carries a `route` the
   * platform checks against a closed set (`platform-socket-handler.ts`), so a
   * segment appended there would 404 rather than decompose anything — and there
   * is nothing to decompose either way, since that handler writes no per-frame
   * line. Giving the socket path a per-call record of its own is a separate
   * change to that handler, not a field on this one.
   */
  pathSegment?: string | undefined;
  /** How long the whole request may take, in milliseconds. */
  timeoutMs: number;
  /** The already-encoded request body — JSON for three routes, typed JSON for storage. */
  body: string;
  /**
   * This caller's own error for a non-2xx, or `undefined` to take the generic one.
   *
   * Consulted before the generic error, and handed the reply body already read
   * and guarded — so a caller that does not need the body (the upload records
   * client's 409, which is `claim` refusing an id and means the same thing
   * whatever the platform said about it) can ignore the second argument, while
   * one that does (storage, whose 404 becomes the DevKit's own
   * `WorkflowRunNotFoundError`) has it without reading the response twice.
   */
  errorFor?: ((status: number, detail: string) => Error | undefined) | undefined;
};

/**
 * The one header that authorizes a guest to the platform.
 *
 * `AAI_GUEST_TOKEN`, bound to a single sandbox name and therefore to a single
 * slug. Spelled once because it was spelled five times, and a bearer scheme that
 * disagrees with the server's parser by a character is a 401 with nothing naming
 * the header.
 *
 * @internal
 */
export function platformBearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/**
 * POST one body to a platform route and hand back the reply text.
 *
 * Throws on anything but 2xx, naming the status and up to 500 characters of the
 * platform's own reply — which is what tells a reader where to look: a 400 is a
 * call this guest built wrongly, a 404 is a run this agent does not own, a 401 is
 * a bearer this sandbox no longer holds, a 501 is a deployment without the
 * feature, and a 503 is worth retrying.
 *
 * @internal
 */
export async function platformPost(opts: PlatformEndpoint, call: PlatformCall): Promise<string> {
  // A W3C trace context per call, so this side's wall clock and the handler's
  // own breakdown can be put beside each other — see `_trace-context.ts`, which
  // carries the ~840 ms this exists to decompose. Minted here rather than passed
  // in: every one of the four clients goes through this function, so a caller
  // that forgot would be a call with no correlation at all.
  const traceparent = newTraceparent();
  const startedAt = performance.now();
  // ONE deadline for the whole call, transport included — so a socket attempt
  // that is refused and retried over HTTP cannot spend two of them. `pTimeout`
  // does not abort the work it loses; that was already true of the fetch this
  // wraps, and the socket's pending entry is dropped by its own close path.
  const reply = await pTimeout(send(opts, call, traceparent), {
    milliseconds: call.timeoutMs,
    message: `${call.label} timed out after ${call.timeoutMs}ms`,
  });
  // DEBUG, which `consoleLogger` makes a no-op unless `AAI_DEBUG=1`: this is one
  // line per platform call on a path that sustains several a second, and it is
  // an instrument rather than an event. The `traceId` is the join key and the
  // status is what says whether the elapsed time bought anything. `transport`
  // was added with the socket, and is the only way to tell from a guest's log
  // that it is running on the fallback — see `platform-socket.ts`.
  consoleLogger.debug("platform call", {
    label: call.label,
    route: call.route,
    traceId: traceIdOf(traceparent),
    transport: reply.transport,
    status: reply.status,
    elapsedMs: Math.round(performance.now() - startedAt),
  });
  if (!reply.ok) {
    // The body is DETAIL and the status is the finding, so a reply that will not
    // read must not replace it with a stream error. Three of the four clients
    // read this unguarded and lost the status whenever it mattered most — which
    // is also why the guard, rather than the ORDER, is what keeps a caller's own
    // error independent of whether the reply could be read.
    const detail = await reply.text().catch(() => "");
    throw call.errorFor?.(reply.status, detail) ?? statusError(call.label, reply.status, detail);
  }
  return await reply.text();
}

/** One answer, however it arrived. */
type PlatformReply = {
  status: number;
  ok: boolean;
  /** Which transport carried it — a log field, never a decision. */
  transport: "socket" | "http";
  /** The body, read lazily: the failure path reads it guarded and the success path does not. */
  text: () => Promise<string>;
};

/**
 * The transport choice, and the ONE place it is made.
 *
 * The socket is preferred and HTTP is the fallback — see `platform-socket.ts` for
 * why that direction, and for why a refusal is only ever raised BEFORE the frame
 * is written. Everything above this function reads a status and a body and cannot
 * tell the two apart, which is the property that let five clients keep their
 * error handling unchanged.
 */
async function send(
  opts: PlatformEndpoint,
  call: PlatformCall,
  traceparent: string,
): Promise<PlatformReply> {
  const socket = platformSocketFor(opts);
  if (socket !== undefined) {
    try {
      const answered = await socket.send({ route: call.route, body: call.body, traceparent });
      const body = answered.body;
      return {
        status: answered.status,
        ok: answered.status >= 200 && answered.status < 300,
        transport: "socket",
        text: () => Promise.resolve(body),
      };
    } catch (err: unknown) {
      // Only a refusal falls through. A call that was WRITTEN and then failed
      // carries `PLATFORM_UNAVAILABLE_CODE` and is rethrown, because re-sending it
      // over HTTP would run it twice.
      if (!isPlatformSocketUnavailable(err)) throw err;
    }
  }
  // `rpcFetch`, never the global — see `_egress-fetch.ts`. These calls share an
  // origin with the upload broker's, so on HTTP/2 they shared its connection too:
  // a reset taken by a claim's bucket probes failed the run-event reads in the same
  // instant, which is what made one transport fault read as three unrelated bugs.
  const fetchFn = opts.fetch ?? rpcFetch;
  const res = await fetchFn(platformUrl(opts.base, call.route, call.pathSegment), {
    method: "POST",
    headers: {
      ...platformBearer(opts.token),
      "content-type": "application/json",
      traceparent,
    },
    body: call.body,
  });
  return { status: res.status, ok: res.ok, transport: "http", text: () => res.text() };
}

/**
 * The generic error for a non-2xx, CODED when the status says to come back.
 *
 * The message is unchanged and is still where a reader looks; what is new is
 * that a retryable status is machine-readable. Without it the whole family
 * arrived at the workflow API's classification table as a plain `Error`, was
 * declined by every recognizer there, and a platform shortage reached the
 * browser as `500 Internal server error` — see {@link PLATFORM_UNAVAILABLE_CODE}
 * for why that is the one answer this condition must not get.
 *
 * `RETRYABLE_STATUS` is the SDK's own set rather than a list written here, for
 * the reason `_upload-blobs-brokered.ts` gives for taking it: the two ends of a
 * platform call cannot be allowed to disagree about which statuses mean "later".
 * A status outside it stays code-less on purpose — a 400, 401, 404 or 501 will
 * be the same answer next time, and a 503 telling a page to retry one forever is
 * strictly worse than the 500 it gets.
 */
function statusError(label: string, status: number, detail: string): Error {
  const err = new Error(`${label} answered HTTP ${status}: ${detail.slice(0, 500)}`);
  // A property rather than a subclass, for the reason `workflow-run-reads.ts`
  // spells out: this module has one instance per copy of the package in a
  // deployed guest, so a class declared here would have two identities and the
  // harness's copy could not recognise what the bundle's copy threw. Every
  // recognizer in the classification table reads a `code`, which is why that is
  // the property.
  return RETRYABLE_STATUS.has(status)
    ? Object.assign(err, { code: PLATFORM_UNAVAILABLE_CODE })
    : err;
}

/**
 * {@link platformPost}, then the `{result}` envelope session state and upload
 * records reply in.
 *
 * A 200 that is not that envelope throws rather than reading as `undefined`:
 * `undefined` is a legitimate answer on those routes ("no such record", "no such
 * run"), so a contract change would otherwise arrive as an empty result the caller
 * believes. `null` INSIDE the envelope is passed through, which is why the check
 * is `"result" in parsed` and not a truthiness test.
 *
 * @internal
 */
export async function platformResult(opts: PlatformEndpoint, call: PlatformCall): Promise<unknown> {
  const text = await platformPost(opts, call);
  const parsed: unknown = JSON.parse(text);
  if (!(isRecord(parsed) && "result" in parsed)) {
    throw new Error(`${call.label} answered 200 without a result`);
  }
  return parsed.result;
}
