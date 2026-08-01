// Copyright 2026 the AAI authors. MIT license.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ensureProjectShape,
  WORKSPACE_GLOBAL_DTS,
  WORKSPACE_TSCONFIG,
  WORKSPACE_VITE_CONFIG,
} from "./studio-project-shape.ts";

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("ensureProjectShape", () => {
  test("writes the missing project files", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aai-shape-"));
    await ensureProjectShape(dir);
    for (const rel of ["package.json", "tsconfig.json", "global.d.ts", "vite.config.ts"]) {
      await expect(readFile(path.join(dir, rel), "utf-8")).resolves.toBeTruthy();
    }
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf-8")) as {
      type?: string;
    };
    expect(pkg.type).toBe("module");
  });

  test("never overwrites files the workspace already has", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aai-shape-"));
    await writeFile(path.join(dir, "tsconfig.json"), "{}", "utf-8");
    await ensureProjectShape(dir);
    // The coding agent's own tsconfig wins, exactly as a CLI user's would.
    await expect(readFile(path.join(dir, "tsconfig.json"), "utf-8")).resolves.toBe("{}");
  });

  test("tsconfig excludes tests and pins node types (studio variant)", () => {
    const parsed = JSON.parse(WORKSPACE_TSCONFIG) as {
      compilerOptions: { types: string[]; strict: boolean };
      exclude: string[];
    };
    expect(parsed.compilerOptions.strict).toBe(true);
    expect(parsed.compilerOptions.types).toEqual(["node"]);
    expect(parsed.exclude).toContain("**/*.test.ts");
  });
});

describe("scaffold parity (drift guard)", () => {
  const scaffold = (file: string) =>
    readFile(path.resolve(import.meta.dirname, "../aai-templates/scaffold", file), "utf-8");

  test("vite.config.ts matches the scaffold's byte for byte", async () => {
    await expect(scaffold("vite.config.ts")).resolves.toBe(WORKSPACE_VITE_CONFIG);
  });

  test("global.d.ts matches the scaffold's byte for byte", async () => {
    await expect(scaffold("global.d.ts")).resolves.toBe(WORKSPACE_GLOBAL_DTS);
  });
});
