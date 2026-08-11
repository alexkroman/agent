// Copyright 2026 the AAI authors. MIT license.
// Guest build helpers: diagnostic scrubbing, build-dir lifecycle, and the
// typecheck-first gate. Full builds through the real bundlers are covered by
// aai-server's workspace-build-integration.test.ts; here we pin the pure
// formatting and the failure paths the coding agent reads.

import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  buildWorkspaceDir,
  formatBuildFailure,
  scrubDir,
  toolchainModules,
  typecheckWorkspaceDir,
  withBuildDir,
  workspacesRoot,
} from "./studio-build.ts";
import { toolchainPromptSection } from "./studio-chat.ts";
import { ensureWorkspaceDependencies } from "./studio-workspace-deps.ts";

// Mocked for both directions: it keeps a build here from ever spawning a real
// `npm install`, and it is the only way to drive the warning path without one.
// Its own behaviour is covered in studio-workspace-deps.test.ts.
vi.mock("./studio-workspace-deps.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./studio-workspace-deps.ts")>();
  return { ...mod, ensureWorkspaceDependencies: vi.fn(() => Promise.resolve(null)) };
});

describe("toolchainModules", () => {
  // The prompt section the guest appends names these paths outright, and
  // bash is the only tool that can reach them (read_file is jailed to the
  // workspace; glob/grep skip node_modules). A path that does not resolve
  // surfaces to the agent only as "file not found".
  //
  // This replaced a check on a fixed `../../node_modules` depth relative to
  // the workspace. That depth is right in the Modal image (/opt/aai) and
  // wrong under the subprocess backend, whose harness runs from
  // packages/aai-guest/dist — and unit tests, which load this module from
  // source, see a THIRD layout where it happens to be right again. So the
  // test passed while the shipped prompt was wrong for local dev.
  const modulesDir = toolchainModules();

  test("finds the toolchain by searching upward, not by a fixed offset", () => {
    expect(modulesDir).not.toBeNull();
  });

  test.for([
    ["@alexkroman1/aai/dist", "the SDK types"],
    ["@alexkroman1/aai-ui/dist/index.d.ts", "what client.tsx can import"],
    ["@alexkroman1/aai-ui/dist/components/chat-view.d.ts", "a component's props"],
    ["@alexkroman1/aai-cli/dist/templates/simple/agent.ts", "a bundled template"],
    ["@alexkroman1/aai-cli/dist/templates/night-owl/client.tsx", "a bundled client.tsx"],
  ])("%s resolves (%s)", ([rel]) => {
    expect(existsSync(path.join(modulesDir as string, rel as string))).toBe(true);
  });

  test("every path the prompt section names is one that exists", () => {
    const section = toolchainPromptSection(modulesDir);
    const quoted = [...section.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1] as string)
      .filter((s) => path.isAbsolute(s));
    expect(quoted.length).toBeGreaterThan(0);
    // Soft, so a prompt naming several unresolvable paths reports all of them.
    for (const p of quoted) expect.soft(existsSync(p), p).toBe(true);
  });

  test("degrades to no section rather than naming paths it could not resolve", () => {
    expect(toolchainPromptSection(null)).toBe("");
  });
});

describe("scrubDir", () => {
  const dir = path.join(path.sep, "scratch", "ws-1");

  test("strips the build-dir prefix from paths", () => {
    expect(scrubDir(`${dir}${path.sep}agent.ts: broken`, dir)).toBe("agent.ts: broken");
  });

  test("replaces a bare dir mention with a dot", () => {
    expect(scrubDir(`in ${dir} somewhere`, dir)).toBe("in . somewhere");
  });

  test("strips ANSI color codes", () => {
    expect(scrubDir("\u001b[31mError\u001b[0m: nope", dir)).toBe("Error: nope");
  });
});

describe("formatBuildFailure", () => {
  const dir = path.join(path.sep, "scratch", "ws-2");

  test("names the file and line from a Rollup-style loc", () => {
    const err = { message: "Unexpected token", loc: { file: `${dir}/agent.ts`, line: 3 } };
    expect(formatBuildFailure(err, dir)).toBe("Build failed:\nagent.ts:3: Unexpected token");
  });

  test("falls back to the module id when there is no loc", () => {
    const err = { message: "Failed to resolve import", id: `${dir}/client.tsx` };
    expect(formatBuildFailure(err, dir)).toBe(
      "Build failed:\nclient.tsx: Failed to resolve import",
    );
  });

  test("a bare error keeps just its message", () => {
    expect(formatBuildFailure(new Error("boom"), dir)).toBe("Build failed:\nboom");
  });

  test("a non-Error value is stringified", () => {
    expect(formatBuildFailure("weird", dir)).toBe("Build failed:\nweird");
  });
});

describe("withBuildDir", () => {
  test("materializes into a fresh dir under the workspaces root and cleans up", async () => {
    let seen: string | undefined;
    const result = await withBuildDir(
      { "agent.ts": "export {};" },
      async (dir, files) => {
        seen = dir;
        for (const [rel, content] of Object.entries(files)) {
          await writeFile(path.join(dir, rel), content, "utf-8");
        }
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
    const result = await withBuildDir(
      { "agent.ts": "export {};\n" },
      async (dir, files) => {
        for (const [rel, content] of Object.entries(files)) {
          await writeFile(path.join(dir, rel), content, "utf-8");
        }
      },
      (dir) => typecheckWorkspaceDir(dir),
    );
    expect(result).toEqual({ ok: true, skipped: true });
  });

  test("type errors come back scrubbed and annotated, like a build's", {
    timeout: 120_000,
  }, async () => {
    const result = await withBuildDir(
      {
        "tsconfig.json": JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        }),
        "agent.ts": `export const n: number = "nope";\n`,
      },
      async (dir, files) => {
        for (const [rel, content] of Object.entries(files)) {
          await writeFile(path.join(dir, rel), content, "utf-8");
        }
      },
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
  test("type errors fail the build with scrubbed diagnostics, before bundling", {
    timeout: 120_000,
  }, async () => {
    const result = await withBuildDir(
      {
        "tsconfig.json": JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        }),
        "agent.ts": `export const n: number = "nope";\n`,
      },
      async (dir, files) => {
        for (const [rel, content] of Object.entries(files)) {
          await writeFile(path.join(dir, rel), content, "utf-8");
        }
      },
      (dir) => buildWorkspaceDir(dir, { worker: true, client: false }),
    );
    expect(result.worker).toBeUndefined();
    expect(result.buildError).toContain("Type check failed");
    expect(result.buildError).toContain("agent.ts");
    // The scratch path never reaches the coding agent.
    expect(result.buildError).not.toContain(workspacesRoot());
  });

  test("a dependency that would not install is named ahead of the failure it causes", {
    timeout: 120_000,
  }, async () => {
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
      async (dir, files) => {
        for (const [rel, content] of Object.entries(files)) {
          await writeFile(path.join(dir, rel), content, "utf-8");
        }
      },
      (dir) => buildWorkspaceDir(dir, { worker: true, client: false }),
    );
    expect(result.buildError).toContain("Could not install ms");
    expect(result.buildError?.indexOf("Could not install ms")).toBe(0);
  });
});
