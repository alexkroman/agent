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
import { afterEach, describe, expect, test, vi } from "vitest";
import { isPathInside, serveStatic } from "./server-static.ts";

const quietLogger = () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() });

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
    void serveStatic(clientDir, req, res, quietLogger()).then((claimed) => {
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
