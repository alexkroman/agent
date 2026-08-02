// Copyright 2026 the AAI authors. MIT license.
// Guest build helpers: diagnostic scrubbing, build-dir lifecycle, and the
// typecheck-first gate. Full builds through the real bundlers are covered by
// aai-server's workspace-build-integration.test.ts; here we pin the pure
// formatting and the failure paths the coding agent reads.

import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildWorkspaceDir,
  formatBuildFailure,
  scrubDir,
  withBuildDir,
  workspacesRoot,
} from "./studio-build.ts";

describe("workspacesRoot depth", () => {
  // The studio preamble (aai-studio-server/studio-preamble.ts) tells the
  // coding agent to read the SDK types, the aai-ui component types, and the
  // CLI's bundled templates through `../../node_modules/...` with bash —
  // read_file/glob/grep are jailed to the workspace and cannot see them.
  // That relative depth is only right while a session workspace sits exactly
  // two levels under the directory holding the toolchain node_modules, which
  // holds in all three layouts: /opt/aai (baked image), packages/aai-guest/
  // dist (subprocess backend), and packages/aai-guest (tests). Move
  // workspacesRoot() and the prompt silently starts naming paths that do not
  // exist — a failure the agent can only report as "file not found".
  const PROMPT_PREFIX = path.join("..", "..", "node_modules");
  const sessionDir = path.join(workspacesRoot(), "session-1");

  // Each entry is a path the preamble literally tells the agent to read.
  test.for([
    ["@alexkroman1/aai/dist", "the SDK types"],
    ["@alexkroman1/aai-ui/dist/index.d.ts", "what client.tsx can import"],
    ["@alexkroman1/aai-ui/dist/components/chat-view.d.ts", "a component's props"],
    ["@alexkroman1/aai-cli/dist/templates/simple/agent.ts", "a bundled template"],
    ["@alexkroman1/aai-cli/dist/templates/night-owl/client.tsx", "a bundled client.tsx"],
  ])("%s exists at the path the prompt gives (%s)", ([rel]) => {
    expect(existsSync(path.resolve(sessionDir, PROMPT_PREFIX, rel as string))).toBe(true);
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
});
