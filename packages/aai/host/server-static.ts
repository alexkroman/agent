// Copyright 2026 the AAI authors. MIT license.
/**
 * Static asset serving for `createServer` — the `clientDir` half.
 *
 * Split out of `server.ts` when that file reached the 500-line cap, and it is the
 * right seam: everything here is about turning a URL into a file on disk safely,
 * and none of it knows what an agent or a session is. The path-containment rule
 * is the part worth keeping together with the serving.
 */

import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { lookup as mimeLookup } from "mime-types";
import { errorMessage } from "../sdk/utils.ts";
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

export async function serveStatic(
  dir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  logger: Logger,
): Promise<boolean> {
  const url = req.url?.split("?")[0] ?? "/";
  // Percent-decode so assets with spaces or non-ASCII names resolve (browsers
  // request them encoded). A malformed escape throws URIError — treat it as
  // not-found rather than crashing the request. Decoding happens BEFORE the
  // join + containment check below, so an encoded traversal (`%2e%2e%2f`)
  // decodes to `..`, collapses in `path.join`, and is caught by
  // `isPathInside` like a literal one.
  let pathname: string;
  try {
    pathname = decodeURIComponent(url);
  } catch {
    return false;
  }
  const filePath = path.join(dir, pathname === "/" ? "index.html" : pathname);

  // Resolve before the containment check to avoid prefix collisions
  // (e.g. dir="/app/static" matching "/app/static-secrets/…").
  const resolved = path.resolve(dir);
  if (!isPathInside(resolved, filePath)) return false;

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
