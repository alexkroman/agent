// Copyright 2026 the AAI authors. MIT license.
/**
 * `GET /session-events/:sessionId` — reading a session's retained event stream.
 *
 * ```
 * GET /session-events/:id?startIndex=0  → { events, tail }
 * ```
 *
 * ## It answers ONCE, and that is the design rather than a limitation
 *
 * The workflow progress stream next door is SSE, because a run writes for
 * minutes and a page wants to watch. This is a plain JSON read, because the
 * whole property the stream is built on is that a read is BOUNDED: `tail` is the
 * log's length when the request was answered, so a reader that wants to follow
 * along re-opens from where it left off. Holding a response open would imply a
 * subscription the mechanism deliberately does not offer — and it is exactly the
 * shape that wedged `GET /runs/:id/stream` for 120 seconds on a FINISHED run,
 * because no writer knows it is the last (see `useWorkflowProgress` in the
 * aai-ui guide).
 *
 * ## It is CLOSED by default, where the workflow API is open
 *
 * The two defaults differ deliberately. `/workflows` is fail-open because a
 * static page carries no credential and requiring one would mean no page could
 * ever work — there is an in-product caller with nothing to present. Nothing on
 * this route has that shape: the browser client does not read it (a reconnect is
 * restored server-side now), and its content is the CONVERSATION — transcripts,
 * tool arguments, the caller's own words. So with {@link SESSION_EVENTS_TOKEN_ENV}
 * unset the route 404s, and setting it is what turns the surface on.
 *
 * A 404 rather than a 401 for the unset case, matching how the workflow API
 * answers a server that stores no uploads: "this agent does not serve that" is
 * the true statement, and a 401 would advertise a surface the operator has not
 * enabled.
 *
 * ## The session id is not a capability
 *
 * A session id is an unguessable UUID, which is what makes it safe to key a read
 * on — the same reasoning a workflow run id rides on. It is NOT authorization on
 * its own, hence the bearer: two tenants' sessions live behind one agent, and a
 * caller holding one id must not be able to walk the space.
 */

import {
  requestPath,
  requestQuery,
  SESSION_EVENT_READ_LIMIT,
} from "@alexkroman1/aai/host-internal";
import { decodePathSegment } from "./_path-decode.ts";
import type { Logger } from "./runtime-config.ts";
import type { SessionEventStream } from "./session-event-stream.ts";
import { bearerMatches, claimUnder, type JsonResponse, sendJson } from "./workflow-api-http.ts";

/** Path prefix this surface lives under. */
export const SESSION_EVENTS_PATH = "/session-events";

/**
 * The request members this route reads, named so a test double can satisfy them.
 *
 * The same reasoning as `EventSink` in `workflow-api-events.ts`: an
 * `http.IncomingMessage` has ~40 members and this reads two, so a spec forced to
 * produce one casts — and a cast stops reporting when the shape changes, which
 * is the opposite of what a test is for.
 */
export type SessionEventsRequest = {
  readonly url?: string | undefined;
  readonly headers: { readonly authorization?: string | undefined };
};

/**
 * The response members this route writes — `sendJson`'s own surface, shared with
 * the workflow API rather than restated here.
 */
export type SessionEventsResponse = JsonResponse;

/**
 * Env var holding the bearer this route requires. Unset leaves the route OFF —
 * see the module doc for why the default is the opposite of the workflow API's.
 */
export const SESSION_EVENTS_TOKEN_ENV = "AAI_SESSION_EVENTS_TOKEN";

/** Options for {@link createSessionEventsApi}. */
export type SessionEventsApiOptions = {
  /**
   * The runtime's event stream.
   *
   * A THUNK for the same reason the workflow API's engine is: the guest harness
   * builds its runtime lazily, so capturing the value at mount time would
   * capture `undefined` for the life of the server.
   */
  stream: () => SessionEventStream | undefined;
  /**
   * The bearer every request must present. Undefined turns the route off.
   *
   * A BLANK value (empty, or whitespace only) is not a third state. It used to
   * be the worst one available: `""` is not `undefined`, so the route turned ON,
   * and `bearerMatches(header, "")` compared two empty buffers — which
   * `timingSafeEqual` MATCHES — so `AAI_SESSION_EVENTS_TOKEN=` served the
   * conversation to a caller with no `Authorization` header. `bearerMatches`
   * refuses a blank secret now, so a caller passing one directly gets a 401 on
   * every request; `createRuntimeServer` reads the variable through `agentGateToken`,
   * which reports a blank one as absent and logs why, so an OPERATOR gets the
   * 404 above naming the variable rather than a silent 401 forever.
   */
  token?: string | undefined;
  logger: Logger;
};

/**
 * Parse `?startIndex=`.
 *
 * A negative value counts back from the end, matching the workflow stream's
 * `startIndex` — the one place a reader's vocabulary is shared between the two
 * surfaces, so "the last 50 events" is spelled the same way in both.
 *
 * **And the result is CLAMPED, because this number becomes a `bigint`
 * parameter.** `Number.isFinite` was the only bound, which let two shapes of
 * query-string typo reach the driver: anything over ~9.22e18 as a value out of
 * range for the column, and anything over ~1e21 as the string `"1e+30"`, which
 * is a syntax error. Measured on a real Postgres backend under `aai dev`, both
 * answered `500 Internal server error`. The memory backend takes any number at
 * all, so this is invisible without a database — the failure class the pg tier
 * exists for. Clamping costs nothing: `MAX_SAFE_INTEGER` is already past the
 * end of every stream, so the answer is the same empty page it was.
 */
function resolveStartIndex(raw: string | null, tail: number): number {
  if (raw === null) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  const index = Math.trunc(parsed);
  if (index < 0) return Math.max(0, tail + index);
  return Math.min(index, Number.MAX_SAFE_INTEGER);
}

/**
 * The tail a NEGATIVE `startIndex` counts back from.
 *
 * `stream.tail` answers from the process's own map, which is right for a
 * session it is running and `0` for one it has never handled — and on a durable
 * backend that second case is ordinary, not exotic: the store outlives the
 * process that wrote to it. Resolving `-50` against `0` clamps to `0`, so "the
 * last 50 events" silently answered with the whole stream from the beginning.
 *
 * `read` is the durable-aware one (see its own comment), so a cold negative
 * index asks IT for the tail first. Only that path pays the extra query: a warm
 * cursor short-circuits, and so does every non-negative index, which never
 * consults the tail at all.
 */
async function tailToCountBackFrom(
  stream: SessionEventStream,
  sessionId: string,
  raw: string | null,
): Promise<number> {
  const known = stream.tail(sessionId);
  if (known > 0 || raw === null || !(Number(raw) < 0)) return known;
  return (await stream.read(sessionId, 0, 1)).tail;
}

/**
 * Create the session-events request handler.
 *
 * Returns true when it has CLAIMED the request — same contract as
 * `createWorkflowApi`, so `createRuntimeServer` treats both the same way.
 *
 * @internal
 */
export function createSessionEventsApi(
  opts: SessionEventsApiOptions,
): (req: SessionEventsRequest, res: SessionEventsResponse, url: string, method: string) => boolean {
  const { stream: resolveStream, token, logger } = opts;

  async function route(
    req: SessionEventsRequest,
    res: SessionEventsResponse,
    url: string,
    method: string,
  ): Promise<void> {
    // Checked before anything else touches the runtime, for the same reason the
    // workflow API checks its token first: resolving builds the runtime in the
    // guest, and an unauthenticated caller must not be able to trigger that.
    if (token === undefined) {
      sendJson(res, 404, {
        error:
          `This agent does not serve its session event stream. Set ${SESSION_EVENTS_TOKEN_ENV} ` +
          "in the agent env to enable it.",
      });
      return;
    }
    if (!bearerMatches(req.headers.authorization, token)) {
      sendJson(res, 401, { error: "Missing or invalid session events token" });
      return;
    }
    if (method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }
    // The query is stripped before the slice, not assumed absent. `createRuntimeServer`
    // hands this handler a path with the query already removed — but the id is
    // the LAST path segment, so a caller that passed the raw URL would put
    // `?startIndex=1` inside the session id and read a log that does not exist.
    const path = requestPath(url);
    const sessionId = decodePathSegment(path.slice(`${SESSION_EVENTS_PATH}/`.length));
    // A segment that will not percent-decode is a malformed REQUEST, not a
    // missing session — see `_path-decode.ts` for why no decode site here may
    // simply throw.
    if (sessionId === undefined) {
      sendJson(res, 400, { error: "Malformed session id" });
      return;
    }
    if (sessionId.length === 0) {
      sendJson(res, 404, { error: "No session id" });
      return;
    }
    const stream = resolveStream();
    if (!stream) {
      sendJson(res, 503, { error: "This agent's runtime is not available" });
      return;
    }
    const query = requestQuery(req.url);
    const raw = query.get("startIndex");
    const startIndex = resolveStartIndex(raw, await tailToCountBackFrom(stream, sessionId, raw));
    const page = await stream.read(sessionId, startIndex, SESSION_EVENT_READ_LIMIT);
    // `durable: false` is an ANSWER, not a footnote: on the memory tier a read
    // can only see what this process still holds, so a caller getting an empty
    // page needs to be able to tell "nothing happened" from "this deployment
    // keeps no record". `appDatabaseUsage`-visible storage is what changes it.
    sendJson(res, 200, {
      sessionId,
      startIndex,
      tail: page.tail,
      durable: stream.durable,
      events: page.events,
    });
  }

  // The bare prefix names no session, so it is NOT claimed — the one thing this
  // surface's claim rule does differently from the workflow API's.
  return claimUnder<SessionEventsRequest, SessionEventsResponse>({
    claims: (url) => url.startsWith(`${SESSION_EVENTS_PATH}/`),
    route,
    logger,
    label: "Session events request failed",
  });
}
