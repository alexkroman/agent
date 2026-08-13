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

/** Write a JSON body and end the response. */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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
  res: http.ServerResponse,
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
