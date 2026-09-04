// Copyright 2026 the AAI authors. MIT license.
/**
 * A `node:http` ↔ `fetch` adapter for the workflow routes.
 *
 * Its own module because two unrelated doors need it and neither owns the other:
 * the webhook route, mounted on `createServer` (`workflow-webhook.ts`), and the
 * platform's delivery door (`workflow-serve.ts`). Putting it with either would
 * make one door import the other's module for an HTTP shim.
 *
 * It is small and it is temporary either way — once the session server is on
 * Hono (`c.req.raw` is already a `Request`) these handlers mount directly and
 * this goes away.
 *
 * @internal
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { Logger } from "./runtime-config.ts";
import { BodyTooLargeError, readBody } from "./workflow-api-http.ts";

/** A fetch-style handler. Module-private: `serveFetch` is the only consumer. */
type FetchHandler = (req: Request) => Promise<Response>;

/** One node header entry as zero or more `[name, value]` pairs. */
function toHeaderPairs(key: string, value: string | string[] | undefined): [string, string][] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((one) => [key, one]);
  return [[key, value]];
}

/**
 * Build a `Request` from a node request, body included.
 *
 * **The body is bounded AS IT IS READ, by `readBody`.** It used to be an
 * unbounded `for await` + `Buffer.concat`, with the caller's cap applied to the
 * finished string — so on the one unauthenticated public route in the product
 * (`/.well-known/workflow/v1/webhook/:token`) an attacker chose how many bytes
 * of this process's memory to spend, and three copies of them were resident
 * (the chunk list, the concatenation, the decoded string) before any 413 could
 * be produced. `readBody` counts per chunk, never from `Content-Length` — which
 * the sender controls independently of what it actually sends — and drops the
 * overflow rather than retaining it.
 *
 * `maxBodyBytes` is optional because the two doors differ: the webhook declares
 * the cap it publishes, and the platform's delivery door has never had one.
 * Absent, this reads the whole body, which is the behaviour that door has
 * always had — it is not a bound anybody chose, and giving it one is a change
 * to `workflow-serve.ts`'s contract rather than to this shim.
 */
async function toFetchRequest(req: IncomingMessage, maxBodyBytes?: number): Promise<Request> {
  const body = await readBody(req, maxBodyBytes ?? Number.POSITIVE_INFINITY);
  // The absolute URL is required by `Request` and is otherwise unused — these
  // handlers route on the path they were already given, not on the host.
  return new Request(`http://guest.local${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers: Object.entries(req.headers).flatMap(([key, value]) => toHeaderPairs(key, value)),
    // A GET/HEAD may carry no body at all, and `duplex` is required whenever
    // one is present.
    ...(body.length > 0 ? { body, duplex: "half" } : {}),
  } as RequestInit);
}

/**
 * Run a fetch-style handler against a node request/response pair.
 *
 * **`failureStatus` is a parameter because the two callers want OPPOSITE
 * answers, and one of them is a retry loop either way.** A queue callback wants
 * 500: the world retries a 5xx, which is how a transient fault gets another
 * attempt. The webhook route wants 502 at most for a genuine fault but must
 * never answer 5xx for an ordinary miss — its caller is a third party whose
 * retry loop reads 5xx as "come back", so the miss is a 404 decided inside the
 * handler and never reaches here.
 */
export async function serveFetch(
  handler: FetchHandler,
  req: IncomingMessage,
  res: ServerResponse,
  opts: { logger: Logger; label: string; failureStatus: number; maxBodyBytes?: number },
): Promise<void> {
  try {
    const response = await handler(await toFetchRequest(req, opts.maxBodyBytes));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err: unknown) {
    // A body over the cap is the CALLER's mistake and gets the caller's status,
    // never `failureStatus`: a 5xx here would tell a third party's retry loop to
    // send the same oversized body again, forever. Logged at debug for the same
    // reason — it is not a fault of this process, and the route is public, so a
    // stranger must not be able to fill an operator's error log.
    if (err instanceof BodyTooLargeError) {
      opts.logger.debug?.(`${opts.label} refused an oversized body`, {
        limit: opts.maxBodyBytes,
      });
      if (!res.headersSent) res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    // Answered rather than rethrown: a rejection here would surface as an
    // unhandled rejection and take the guest down mid-run.
    opts.logger.error?.(`${opts.label} failed`, { error: errorMessage(err) });
    if (!res.headersSent) {
      res.writeHead(opts.failureStatus, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: `${opts.label} failed` }));
  }
}
