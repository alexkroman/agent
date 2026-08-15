// Copyright 2026 the AAI authors. MIT license.
/**
 * Serving an agent's static client assets from disk.
 *
 * Split out of `server.ts` when that file reached the 500-line cap, on a seam
 * that was already there: nothing here knows what an agent is, and every
 * decision in it is about a FILE — where a URL resolves to, whether that path
 * escaped the directory, and what to do once the headers are out.
 *
 * The containment check is the part worth not re-deriving, and it has two
 * halves. Decoding happens BEFORE the join, so an encoded traversal
 * (`%2e%2e%2f`) decodes to `..`, collapses in `path.join`, and is caught the
 * same way a literal one is. And BOTH sides of the comparison come off the
 * RESOLVED root — it is a pure string check, so a relative `clientDir` compared
 * against its own resolved form fails containment for every asset.
 */

import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { lookup as mimeLookup } from "mime-types";
import { requestPath } from "../sdk/request-url.ts";
import { errorMessage } from "../sdk/utils.ts";
import { decodePathSegment } from "./_path-decode.ts";
import type { Logger } from "./runtime-config.ts";

/**
 * Separator-safe containment: `target` is `dir` itself or strictly inside it.
 *
 * A bare `target.startsWith(dir)` also admits sibling directories sharing the
 * prefix (`<dir>-evil`) — the classic path-containment bug. Both paths must
 * already be resolved; this is a pure string check.
 *
 * @internal
 */
export function isPathInside(dir: string, target: string): boolean {
  return target === dir || target.startsWith(dir + path.sep);
}

/**
 * Serve `dir`'s file for this request, resolving whether it CLAIMED the
 * response.
 *
 * Only pre-response failures (ENOENT, EACCES, a directory) resolve false — the
 * caller then writes the 404. Once headers go out, every failure is handled
 * here, because falling through would write on a broken response.
 *
 * @internal
 */
export async function serveStatic(
  dir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  logger: Logger,
): Promise<boolean> {
  const url = requestPath(req.url);
  // Percent-decode so assets with spaces or non-ASCII names resolve (browsers
  // request them encoded). A malformed escape is not a path — `decodePathSegment`
  // answers undefined and this reads as not-found rather than crashing the
  // request. Decoding happens BEFORE the join + containment check below, so an
  // encoded traversal (`%2e%2e%2f`) decodes to `..`, collapses in `path.join`,
  // and is caught by `isPathInside` like a literal one.
  const pathname = decodePathSegment(url);
  if (pathname === undefined) return false;

  // Resolved FIRST, and the join is off the resolved root — the containment
  // check compares two paths, so both have to be absolute. Joining onto a
  // relative `clientDir` and comparing against `path.resolve(dir)` made every
  // asset fail containment and 404 with no log line, for a `@public` option
  // whose doc states no absolute-path requirement. Resolving also avoids prefix
  // collisions (dir="/app/static" matching "/app/static-secrets/…").
  const root = path.resolve(dir);
  const filePath = path.join(root, pathname === "/" ? "index.html" : pathname);
  if (!isPathInside(root, filePath)) return false;

  // Only pre-response failures (ENOENT, EACCES, a directory) return false —
  // the caller then writes the 404. Once headers go out below, every failure
  // must be handled here: falling through would write on a broken response.
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(filePath).toLowerCase();
  const mime = mimeLookup(ext) || "application/octet-stream";
  try {
    res.writeHead(200, { "Content-Type": mime, "Content-Length": stat.size });
  } catch (err) {
    // Response already broken (headers sent / destroyed) — claim the request
    // so the caller doesn't try to write a 404 on it too.
    logger.error("serveStatic: response unusable", { error: errorMessage(err) });
    res.destroy();
    return true;
  }
  const stream = fs.createReadStream(filePath);
  stream.on("error", (err) => {
    // Headers are already sent — destroy so the client sees a truncated
    // body instead of a hang (and the read stream is released).
    logger.error("serveStatic: read stream failed", { error: errorMessage(err) });
    res.destroy(err);
  });
  stream.pipe(res);
  return true;
}
