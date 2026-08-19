// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow API's HTTP plumbing: JSON replies, the constant-time bearer gate,
 * and the size-capped body reader.
 *
 * Split from `workflow-api.ts` on the seam that is already there — nothing here
 * knows what a workflow is, and every function would read the same for any small
 * JSON surface. What it leaves behind is a module that is only about runs.
 *
 * The body reader is the piece worth not re-deriving: it refuses a stream AS IT
 * ARRIVES rather than trusting `Content-Length`, because a lying header is
 * exactly what a cap has to survive.
 *
 * @internal
 */

import { timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { errorMessage, isRecord } from "../sdk/utils.ts";

/**
 * The response members a JSON reply touches, named rather than taken whole.
 *
 * A `ServerResponse` has ~65 members and these two functions use four, so a spec
 * asked for the real type has no honest option but `{} as http.ServerResponse` —
 * and a cast stops reporting the moment the shape it stands in for changes, which
 * is the opposite of what the spec is there for. Same reasoning as `EventSink` in
 * `workflow-api-events.ts`.
 *
 * **Declared by hand rather than `Pick`ed from node's type**, which was tried
 * first: `writeHead` and `destroy` are typed as returning `this`, so a `Pick`
 * carries that constraint and NOTHING but a real `ServerResponse` satisfies it —
 * the seam would name four members and still be uninhabitable by a double. The
 * returns are `unknown` because no caller here reads them.
 */
export type JsonResponse = {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(body?: string): unknown;
  readonly headersSent: boolean;
  destroy(): unknown;
};

/** Write a JSON body and end the response. */
export function sendJson(res: JsonResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * The headers every SSE response on this surface opens with.
 *
 * `X-Accel-Buffering` is the one that is not obvious: a proxy that buffers
 * defeats the point of streaming at all, and this is the conventional opt-out —
 * inert where it is not understood.
 *
 * Declared once because the two routes that stream (`workflow-api-events.ts`,
 * `workflow-api-stream.ts`) had byte-identical copies, and a header block that
 * exists twice is one a proxy fix reaches half of.
 */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/**
 * One server-sent event, encoded.
 *
 * The trailing BLANK LINE is what dispatches the event — a frame written
 * without it sits in the client's parser until the next one arrives, so the
 * stream silently runs one event behind. That is the detail worth having in one
 * place rather than in the three template literals this replaces.
 */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Whether a rejection is just the CALLER having gone away.
 *
 * A client that hangs up mid-body makes Node error the request stream — `aborted`
 * with `ECONNRESET` — and an `AbortSignal` on the same path surfaces as an
 * `AbortError`. Neither is a fault of this agent's, and there is nobody left to
 * answer: the socket the 500 would be written to is the socket that closed. Logged
 * at ERROR they read as exactly what an operator is hunting for, which is the
 * expensive kind of noise — 30 lines of `Workflow API request failed { error:
 * 'aborted' }` in one hour of production log, every one of them a browser that
 * navigated away or an upload the platform's own proxy gave up on, sitting in the
 * same log as the genuine failures behind them. The repo already treats the
 * mirror-image case this way on the platform side, where a client abandoning a
 * streamed response is logged as expected and only a RISE in them is a signal.
 *
 * The code is what is tested rather than the message: `aborted` is Node's wording
 * and a version away from being someone else's.
 */
export function isCallerGone(err: unknown): boolean {
  if (!isRecord(err)) return false;
  return err.code === "ECONNRESET" || err.name === "AbortError";
}

/**
 * Answer a request whose handler rejected: log the cause, then 500 if the
 * response can still carry one, else drop the socket.
 *
 * One spelling for both HTTP surfaces in this package — the agent server's
 * request tail and the workflow router's — which had drifted into two
 * byte-identical copies. A rejection that reached here is not the caller's
 * fault to describe, so the body is deliberately opaque; the cause goes to the
 * log, where the operator can see it.
 *
 * The final `catch` is not defensive padding: `writeHead` throws if the headers
 * raced out between the check and the write, and an exception escaping THIS
 * function would be the unhandled rejection it exists to prevent.
 */
export function answerHandlerFailure(
  res: JsonResponse,
  logger: { error: (message: string, meta?: Record<string, unknown>) => void },
  message: string,
  error: string,
): void {
  logger.error(message, { error });
  try {
    if (res.headersSent) res.destroy();
    else sendJson(res, 500, { error: "Internal server error" });
  } catch {
    res.destroy();
  }
}

/**
 * Constant-time bearer check.
 *
 * Length is compared first because `timingSafeEqual` THROWS on a length mismatch
 * rather than returning false — and comparing lengths leaks only the length,
 * which the caller supplied anyway.
 */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Largest `POST /workflows/runs` body.
 *
 * Small on purpose. A run's input is serialized into the run record and read
 * back on every replay, so a generous cap here buys nothing an author wants: the
 * bytes a workflow actually works on belong behind a URL or in the app's own
 * storage, fetched from inside a `"use step"` function where they are read once
 * per execution rather than on every resume.
 */
export const MAX_WORKFLOW_INPUT_BYTES = 64 * 1024;

/** Raised by {@link readBody} when the stream ran past its cap. */
export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read a request body, refusing anything past `limit`.
 *
 * Two decisions, both arrived at by getting them wrong first.
 *
 * The size is counted **per chunk, never from `Content-Length`** — a client
 * controls that header independently of what it actually sends, so trusting it
 * means a lying header buffers the whole stream before anyone notices.
 *
 * And an over-limit body is **discarded as it arrives rather than answered by
 * destroying the socket**. What the cap has to bound is MEMORY, and dropping the
 * chunks does that completely; destroying the request additionally stops the
 * upload, which sounds strictly better and costs the thing that matters — the
 * client gets a socket error instead of the 413. So the bytes already in flight
 * are allowed to arrive and be thrown away. An endless upload is bounded by
 * Node's own `server.requestTimeout`.
 */
export function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] | null = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Released here, not at `end`: holding a limit's worth of buffer for the
        // rest of a large body is the allocation this is meant to prevent.
        chunks = null;
        return;
      }
      chunks?.push(chunk);
    });
    req.on("end", () => {
      if (chunks === null) reject(new BodyTooLargeError(limit));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/**
 * Turn an ASYNC route into the synchronous claim `ServerOptions.request` wants.
 *
 * The contract this owns is the one both HTTP surfaces in this package restate
 * and neither states: **claiming is synchronous, handling is not, and a claimed
 * request always gets exactly one answer** — which holds only because the
 * promise's rejection is caught here. That catch was incidental at both call
 * sites (an anonymous `.catch` at the end of a factory), and it is the thing
 * standing between a malformed request and an unhandled rejection in a process
 * whose `uncaughtException` handler exits.
 *
 * `claims` is a predicate rather than a prefix because the two surfaces really
 * do differ: `/workflows` IS a route, while `/session-events` on its own names
 * no session and must fall through.
 *
 * `onError` gets first refusal on a rejection and answers whether it handled
 * one — the workflow API maps `BodyTooLargeError` to a 413 there, so a caller
 * can tell "this input is too large" from "the agent is broken". Anything it
 * declines becomes an opaque 500 with the cause in the log.
 *
 * @internal
 */
export function claimUnder<Req, Res extends JsonResponse>(opts: {
  claims: (url: string) => boolean;
  route: (req: Req, res: Res, url: string, method: string) => Promise<void>;
  logger: {
    error: (message: string, meta?: Record<string, unknown>) => void;
    debug?: (message: string, meta?: Record<string, unknown>) => void;
  };
  /** Log line for a rejection this surface did not handle. */
  label: string;
  onError?: (err: unknown, res: Res) => boolean;
}): (req: Req, res: Res, url: string, method: string) => boolean {
  const { claims, route, logger, label, onError } = opts;
  return (req, res, url, method) => {
    if (!claims(url)) return false;
    route(req, res, url, method).catch((err: unknown) => {
      if (onError?.(err, res)) return;
      // A caller that hung up is not a failure to report, and its socket is not a
      // place to write a 500 — see `isCallerGone`. Dropped rather than answered,
      // and noted at debug so a suspicious volume is still recoverable.
      if (isCallerGone(err)) {
        logger.debug?.(`${label} (caller went away)`, { error: errorMessage(err) });
        res.destroy();
        return;
      }
      answerHandlerFailure(res, logger, label, errorMessage(err));
    });
    return true;
  };
}
