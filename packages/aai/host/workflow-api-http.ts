// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow API's HTTP plumbing: JSON replies, the constant-time bearer gate,
 * and the size-capped body reader.
 *
 * Split out of `workflow-api.ts` when it reached the 500-line cap, on the seam
 * that was already there — nothing here knows what a workflow is, and every
 * function would read the same for any small JSON surface. What it leaves behind
 * is a module that is only about runs.
 *
 * The body reader is the piece worth not re-deriving: it refuses a stream AS IT
 * ARRIVES rather than trusting `Content-Length`, because a lying header is exactly
 * what a cap has to survive.
 */

import { timingSafeEqual } from "node:crypto";
import type http from "node:http";

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Constant-time bearer check.
 *
 * Length is compared first because `timingSafeEqual` THROWS on a length
 * mismatch rather than returning false — and comparing lengths leaks only the
 * length, which a caller supplied anyway.
 */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Read a request body, refusing anything past `limit`.
 *
 * Two decisions here, and both were arrived at by getting them wrong first.
 *
 * The size is counted **per chunk, never from `Content-Length`** — a client
 * controls that header independently of what it actually sends, so trusting it
 * means a lying header buffers the whole stream before anyone notices.
 *
 * And an over-limit body is **discarded as it arrives rather than answered by
 * destroying the socket**. What the cap has to bound is MEMORY, and dropping the
 * chunks does that completely; destroying the request additionally stops the
 * upload, which sounds strictly better and costs the thing that matters — the
 * client gets a socket error instead of the 413. For a page uploading a
 * recording in chunks that is the difference between "this file is too big" and
 * "something went wrong", so the bytes already in flight are allowed to arrive
 * and be thrown away. An endless upload is bounded by Node's own
 * `server.requestTimeout`.
 */
export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] | null = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Released here, not at `end`: holding a limit's worth of buffer for the
        // rest of a large upload is the allocation this is meant to prevent.
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

/** `POST /workflows/runs` — start a run and answer 202 with its id. */
