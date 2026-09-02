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
import { requestPath } from "@alexkroman1/aai/host-internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import { lookup as mimeLookup } from "mime-types";
import { decodePathSegment } from "./_path-decode.ts";
import type { Logger } from "./runtime-config.ts";

/**
 * Separator-safe containment: `target` is `dir` itself or strictly inside it.
 *
 * A bare `target.startsWith(dir)` also admits sibling directories sharing the
 * prefix (`<dir>-evil`) — the classic path-containment bug, which is what the
 * `+ path.sep` is for.
 *
 * ## It NORMALIZES both sides, and the precondition it used to state is why
 *
 * This was a pure string check whose doc said "both paths must already be
 * resolved". Nothing enforced that and three call sites had open-coded copies of
 * the line, so the precondition was a comment in one file governing code in
 * three. It failed in BOTH directions:
 *
 * - **Fail-closed, on the root's SPELLING.** A trailing separator, a `.`
 *   segment, or a relative root inverted every verdict: `isPathInside("/a/b/",
 *   "/a/b/c.ts")` was `false`, so `resolveInside("/a/b/", "c.ts")` threw "Path
 *   escapes the workspace" for a path plainly inside it. `serveStatic` below has
 *   already paid for this once — a relative `clientDir` 404'd every asset with no
 *   log line — and fixed it at its own call site, which is the shape of a
 *   predicate that should have owned the normalization.
 * - **Fail-OPEN, on a `..` in the target.** `isPathInside("/app",
 *   "/app/../etc/passwd")` returned **true**: the string starts with `/app/`, and
 *   a raw `startsWith` has no notion of a segment. Every caller happens to
 *   `path.join` or `path.resolve` first, which collapses the `..` before it gets
 *   here — so the hole is masked by caller discipline rather than closed, and it
 *   is the next caller that pays.
 *
 * `path.resolve` is idempotent on an already-resolved path, so normalizing costs
 * nothing where the precondition was already met and is the whole fix where it
 * was not. A RELATIVE argument resolves against `process.cwd()`, which is the
 * only defensible reading of a relative containment question.
 *
 * The verdict must not depend on how the root is SPELLED — that metamorphic
 * property is what the spec asserts, against `path.relative` as an independent
 * oracle.
 *
 * @internal
 */
export function isPathInside(dir: string, target: string): boolean {
  const root = path.resolve(dir);
  const abs = path.resolve(target);
  // A filesystem root already ends in the separator (`/`, `C:\`), and appending
  // a second one makes nothing inside it — including every absolute path.
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return abs === root || abs.startsWith(prefix);
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
