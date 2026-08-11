// Copyright 2026 the AAI authors. MIT license.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ensureProjectShape,
  scaffoldDir,
  WORKSPACE_DEPENDENCIES,
  workspaceTsconfig,
} from "./studio-project-shape.ts";

/** The scaffold's real files, read from the templates package in-repo. */
const scaffold = (file: string) =>
  readFile(path.resolve(import.meta.dirname, "../aai-templates/scaffold", file), "utf-8");

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
      dependencies?: Record<string, string>;
    };
    expect(pkg.type).toBe("module");
    // EMPTY, deliberately. The platform's packages resolve from the toolchain
    // above the workspace, and declaring them made `npm install` re-fetch the
    // whole SDK tree (25s / 156 MB against 451ms / 28 KB). What the agent may
    // import is stated by the studio prompt; what a pulled project needs is
    // filled in from the scaffold by `mergeScaffoldManifest`.
    expect(pkg.dependencies).toEqual({});
  });

  test("tsconfig excludes tests and pins node types (studio variant)", async () => {
    const parsed = JSON.parse(workspaceTsconfig(await scaffold("tsconfig.json"))) as {
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

/**
 * The workspace's two deliberate DELTAS from the scaffold. There is no drift
 * guard any more and no need for one: `ensureProjectShape` copies the
 * scaffold's real files out of the baked toolchain, so the only thing that
 * can differ is what this module changes on purpose.
 */
describe("scaffold deltas", () => {
  test("keeps every compiler option the scaffold sets, except `types`", async () => {
    type Opts = Record<string, unknown>;
    const of = (text: string) => (JSON.parse(text) as { compilerOptions: Opts }).compilerOptions;
    const theirs = of(await scaffold("tsconfig.json"));
    const mine = of(workspaceTsconfig(await scaffold("tsconfig.json")));
    // Soft: a scaffold change usually moves several options at once, and one
    // hard failure would hide the rest behind a second run.
    for (const key of Object.keys(theirs)) {
      if (key === "types") continue;
      expect.soft(mine[key], key).toEqual(theirs[key]);
    }
    expect(mine.types).toEqual(["node"]);
  });

  test("the platform-owned set still matches the scaffold's runtime dependencies", async () => {
    const { dependencies = {} } = JSON.parse(await scaffold("package.json")) as {
      dependencies?: Record<string, string>;
    };
    // The workspace manifest no longer declares these, but the set is still a
    // contract: `update_dependencies` refuses to bump one a workspace names by
    // hand, so a package added to the scaffold and missed here would become
    // bumpable out from under the baked copy.
    expect([...WORKSPACE_DEPENDENCIES].sort()).toEqual(Object.keys(dependencies).sort());
  });

  test("resolves the scaffold shipped inside the CLI tarball", () => {
    // The path the guest reads in production. Null when the toolchain is
    // absent — a degraded mode nothing downstream survives anyway.
    expect(scaffoldDir("/opt/aai/node_modules")).toBe(
      "/opt/aai/node_modules/@alexkroman1/aai-cli/dist/scaffold",
    );
    expect(scaffoldDir(null)).toBeNull();
  });
});
