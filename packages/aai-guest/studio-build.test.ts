// Copyright 2026 the AAI authors. MIT license.
// Guest build helpers: diagnostic scrubbing, build-dir lifecycle, and the
// typecheck-first gate. Full builds through the real bundlers are covered by
// aai-server's workspace-build-integration.test.ts; here we pin the pure
// formatting and the failure paths the coding agent reads.

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildWorkspaceDir,
  formatBuildFailure,
  harnessEntry,
  scrubDir,
  withBuildDir,
  workspacesRoot,
} from "./studio-build.ts";

let tempDirs: string[] = [];

/**
 * Write a stub build child that honors the argv contract and prints a canned
 * envelope — `buildWorkspaceDir` only sees the child's artifacts, streams,
 * and exit, so this exercises every parse path without paying for a bundle.
 */
async function makeFakeEntry(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "aai-build-entry-"));
  tempDirs.push(dir);
  const entry = path.join(dir, "fake-entry.mjs");
  await writeFile(
    entry,
    [
      `import { writeFile } from "node:fs/promises";`,
      `import path from "node:path";`,
      "const args = process.argv.slice(2);",
      "const arg = (name) => args[args.indexOf(name) + 1];",
      `const dir = arg("--build-workspace");`,
      `const out = arg("--out");`,
      body,
    ].join("\n"),
    "utf-8",
  );
  return entry;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
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

  test("returns the artifacts the child process wrote", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aai-build-ws-"));
    tempDirs.push(dir);
    const buildEntry = await makeFakeEntry(
      [
        `await writeFile(path.join(out, "worker.mjs"), "// built from " + path.basename(dir));`,
        `await writeFile(path.join(out, "client.json"), JSON.stringify({ "index.html": "<html>" }));`,
        `console.log("noise the parser must skip");`,
        "console.log(JSON.stringify({ ok: true, worker: true, client: true }));",
      ].join("\n"),
    );

    const result = await buildWorkspaceDir(dir, { worker: true, client: true }, { buildEntry });

    expect(result.buildError).toBeUndefined();
    expect(result.worker).toBe(`// built from ${path.basename(dir)}`);
    expect(result.clientFiles).toEqual({ "index.html": "<html>" });
  });

  test("a failure envelope from the child becomes buildError", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aai-build-ws-"));
    tempDirs.push(dir);
    const buildEntry = await makeFakeEntry(
      `console.log(JSON.stringify({ ok: false, buildError: "Build failed:\\nagent.ts:1: nope" }));`,
    );

    const result = await buildWorkspaceDir(dir, { worker: true, client: false }, { buildEntry });

    expect(result.worker).toBeUndefined();
    expect(result.buildError).toBe("Build failed:\nagent.ts:1: nope");
  });

  test("a child that dies without an envelope surfaces its output", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aai-build-ws-"));
    tempDirs.push(dir);
    const buildEntry = await makeFakeEntry(
      [`process.stderr.write("FATAL: out of memory\\n");`, "process.exit(7);"].join("\n"),
    );

    const result = await buildWorkspaceDir(dir, { worker: true, client: false }, { buildEntry });

    expect(result.worker).toBeUndefined();
    expect(result.buildError).toContain("FATAL: out of memory");
    expect(result.buildError).toContain("7");
  });
});

describe("buildWorkspaceDir memory", () => {
  /**
   * The defect this guards: the bundler used to run IN the harness process,
   * and Rolldown's native allocations are never returned to the OS — one
   * `test_agent` build measured +1.5 GB RSS on a long-lived studio sandbox,
   * which then became the process floor. Building in a child process makes
   * the OS reclaim it on exit, so the harness stays flat.
   */
  test("does not retain the bundler's memory in this process", { timeout: 300_000 }, async () => {
    const before = process.memoryUsage().rss;
    const result = await withBuildDir(
      {
        "package.json": JSON.stringify({ name: "mem-probe", private: true, type: "module" }),
        "agent.ts": `import { agent } from "@alexkroman1/aai";\nexport default agent({ name: "mem-probe", systemPrompt: "hi" });\n`,
      },
      async (dir, files) => {
        for (const [rel, content] of Object.entries(files)) {
          await writeFile(path.join(dir, rel), content, "utf-8");
        }
      },
      (dir) => buildWorkspaceDir(dir, { worker: true, client: false }),
    );

    expect(result.buildError).toBeUndefined();
    // A real bundle, not an empty success: the worker ships its own SDK
    // runtime, so anything this size is the genuine article.
    expect(result.worker?.length ?? 0).toBeGreaterThan(1_000_000);
    const growthMiB = (process.memoryUsage().rss - before) / 1024 / 1024;
    expect(growthMiB).toBeLessThan(400);
  });
});

describe("harnessEntry", () => {
  test("resolves a runnable entry that exists on disk", async () => {
    const entry = harnessEntry();
    // Bundled, this is harness.mjs itself; from source, its sibling harness.ts.
    expect(path.basename(entry)).toMatch(/^harness\.(ts|mjs)$/);
    await expect(readdir(path.dirname(entry))).resolves.toContain(path.basename(entry));
  });
});
