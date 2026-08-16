// Copyright 2026 the AAI authors. MIT license.
// Guest build helpers, UNIT tier: the pure formatting the coding agent reads
// (`scrubDir`, `formatBuildFailure`) and the toolchain search, which only
// READS the filesystem.
//
// The build-dir lifecycle and the typecheck-first gate WRITE files and spawn
// `tsc`, so they are the scenario tier's — `studio-build.scenario.test.ts`.
// Splitting on what a test TOUCHES is the membership rule; it also keeps these
// three functions' coverage in the tier `test:coverage` measures.

import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { formatBuildFailure, scrubDir, toolchainModules } from "./studio-build.ts";
import { toolchainPromptSection } from "./studio-session.ts";

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
