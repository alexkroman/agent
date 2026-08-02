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
  WORKSPACE_VITEST_CONFIG,
} from "./studio-project-shape.ts";

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("ensureProjectShape", () => {
  test("writes the missing project files", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aai-shape-"));
    await ensureProjectShape(dir);
    for (const rel of [
      "package.json",
      "tsconfig.json",
      "global.d.ts",
      "vite.config.ts",
      "vitest.config.ts",
    ]) {
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
      compilerOptions: Record<string, unknown> & { types: string[] };
      exclude: string[];
    };
    expect(parsed.compilerOptions.strict).toBe(true);
    expect(parsed.compilerOptions.types).toEqual(["node"]);
    expect(parsed.exclude).toContain("**/*.test.ts");
    // Deliberate: implicit-any diagnostics are churn on an `any` receiver and
    // catch nothing. See the WORKSPACE_TSCONFIG doc.
    expect(parsed.compilerOptions.noImplicitAny).toBe(false);
    expect(parsed.compilerOptions.useUnknownInCatchVariables).toBe(false);
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

  /**
   * Compared on the config body, not byte for byte: the scaffold's copy
   * carries a long doc comment explaining why the test config is separate
   * from the vite one, which a generated workspace does not need.
   */
  test("vitest config enables globals, in both copies", async () => {
    const body = (text: string) => text.slice(text.indexOf("export default"));
    expect(body(WORKSPACE_VITEST_CONFIG)).toBe(body(await scaffold("vitest.config.ts")));
    expect(WORKSPACE_VITEST_CONFIG).toContain("globals: true");
    // It must not import the client build's plugins — that is the whole
    // reason it exists apart from vite.config.ts.
    expect(WORKSPACE_VITEST_CONFIG).not.toContain("plugin-react");
    expect(WORKSPACE_VITEST_CONFIG).not.toContain("tailwindcss");
  });

  /**
   * The tsconfigs differ deliberately (`types`, `exclude`), so they cannot be
   * compared byte for byte — but the settings that decide whether a given file
   * type-checks must agree, or a workspace that builds in the studio fails
   * `aai build` on the user's laptop after they export it.
   */
  test("tsconfig strictness matches the scaffold's", async () => {
    type Opts = Record<string, unknown>;
    const of = (text: string) => (JSON.parse(text) as { compilerOptions: Opts }).compilerOptions;
    const mine = of(WORKSPACE_TSCONFIG);
    const theirs = of(await scaffold("tsconfig.json"));
    const shared = [
      "strict",
      "noImplicitAny",
      "useUnknownInCatchVariables",
      "verbatimModuleSyntax",
      "target",
      "lib",
      "jsx",
    ];
    for (const key of shared) {
      expect({ [key]: mine[key] }).toEqual({ [key]: theirs[key] });
    }
  });
});
