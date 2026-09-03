// Copyright 2026 the AAI authors. MIT license.
// Guest build helpers, SCENARIO tier: the build-dir lifecycle and the
// typecheck-first gate. These write files and spawn `tsc`, which is what puts
// them here rather than in the unit tier — the pure formatting and the
// toolchain search live in `studio-build.test.ts`.
//
// Full builds through the real bundlers are covered by aai-server's
// workspace-build-integration.test.ts; here we pin the failure paths the
// coding agent reads.

import { readdir } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { materialize } from "./_test-utils.ts";
import {
  buildWorkspaceDir,
  typecheckWorkspaceDir,
  withBuildDir,
  workspacesRoot,
} from "./studio-build.ts";
import { ensureWorkspaceDependencies } from "./studio-workspace-deps.ts";

// Mocked for both directions: it keeps a build here from ever spawning a real
// `npm install`, and it is the only way to drive the warning path without one.
// Its own behaviour is covered in studio-workspace-deps.test.ts.
vi.mock("./studio-workspace-deps.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./studio-workspace-deps.ts")>();
  return { ...mod, ensureWorkspaceDependencies: vi.fn(() => Promise.resolve(null)) };
});

describe("withBuildDir", () => {
  test("materializes into a fresh dir under the workspaces root and cleans up", async () => {
    let seen: string | undefined;
    const result = await withBuildDir(
      { "agent.ts": "export {};" },
      async (dir, files) => {
        seen = dir;
        await materialize(dir, files);
      },
      async (dir) => (await readdir(dir)).sort(),
    );
    expect(result).toEqual(["agent.ts"]);
    expect(seen).toContain(workspacesRoot());
    // Cleaned up even on success — a Publish build never lingers.
    await expect(readdir(seen as string)).rejects.toThrow();
  });

  test("cleans up when the build throws", async () => {
    let seen: string | undefined;
    await expect(
      withBuildDir(
        {},
        async (dir) => {
          seen = dir;
        },
        async () => {
          throw new Error("build exploded");
        },
      ),
    ).rejects.toThrow("build exploded");
    await expect(readdir(seen as string)).rejects.toThrow();
  });
});

describe("typecheckWorkspaceDir", () => {
  test("a workspace without a tsconfig skips rather than failing", async () => {
    const result = await withBuildDir({ "agent.ts": "export {};\n" }, materialize, (dir) =>
      typecheckWorkspaceDir(dir),
    );
    expect(result).toEqual({ ok: true, skipped: true });
  });

  test("type errors come back scrubbed and annotated, like a build's", async () => {
    const result = await withBuildDir(
      {
        "tsconfig.json": JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        }),
        "agent.ts": `export const n: number = "nope";\n`,
      },
      materialize,
      (dir) => typecheckWorkspaceDir(dir),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.output).toContain("agent.ts");
      expect(result.output).not.toContain(workspacesRoot());
    }
  });
});

describe("buildWorkspaceDir", () => {
  test("type errors fail the build with scrubbed diagnostics, before bundling", async () => {
    const result = await withBuildDir(
      {
        "tsconfig.json": JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        }),
        "agent.ts": `export const n: number = "nope";\n`,
      },
      materialize,
      (dir) => buildWorkspaceDir(dir, { worker: true, client: false }),
    );
    expect(result.worker).toBeUndefined();
    expect(result.buildError).toContain("Type check failed");
    expect(result.buildError).toContain("agent.ts");
    // The scratch path never reaches the coding agent.
    expect(result.buildError).not.toContain(workspacesRoot());
  });

  test("a dependency that would not install is named ahead of the failure it causes", async () => {
    // Without this the agent reads only the bundler's "failed to resolve
    // import", naming a package its own package.json plainly declares.
    vi.mocked(ensureWorkspaceDependencies).mockResolvedValueOnce("Could not install ms");
    const result = await withBuildDir(
      {
        // Same tsconfig as the test above, so this fails at the typecheck
        // gate rather than paying for a full (doomed) bundle.
        "tsconfig.json": JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        }),
        "agent.ts": `export const n: number = "nope";\n`,
      },
      materialize,
      (dir) => buildWorkspaceDir(dir, { worker: true, client: false }),
    );
    expect(result.buildError).toMatch(/^Could not install ms/);
  });
});
