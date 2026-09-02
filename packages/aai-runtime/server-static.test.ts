// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the static-asset path, at the level `server.test.ts` cannot reach.
 *
 * That suite drives `createServer`, which always hands `serveStatic` whatever
 * the caller put in `clientDir` — and every in-repo caller passes an absolute
 * path, so the one thing the containment check can get wrong about a RELATIVE
 * one is invisible from up there. `clientDir` is a `@public` option that states
 * no absolute-path requirement, so this is the contract, not an edge case.
 *
 * Driven through a REAL `node:http` server for the reason `workflow-serve.test.ts`
 * gives: `serveStatic` writes headers and pipes a read stream into the response,
 * and a hand-built `ServerResponse` cannot be produced without a cast — which is
 * the signal that the fake is the wrong tool.
 */

import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { isPathInside, serveStatic } from "./server-static.ts";

let dir: string | null = null;
let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = null;
});

/** A temp directory holding one asset, and the absolute path to it. */
async function assetDir(): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-static-test-"));
  await fs.writeFile(path.join(dir, "index.html"), "<html>root</html>");
  return dir;
}

/**
 * Serve `clientDir` and answer 404 for anything `serveStatic` declines — the
 * same shape `createServer` gives it, so a decline is observable as a status.
 */
async function serving(clientDir: string): Promise<string> {
  const server = http.createServer((req, res) => {
    void serveStatic(clientDir, req, res, makeLogger()).then((claimed) => {
      if (!claimed) res.writeHead(404).end("unclaimed");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("isPathInside", () => {
  test("admits the directory itself and strict descendants", () => {
    expect(isPathInside("/app/static", "/app/static")).toBe(true);
    expect(isPathInside("/app/static", path.join("/app/static", "a.js"))).toBe(true);
  });

  test("refuses a sibling sharing the prefix", () => {
    // The classic containment bug a bare `startsWith` has.
    expect(isPathInside("/app/static", "/app/static-secrets/keys")).toBe(false);
  });

  test("refuses an UNCOLLAPSED traversal in the target", () => {
    // Fail-OPEN in the pure-string version: `"/app/../etc/passwd"` starts with
    // `"/app/"`, and `startsWith` has no notion of a segment. Every caller
    // happened to `path.join` first, which collapsed the `..` before it got
    // here — so the hole was masked by caller discipline, not closed.
    expect(isPathInside("/app", "/app/../etc/passwd")).toBe(false);
    expect(isPathInside("/app", "/app/../app-evil/x")).toBe(false);
    // A `..` that stays inside is still inside.
    expect(isPathInside("/app", "/app/sub/../x")).toBe(true);
  });

  test("the verdict does not depend on how the ROOT is spelled", () => {
    // The fail-CLOSED half, and the one the three open-coded copies shipped:
    // `isPathInside("/a/b/", "/a/b/c.ts")` was `false`, so
    // `resolveInside("/a/b/", "c.ts")` threw "Path escapes the workspace" for a
    // path plainly inside the workspace.
    for (const root of ["/a/b", "/a/b/", "/a/b/.", "/a/b//", "/a/./b", "/a/x/../b"]) {
      expect(isPathInside(root, "/a/b/c.ts")).toBe(true);
      expect(isPathInside(root, "/a/b-evil/c.ts")).toBe(false);
    }
  });

  test("a filesystem root contains everything under it", () => {
    // `root + path.sep` is `"//"` when the root IS the separator, which nothing
    // starts with — so the naive prefix made every absolute path OUTSIDE `/`.
    expect(isPathInside("/", "/etc/passwd")).toBe(true);
    expect(isPathInside("/", "/")).toBe(true);
  });

  test("a relative root resolves against cwd rather than never matching", () => {
    expect(isPathInside("static", path.join(process.cwd(), "static", "a.js"))).toBe(true);
    expect(isPathInside("static", path.join(process.cwd(), "static-evil", "a.js"))).toBe(false);
  });
});

/**
 * The containment predicate against an INDEPENDENT decision procedure.
 *
 * `path.relative(path.resolve(dir), path.resolve(abs))` is neither absolute nor
 * `..`-prefixed exactly when `abs` is inside `dir` — a different mechanism from
 * the prefix test under scrutiny, so agreement between the two is evidence
 * rather than a restatement. Segments include the whole family a traversal is
 * spelled with (`..`, `.`, empty, the percent-encoded `%2e%2e`, a backslash, a
 * NUL, a non-ASCII char), and the ROOT's spelling is generated beside them —
 * that metamorphic half is what nothing covered, and it is where all three
 * copies of this predicate were wrong.
 *
 * Note `%2e%2e` and `a\b` are ordinary FILENAMES on POSIX: decoding is
 * `serveStatic`'s job, before the join, and a predicate that treated them as
 * traversals would be wrong in the other direction.
 */
describe("isPathInside vs. an independent oracle", () => {
  /** Inside iff the relative path neither leaves the root nor is absolute. */
  const oracle = (dir: string, target: string): boolean => {
    const rel = path.relative(path.resolve(dir), path.resolve(target));
    if (rel === "") return true;
    return !(path.isAbsolute(rel) || rel.split(path.sep).includes(".."));
  };

  const SEGMENT = fc.constantFrom(
    "..",
    ".",
    "",
    "%2e%2e",
    "a\\b",
    "é",
    "a\0b",
    "sub",
    "static",
    "static-secrets",
  );
  /** Spellings of ONE logical root — the verdict may not vary across them. */
  const ROOT_SPELLINGS = ["/app/static", "/app/static/", "/app/static/.", "/app/static//"];

  test("agrees with the oracle, whatever the root's spelling", () => {
    let inside = 0;
    let outside = 0;
    fc.assert(
      fc.property(fc.array(SEGMENT, { minLength: 1, maxLength: 6 }), (segments) => {
        // Joined RAW, not through `path.join`: a pre-collapsed target cannot
        // exercise the uncollapsed-traversal case at all, which is precisely the
        // one the string version got wrong.
        const target = `/app/static/${segments.join("/")}`;
        const want = oracle("/app/static", target);
        if (want) inside++;
        else outside++;
        for (const root of ROOT_SPELLINGS) {
          expect(isPathInside(root, target), `root=${root} target=${target}`).toBe(want);
        }
      }),
      { numRuns: 400 },
    );
    // Floors, because an all-green property proves nothing about a state the
    // generator never entered — and both verdicts have to be reached or this is
    // asserting one branch. `> 0` rather than a measured range: what matters is
    // that neither state is unreachable, not how often each is drawn.
    expect(inside).toBeGreaterThan(0);
    expect(outside).toBeGreaterThan(0);
  });

  test("agrees with the oracle on a relative root too", () => {
    fc.assert(
      fc.property(fc.array(SEGMENT, { minLength: 1, maxLength: 4 }), (segments) => {
        const target = path.join(process.cwd(), "static", segments.join("/"));
        for (const root of ["static", "./static", "static/", path.join(process.cwd(), "static")]) {
          expect(isPathInside(root, target), `root=${root} target=${target}`).toBe(
            oracle(root, target),
          );
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("serveStatic", () => {
  test("serves an asset when clientDir is RELATIVE", async () => {
    // The regression: the join used the caller's `dir` while the containment
    // check used `path.resolve(dir)`, so a relative directory compared a
    // relative path against an absolute root, failed containment, and 404'd
    // every asset — with no log line, because falling through is how a genuine
    // miss is reported.
    const relative = path.relative(process.cwd(), await assetDir());
    expect(path.isAbsolute(relative)).toBe(false);

    const base = await serving(relative);
    const res = await fetch(`${base}/index.html`);
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("<html>root</html>");
  });

  test("still refuses a traversal out of a relative clientDir", async () => {
    const relative = path.relative(process.cwd(), await assetDir());
    const base = await serving(relative);
    // Encoded, so the client does not normalize it away before it is sent.
    expect((await fetch(`${base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`)).status).toBe(404);
  });

  test("declines a malformed percent escape rather than throwing", async () => {
    const base = await serving(await assetDir());
    const res = await fetch(`${base}/%`);
    expect(res.status).toBe(404);
    await expect(res.text()).resolves.toBe("unclaimed");
  });
});
