// Copyright 2026 the AAI authors. MIT license.

import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadScaffoldFiles, scaffoldDir } from "./studio-scaffold.ts";

describe("scaffoldDir", () => {
  test("resolves through the package graph to the real scaffold", () => {
    const dir = scaffoldDir();
    expect(path.basename(dir)).toBe("scaffold");
    expect(existsSync(path.join(dir, "package.json"))).toBe(true);
  });
});

describe("loadScaffoldFiles", () => {
  test("holds what a GitHub-synced project cannot run without", async () => {
    // Each of these is a failure a clone of a synced repository hit: no
    // scripts or toolchain in the manifest, and build output committable.
    const files = await loadScaffoldFiles();
    const manifest = JSON.parse(files["package.json"] ?? "{}");
    expect(manifest.scripts).toHaveProperty("dev");
    expect(manifest.dependencies).toHaveProperty("@alexkroman1/aai-cli");
    expect(files[".gitignore"]).toContain("node_modules");
    expect(files).toHaveProperty(".env.example");
  });

  test("never carries a local-only file, even if one is sitting in the checkout", async () => {
    const names = Object.keys(await loadScaffoldFiles());
    expect(names.filter((n) => n === ".env" || n.endsWith("lock.yaml"))).toEqual([]);
    expect(names.some((n) => n.startsWith("node_modules/") || n.startsWith(".aai/"))).toBe(false);
  });

  test("is read once and shared", () => {
    expect(loadScaffoldFiles()).toBe(loadScaffoldFiles());
  });
});
