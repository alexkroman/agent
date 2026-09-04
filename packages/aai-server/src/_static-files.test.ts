// Copyright 2026 the AAI authors. MIT license.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createCachedDirReader, isPathInside } from "./_static-files.ts";

describe("isPathInside", () => {
  const dir = path.join(path.sep, "srv", "dist");

  test("accepts the directory itself and paths inside it", () => {
    expect(isPathInside(dir, dir)).toBe(true);
    expect(isPathInside(dir, path.join(dir, "index.html"))).toBe(true);
    expect(isPathInside(dir, path.join(dir, "assets", "app.js"))).toBe(true);
  });

  test("rejects a sibling directory sharing the prefix", () => {
    // The `startsWith(baseDir)` bug: "/srv/dist-evil" starts with "/srv/dist"
    // but is not inside it.
    expect(isPathInside(dir, `${dir}-evil`)).toBe(false);
    expect(isPathInside(dir, path.join(`${dir}-evil`, "secret.txt"))).toBe(false);
  });

  test("rejects paths outside the directory", () => {
    expect(isPathInside(dir, path.dirname(dir))).toBe(false);
    expect(isPathInside(dir, path.join(path.sep, "etc", "passwd"))).toBe(false);
  });
});

describe("createCachedDirReader", () => {
  let root: string;
  let baseDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aai-static-"));
    baseDir = path.join(root, "dist");
    await mkdir(baseDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("reads a file inside the directory", async () => {
    await writeFile(path.join(baseDir, "index.html"), "<html></html>", "utf-8");
    const read = createCachedDirReader(() => baseDir);
    expect((await read("index.html"))?.toString("utf-8")).toBe("<html></html>");
  });

  test("caches hits but not misses", async () => {
    const read = createCachedDirReader(() => baseDir);
    // Miss first: the file lands later (parallel build) and must be found.
    expect(await read("late.js")).toBe(null);
    await writeFile(path.join(baseDir, "late.js"), "v1", "utf-8");
    expect((await read("late.js"))?.toString("utf-8")).toBe("v1");
    // Hit is cached: a rewrite on disk does not change what is served.
    await writeFile(path.join(baseDir, "late.js"), "v2", "utf-8");
    expect((await read("late.js"))?.toString("utf-8")).toBe("v1");
  });

  test("never serves a sibling directory sharing the base-dir prefix", async () => {
    // Regression: `fullPath.startsWith(baseDir)` admitted `<baseDir>-evil`.
    const evil = `${baseDir}-evil`;
    await mkdir(evil, { recursive: true });
    await writeFile(path.join(evil, "secret.txt"), "leaked", "utf-8");
    const read = createCachedDirReader(() => baseDir);
    expect(await read(path.join("..", "dist-evil", "secret.txt"))).toBe(null);
  });

  test("never serves a path escaping the directory", async () => {
    await writeFile(path.join(root, "outside.txt"), "outside", "utf-8");
    const read = createCachedDirReader(() => baseDir);
    expect(await read(path.join("..", "outside.txt"))).toBe(null);
  });
});
