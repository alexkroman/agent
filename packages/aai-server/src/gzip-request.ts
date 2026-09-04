// Copyright 2025 the AAI authors. MIT license.
/**
 * Transparent gzip request-body decompression middleware.
 *
 * The CLI gzips deploy uploads (worker + client files compress ~4-5x).
 * This middleware inflates a `Content-Encoding: gzip` body before any
 * downstream JSON parsing (zValidator), and rewrites `c.req.raw` so the
 * rest of the pipeline sees a plain JSON request.
 *
 * Zip-bomb guard, both axes:
 * - COMPRESSED bytes are capped while buffering: a declared Content-Length
 *   over the cap is rejected before the body is read at all, and the actual
 *   stream is counted chunk-by-chunk so an unbounded (or lying) sender can
 *   never balloon host memory past the cap.
 * - DECOMPRESSED bytes are capped via zlib's `maxOutputLength`, which aborts
 *   inflation the moment the output would exceed the cap — a tiny compressed
 *   payload cannot balloon past `MAX_INFLATED_BODY_BYTES` in memory.
 * Oversized bodies get a 413, matching the CLI's "bundle too large" hint.
 *
 * **What this middleware hands downstream is a synchronous STALL, and that is
 * worth knowing here because this is where the body becomes parseable.**
 * `zValidator` then runs `JSON.parse` over up to {@link MAX_INFLATED_BODY_BYTES},
 * which is hundreds of milliseconds during which this replica answers no health
 * check, brokers no session, and relays no SSE frame — so a deploy landing on a
 * replica is a latency event for every other tenant on it. `DEPLOY_BODY_CONCURRENCY`
 * bounds how many of those stalls OVERLAP; nothing makes one of them yield, and
 * nothing can short of a streaming parser. Tolerable for the reason that constant
 * is 2: a deploy is rare and human-initiated. Recorded because the ~164 MB figure
 * beside it reads as the whole cost and is not.
 */

import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { createMiddleware } from "hono/factory";
import { MAX_WORKER_SIZE } from "./constants.ts";
import type { HonoEnv } from "./context.ts";

const gunzipAsync = promisify(gunzip);

/**
 * Cap on the decompressed request body. A deploy body is JSON wrapping the
 * worker (schema-capped at MAX_WORKER_SIZE) plus client files and env, so
 * allow a few multiples of the worker cap. Anything larger is rejected with
 * 413 before it ever reaches JSON.parse or schema validation.
 *
 * The same value caps the COMPRESSED bytes: gzip never usefully expands its
 * input, so a compressed body larger than the inflated cap is oversized by
 * definition.
 */
export const MAX_INFLATED_BODY_BYTES = 4 * MAX_WORKER_SIZE;

function isOutputTooLarge(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ERR_BUFFER_TOO_LARGE";
}

/**
 * Buffer a request body while counting bytes; returns null the moment the
 * running total exceeds `maxBytes` (the stream is cancelled, not drained).
 *
 * **Preallocating from `Content-Length` was tried and is NOT here**, because the
 * copy it removes is the wrong one. A chunk list plus `Buffer.concat` does hold
 * the compressed bytes twice — but `DEPLOY_BODY_CONCURRENCY`'s own measurement
 * says a max-size deploy is **28 KB on the wire**, since the worker gzips
 * ~1000:1, so that second copy is tens of kilobytes and the ~164 MB it reports
 * is all downstream: the inflated buffer, the re-wrapped `Request`, and
 * `JSON.parse`'s UTF-16 string plus object graph. Allocating `Content-Length`
 * bytes up front would trade a 28 KB saving for a 120 MB allocation an
 * authenticated caller could trigger with a declared length and an empty body,
 * plus a lying-sender branch to get wrong. The single-chunk case below is the
 * part that is free.
 */
async function readBodyCapped(req: Request, maxBytes: number): Promise<Buffer | null> {
  const body = req.body;
  if (!body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  // `Buffer.concat` copies even for one chunk, and one chunk is the ordinary
  // case for a body this small — the CLI's gzipped deploy arrives well inside a
  // single read. `Buffer.from` over the existing memory rather than a copy of it.
  const only = chunks.length === 1 ? chunks[0] : undefined;
  if (only) return Buffer.from(only.buffer, only.byteOffset, only.byteLength);
  return Buffer.concat(chunks);
}

/**
 * Build the gzip request middleware with an explicit byte cap (compressed
 * and decompressed). Exported for tests; production uses {@link gzipRequestMw}
 * with the default cap.
 */
export function createGzipRequestMw(maxBytes: number = MAX_INFLATED_BODY_BYTES) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    const encoding = c.req.header("Content-Encoding")?.trim().toLowerCase();
    if (encoding === undefined || encoding === "" || encoding === "identity") {
      return next();
    }
    if (encoding !== "gzip") {
      return c.json({ error: `Unsupported Content-Encoding: ${encoding}` }, 415);
    }

    // Reject a declared oversize before reading a single body byte.
    const declared = Number(c.req.header("Content-Length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      return c.json({ error: "Request body too large" }, 413);
    }

    // Read the compressed bytes from the raw Request (not c.req.arrayBuffer(),
    // which would cache the compressed bytes as the parsed body), counting as
    // we go so a body without (or lying about) Content-Length is still capped.
    const compressed = await readBodyCapped(c.req.raw, maxBytes);
    if (compressed === null) {
      return c.json({ error: "Request body too large" }, 413);
    }
    let inflated: Buffer;
    try {
      inflated = await gunzipAsync(compressed, { maxOutputLength: maxBytes });
    } catch (err) {
      if (isOutputTooLarge(err)) {
        return c.json({ error: "Request body too large after decompression" }, 413);
      }
      return c.json({ error: "Invalid gzip request body" }, 400);
    }

    // Swap in an identical request carrying the inflated body so downstream
    // consumers (zValidator's c.req.json()) parse the real JSON.
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-encoding");
    headers.set("content-length", String(inflated.byteLength));
    c.req.raw = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: new Uint8Array(inflated),
    });

    await next();
  });
}

export const gzipRequestMw = createGzipRequestMw();
