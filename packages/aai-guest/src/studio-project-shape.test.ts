// Copyright 2026 the AAI authors. MIT license.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { useTempDir } from "./_test-utils.ts";
import {
  ensureProjectShape,
  scaffoldDir,
  WORKSPACE_DEPENDENCIES,
  workspaceTsconfig,
} from "./studio-project-shape.ts";

/** The scaffold's real files, read from the templates package in-repo. */
const scaffold = (file: string) =>
  readFile(path.resolve(import.meta.dirname, "../../aai-templates/scaffold", file), "utf-8");

/**
 * Scaffold dependencies the platform does NOT own yet — the one legitimate
 * asymmetry in the set below.
 *
 * `workflow` is in the scaffold because a laptop project needs it: `aai init -t
 * research-workflow` writes a `workflows/` directory that imports it, and without
 * the declaration the build dies on `Could not resolve "workflow"`. It is not
 * baked into the guest image because the guest cannot serve workflows yet —
 * `GUEST_ROUTE_EXPOSURE` still declares the three routes `host-only` — and the
 * package installs **223 MB** (its nestjs/sveltekit/next adapters, the TS
 * plugin, date-fns, the aws smithy tree), which is not a cost to pay on every
 * sandbox for a path nothing reaches.
 *
 * DELETE this set when the guest path lands: adding both to
 * `WORKSPACE_DEPENDENCIES` and to `toolchain/package.json` is what puts a copy
 * where `rewriteWorkflowImports` can resolve it, and this test is what will say
 * so.
 *
 * `@workflow/world-postgres` joins it for the same reason and travels with
 * `workflow`: it is what `getWorld()` imports for a project with a
 * `DATABASE_URL`, and it reaches a project only through `@alexkroman1/aai` —
 * which npm hoists and pnpm does not, so a scaffolded pnpm project has to
 * declare it or its first run dies on
 * `Cannot find module '@workflow/world-postgres'`.
 */
const NOT_YET_PLATFORM_OWNED = new Set(["workflow", "@workflow/world-postgres"]);

/**
 * One `let dir` used to be shared by both `describe` blocks here, assigned by
 * exactly one test in the first: the file-level `afterEach` then re-`rm`'d that
 * one already-deleted path after every test in the second block, and cleaned up
 * nothing of its own. Creating the directory and its cleanup together is what
 * removes the possibility.
 */
const tempDir = useTempDir("aai-shape-");

describe("ensureProjectShape", () => {
  test("writes the missing project files", async () => {
    const dir = tempDir();
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
    // `noImplicitAny` is NOT turned off here or in the scaffold: switching it
    // off also disables evolving-array/evolving-let inference, which is the
    // more expensive failure. See the WORKSPACE_TSCONFIG doc.
    expect(parsed.compilerOptions.noImplicitAny).toBeUndefined();
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
    expect([...WORKSPACE_DEPENDENCIES].sort()).toEqual(
      Object.keys(dependencies)
        .filter((name) => !NOT_YET_PLATFORM_OWNED.has(name))
        .sort(),
    );
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
