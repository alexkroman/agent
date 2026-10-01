// Copyright 2026 the AAI authors. MIT license.
/**
 * `agent({ routes })` — the app's own JSON endpoints, served by the agent's
 * own server under `/api`.
 *
 * They exist for the page BESIDE a device: a smart speaker's browser twin that
 * lists what the speaker remembers, edits a reminder, or shows the runs going
 * on for it. That data is the agent's — its `sessionContext` reads it, its
 * workflows write it — and until now the only way to serve it was a second
 * process with its own port, its own env and its own copy of the workflow
 * client, which is exactly the sidecar the agent already is.
 *
 * ```ts
 * import { agent, routeResponse } from "@alexkroman1/aai";
 *
 * agent({
 *   name: "Kitchen speaker",
 *   routes: {
 *     "GET /memories": async (req, { env, signal }) => {
 *       const res = await fetch(`${env.MEMORY_URL}/memories/${req.clientId}`, { signal });
 *       return await res.json();
 *     },
 *     "DELETE /memories/:id": async (req, { env, signal }) => {
 *       const url = `${env.MEMORY_URL}/memories/${encodeURIComponent(req.params.id ?? "")}`;
 *       const res = await fetch(url, { method: "DELETE", signal });
 *       return res.ok ? { deleted: true } : routeResponse(404, { error: "No such memory" });
 *     },
 *   },
 * });
 * ```
 *
 * `GET /api/memories?client=kitchen` then answers the first handler's return
 * value as JSON.
 *
 * ## What a handler gets, and why no more
 *
 * Plain data in and plain data out: the request is already parsed (the path's
 * `:params`, the query, the headers, a JSON body — and that body's exact text,
 * for a handler that verifies a signed webhook), and the return value is the
 * response.
 * No `req`/`res` pair, for the reason `sessionContext` has none: the handler
 * runs in the agent bundle's copy of the SDK and the HTTP server is the host's,
 * so everything that crosses between them is data — including the
 * {@link routeResponse} that answers a status other than 200, which is
 * recognized by a `Symbol.for` brand rather than by `instanceof`.
 *
 * Its context is the tool context's durable half: `env` and `workflows` (the
 * same `start`/`find`/`recent` a tool's `ctx.workflows` is), plus
 * `clientTranscript`, the durable log behind `?client=`. No `send`, no
 * `messages`, no `sessionId`: a route belongs to no session. It can REACH one,
 * though: `speech(sessionId)` says a sentence on a live call, which is what a
 * webhook announcing an external event needs (see `session-speech.ts`).
 *
 * ## Security: the routes are exactly as open as the server
 *
 * No authentication is added. On `aai dev` bound to loopback that is the
 * developer; on a server listening on a LAN address (`AAI_DEV_HOST`, `aai
 * start` behind one) it is ANYONE who can reach the port — and `clientId` is a
 * claim that server takes on faith, the same one `?client=` is on the voice
 * socket. A route that reads or changes what a household said is a route every
 * device on that network can call. Keep the server on a network you trust, and
 * put real authentication in front of it before exposing it further.
 *
 * A handler sees the request's HEADERS, which may carry a browser's cookies or
 * an `Authorization` header meant for something else on the same origin. Treat
 * them as secrets: never log them, echo them back, or forward them. A route
 * that authenticates its caller itself — a webhook checking an HMAC over
 * `rawBody` — does so against those headers: for the Standard Webhooks scheme
 * (`webhook-id`/`webhook-timestamp`/`webhook-signature`), use
 * `verifyStandardWebhook` or wrap the handler in `webhookRoute`, which check
 * the replay window, rotated signatures and compare in constant time. Any
 * other scheme should compare in constant time too.
 *
 * ## Refusing a request
 *
 * Return `routeResponse(400, { error })`, or THROW `routeError(400, "…")` from
 * anywhere under the handler — both answer that status with the sentence,
 * where any other throw is a 500. `route({ body, requireClient, handler })`
 * does the usual door checks (a JSON body against a Standard Schema, a
 * required `?client=`) and answers each with a 400. Both are in
 * `agent-route-helpers.ts`.
 *
 * ## Where it is served
 *
 * Self-hosted — `aai dev` (its Vite proxy included), `aai start`,
 * `createRuntimeServer`. A deployed guest serves `/api` on its sandbox URL too,
 * but the PLATFORM routes nothing to it: a page served at `/:slug/` has no
 * `/:slug/api`, so treat the routes as self-hosted only for now.
 *
 * Split out of `types.ts` at the source-length cap, like the other field
 * groups `AgentDef` extends. Re-exported from the root.
 *
 * @module
 */

import { readBrand, setBrand } from "./_boundary.ts";
import { isRecord } from "./is-record.ts";
import type { SessionSpeech } from "./session-speech.ts";
import type { ClientTranscript, StepClientTranscriptOptions } from "./step-client-transcript.ts";
import type { WorkflowClient } from "./workflow.ts";

/**
 * One request to an `agent({ routes })` handler, already parsed.
 *
 * @sealed
 * @public
 */
export interface RouteRequest {
  /** The HTTP method, upper-case: `"GET"`, `"POST"`, `"PUT"`, `"PATCH"` or `"DELETE"`. */
  method: string;
  /** The path the route matched, WITHOUT the `/api` prefix: `"/memories/42"`. */
  path: string;
  /** The `:name` segments of the route's pattern, decoded: `{ id: "42" }`. */
  params: Record<string, string>;
  /** The query string, first value per key. `?client=` is in it too. */
  query: Record<string, string>;
  /**
   * The request headers, names lower-cased: `headers["webhook-signature"]`. A
   * header sent more than once arrives as one value, joined with `", "`. Plain
   * data, like the rest of the request.
   *
   * May carry cookies and `Authorization` — see this module's security note.
   */
  headers: Record<string, string>;
  /**
   * The request body parsed as JSON — for `POST`, `PUT`, `PATCH` and `DELETE`;
   * `undefined` for a `GET`, or for any request that sent no body. A body that
   * is not JSON is refused with a 400 before the handler runs.
   */
  body: unknown;
  /**
   * The request body exactly as received, as UTF-8 text — present whenever
   * `body` is, under the same cap and the same JSON-only rule.
   *
   * These are the bytes a signature was computed over: verify a signed webhook
   * (an HMAC over `${id}.${timestamp}.${rawBody}`, say) against THIS, never
   * against a re-serialization of `body` — `JSON.stringify` does not reproduce
   * the sender's whitespace, key order or number spelling.
   */
  rawBody?: string;
  /**
   * The `?client=` the request named, when it is a well-formed client id — the
   * same id a device's voice socket and its `WS /inbox` are held under. A CLAIM:
   * nothing authenticates it (see this module's security note).
   */
  clientId?: string;
}

/**
 * What an `agent({ routes })` handler is called with beside its request.
 *
 * @sealed
 * @public
 */
export interface RouteContext {
  /** The agent's environment — the same view a tool reads as `ctx.env`. */
  env: Readonly<Partial<Record<string, string>>>;
  /**
   * The same client a tool's `ctx.workflows` is: start runs, and read them back
   * — `find(workflow, clientId)` for the runs a tool keyed by client,
   * `recent(workflow)` for the rest, `lastLine(runId)` for the newest progress.
   */
  workflows: WorkflowClient;
  /**
   * What `clientId`'s sessions said — the same read, and the same answer, as
   * `stepClientTranscript` on `@alexkroman1/aai/step`, bound to THIS runtime's
   * log rather than to whichever runtime last published the step slot. The
   * shape a page picking a conversation to continue lists from: each session's
   * id, `startedAt`, and its `messages` (the first is a preview, the count is
   * its length).
   *
   * Rejects for a malformed client id. A backend that keeps no client log (the
   * platform's) answers no sessions.
   */
  clientTranscript(
    clientId: string,
    options?: StepClientTranscriptOptions,
  ): Promise<ClientTranscript>;
  /**
   * The speech of the LIVE session `sessionId` on this server: say a sentence
   * on that call, or stop the agent. See {@link SessionSpeech}. `undefined`
   * when no session by that id is live here: it ended, or it never existed.
   *
   * **A session id is not authorization.** Routes are as open as the server
   * (see this module's security note), so a handler that speaks into a call
   * must first establish that the request may: verify the webhook's signature
   * (`webhookRoute`), and take the id from state your own code wrote (a tool
   * that registered the callback recorded `ctx.sessionId`), never from the
   * request alone.
   */
  speech(sessionId: string): SessionSpeech | undefined;
  /** Aborted when the caller goes away. Pass it to whatever you fetch with. */
  signal: AbortSignal;
}

/**
 * One `agent({ routes })` handler. Its return value is the response body, sent
 * as JSON with status 200 (`undefined` is sent as `null`); return
 * {@link routeResponse} for any other status. A thrown `routeError(status,
 * message)` answers that status with `{ error: message }`; any other throw is a
 * 500 whose body is `{ error: <the message> }` — never the stack.
 *
 * @public
 */
export type RouteHandler = (req: RouteRequest, ctx: RouteContext) => unknown;

/**
 * The `routes` field of an agent declaration — see this module's header.
 *
 * @public
 */
export interface AgentRoutes {
  /**
   * JSON endpoints served under `/api`, keyed `"<METHOD> <path>"`:
   * `"GET /memories"`, `"POST /memories/:id"`. A `:name` segment matches one
   * path segment and is handed to the handler as `req.params.name`. The method
   * is one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`; a key that is not that
   * shape fails the runtime's start rather than never matching.
   *
   * An unknown path is a JSON 404; a known path with the wrong method is a 405
   * naming the methods it has. Bodies are capped (`MAX_ROUTE_BODY_BYTES` on
   * `aai-runtime`, 64 KiB) and must be JSON.
   *
   * As open as the server itself — see this module's security note.
   */
  routes?: Record<string, RouteHandler> | undefined;
}

/** A status a route may answer: 2xx, 4xx or 5xx — never a 1xx or a redirect. */
function isRouteStatus(status: unknown): status is number {
  if (typeof status !== "number" || !Number.isInteger(status)) return false;
  return (status >= 200 && status <= 299) || (status >= 400 && status <= 599);
}

/**
 * A route's answer with a status of its own — what {@link routeResponse} makes.
 *
 * @sealed
 * @public
 */
export interface RouteResponse {
  /** The HTTP status: 2xx, 4xx or 5xx. */
  readonly status: number;
  /** Sent as JSON; `undefined` sends no body at all (a 204, say). */
  readonly body: unknown;
}

/**
 * Answer a route with `status` and `body` instead of a plain 200:
 * `return routeResponse(404, { error: "No such memory" })`,
 * `return routeResponse(201, created)`.
 *
 * Throws a `RangeError` for a status that is not 2xx, 4xx or 5xx: a 1xx or a
 * redirect is not a JSON answer, and a typo there should fail where it was made.
 *
 * @public
 */
export function routeResponse(status: number, body?: unknown): RouteResponse {
  if (!isRouteStatus(status)) {
    throw new RangeError(`routeResponse: status must be a 2xx, 4xx or 5xx code, got ${status}`);
  }
  const response = { status, body };
  // The registered `routeResponse` brand, so every copy of this module reads
  // it; non-enumerable, so it never reaches a JSON body or a log line.
  setBrand(response, "routeResponse", true);
  return response;
}

/**
 * `value` as a {@link RouteResponse} when {@link routeResponse} made it — in
 * any copy of this module — else `undefined`, meaning "a plain 200 body".
 *
 * The status is re-checked rather than trusted: a registry symbol is something
 * anyone can mint the brand from.
 *
 * @internal
 */
export function readRouteResponse(value: unknown): RouteResponse | undefined {
  if (!isRecord(value) || readBrand(value, "routeResponse") !== true) return undefined;
  const { status } = value;
  return isRouteStatus(status) ? { status, body: value.body } : undefined;
}
