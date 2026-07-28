// Copyright 2025 the AAI authors. MIT license.
/**
 * Transparent gzip request-body decompression middleware.
 *
 * The CLI gzips deploy uploads (worker + client files compress ~4-5x).
 * This middleware inflates a `Content-Encoding: gzip` body before any
 * downstream JSON parsing (zValidator), and rewrites `c.req.raw` so the
 * rest of the pipeline sees a plain JSON request.
 *
 * Zip-bomb guard: the size cap is enforced against the DECOMPRESSED byte
 * count via zlib's `maxOutputLength`, which aborts inflation the moment
 * the output would exceed the cap — a tiny compressed payload cannot
 * balloon past `MAX_INFLATED_BODY_BYTES` in memory. Oversized bodies get
 * a 413, matching the CLI's "bundle too large" hint.
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
 */
export const MAX_INFLATED_BODY_BYTES = 4 * MAX_WORKER_SIZE;

function isOutputTooLarge(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ERR_BUFFER_TOO_LARGE";
}

export const gzipRequestMw = createMiddleware<HonoEnv>(async (c, next) => {
  const encoding = c.req.header("Content-Encoding")?.trim().toLowerCase();
  if (encoding === undefined || encoding === "" || encoding === "identity") {
    return next();
  }
  if (encoding !== "gzip") {
    return c.json({ error: `Unsupported Content-Encoding: ${encoding}` }, 415);
  }

  // Read the compressed bytes from the raw Request (not c.req.arrayBuffer(),
  // which would cache the compressed bytes as the parsed body).
  const compressed = Buffer.from(await c.req.raw.arrayBuffer());
  let inflated: Buffer;
  try {
    inflated = await gunzipAsync(compressed, { maxOutputLength: MAX_INFLATED_BODY_BYTES });
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
