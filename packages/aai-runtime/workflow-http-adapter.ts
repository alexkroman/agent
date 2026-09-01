// Copyright 2026 the AAI authors. MIT license.
/**
 * A `node:http` ↔ `fetch` adapter for the workflow routes.
 *
 * Its own module because two callers with different LIFETIMES need it, and
 * putting it with either would tie the other to that one's fate: the webhook
 * route (`server.ts`) is permanent, and the queue callbacks
 * (`workflow-serve.ts`) go with the DevKit.
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

/**
 * A fetch-style handler.
 *
 * @internal
 */
export type FetchHandler = (req: Request) => Promise<Response>;

/** One node header entry as zero or more `[name, value]` pairs. */
function toHeaderPairs(key: string, value: string | string[] | undefined): [string, string][] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((one) => [key, one]);
  return [[key, value]];
}

/** Build a `Request` from a node request, body included. */
export async function toFetchRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
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
  opts: { logger: Logger; label: string; failureStatus: number },
): Promise<void> {
  try {
    const response = await handler(await toFetchRequest(req));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err: unknown) {
    // Answered rather than rethrown: a rejection here would surface as an
    // unhandled rejection and take the guest down mid-run.
    opts.logger.error?.(`${opts.label} failed`, { error: errorMessage(err) });
    if (!res.headersSent) {
      res.writeHead(opts.failureStatus, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: `${opts.label} failed` }));
  }
}
