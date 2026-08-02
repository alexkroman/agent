// Copyright 2026 the AAI authors. MIT license.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createGuestWebTools, MUTATING_TOOLS } from "./studio-chat.ts";
import { createDesignInspirationTool, createProjectTools } from "./studio-project-tools.ts";
import {
  createStudioTools,
  STUDIO_TOOL_LABELS,
  type StudioToolDeps,
  withToolDeadlines,
} from "./studio-tools.ts";
import { materializeWorkspace, snapshotWorkspace } from "./studio-workspace-fs.ts";

const toolOpts = () => ({ toolCallId: "t1", messages: [] }) as never;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeTools(
  files: Record<string, string>,
  config: Record<string, unknown> = { name: "A", toolSchemas: [] },
  typecheck: StudioToolDeps["typecheck"] = async () => ({ ok: true, skipped: false }),
): Promise<{ tools: ReturnType<typeof createStudioTools>; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aai-studio-tools-"));
  dirs.push(dir);
  await materializeWorkspace(dir, files);
  const deps: StudioToolDeps = {
    dir,
    typecheck,
    build: async () => ({ worker: "export default {}" }),
    loadBundle: async () => ({ config }),
    executeTool: async (name) => `ran ${name}`,
  };
  // Wrapped exactly as the chat loop wraps the merged set: the deadline
  // wrapper also converts thrown errors (path escapes) to error strings.
  return { tools: withToolDeadlines(createStudioTools(deps)), dir };
}

describe("guest workspace tools", () => {
  test("file tools refuse paths that escape the workspace", async () => {
    const { tools } = await makeTools({ "a.ts": "x" });
    const out = await tools.read_file?.execute?.({ path: "../../etc/passwd" }, toolOpts());
    expect(String(out)).toContain("Error");
    const write = await tools.write_file?.execute?.(
      { path: "../outside.txt", content: "x" },
      toolOpts(),
    );
    expect(String(write)).toContain("Error");
  });

  test("read_file windows large files with numbered lines", async () => {
    const big = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const { tools } = await makeTools({ "big.txt": big });
    const out = String(
      await tools.read_file?.execute?.({ path: "big.txt", offset: 10, limit: 3 }, toolOpts()),
    );
    expect(out).toContain("00010| line 10");
    expect(out).toContain("00012| line 12");
    expect(out).not.toContain("line 13");
    expect(out).toContain("offset: 13");
  });

  test("glob matches by pattern, newest first, and reports no matches", async () => {
    const { tools } = await makeTools({
      "agent.ts": "a",
      "client.tsx": "c",
      "lib/util.ts": "u",
      "notes.md": "n",
    });
    const out = String(await tools.glob?.execute?.({ pattern: "**/*.ts" }, toolOpts()));
    expect(out).toContain("agent.ts");
    expect(out).toContain("lib/util.ts");
    expect(out).not.toContain("notes.md");
    expect(String(await tools.glob?.execute?.({ pattern: "*.py" }, toolOpts()))).toBe(
      "No files found",
    );
  });

  test("bash runs in the workspace with the guest token scrubbed", async () => {
    process.env.AAI_GUEST_TOKEN = "secret-token";
    try {
      const { tools } = await makeTools({ "f.txt": "hi" });
      const out = String(
        await tools.bash?.execute?.(
          { command: "cat f.txt && echo token=$AAI_GUEST_TOKEN" },
          toolOpts(),
        ),
      );
      expect(out).toContain("hi");
      expect(out).toContain("token=");
      expect(out).not.toContain("secret-token");
    } finally {
      delete process.env.AAI_GUEST_TOKEN;
    }
  });

  test("bash failures report the exit code", async () => {
    const { tools } = await makeTools({});
    const out = String(await tools.bash?.execute?.({ command: "exit 3" }, toolOpts()));
    expect(out).toContain("[exit code 3]");
  });

  test("edit_file applies and writes through to disk", async () => {
    const { tools, dir } = await makeTools({ "a.ts": "const x = 1;\n" });
    const out = String(
      await tools.edit_file?.execute?.(
        { path: "a.ts", oldText: "x = 1", newText: "x = 2" },
        toolOpts(),
      ),
    );
    expect(out).toContain("Edited a.ts");
    expect(await readFile(path.join(dir, "a.ts"), "utf-8")).toBe("const x = 2;\n");
  });

  test("write_file and edit_file report post-write type errors, saving anyway", async () => {
    const red = async () =>
      ({ ok: false, output: "Type check failed:\na.ts(1,7): error TS2322: nope" }) as const;
    const { tools, dir } = await makeTools({ "a.ts": "const x = 1;\n" }, undefined, red);
    const wrote = String(
      await tools.write_file?.execute?.({ path: "a.ts", content: "const x = 2;\n" }, toolOpts()),
    );
    expect(wrote).toContain("Wrote a.ts");
    expect(wrote).toContain("error TS2322");
    expect(wrote).toContain("WAS saved");
    expect(await readFile(path.join(dir, "a.ts"), "utf-8")).toBe("const x = 2;\n");

    const edited = String(
      await tools.edit_file?.execute?.(
        { path: "a.ts", oldText: "x = 2", newText: "x = 3" },
        toolOpts(),
      ),
    );
    expect(edited).toContain("Edited a.ts");
    expect(edited).toContain("error TS2322");
    expect(await readFile(path.join(dir, "a.ts"), "utf-8")).toBe("const x = 3;\n");
  });

  test("post-write diagnostics skip non-source files", async () => {
    let calls = 0;
    const { tools } = await makeTools({}, undefined, async () => {
      calls++;
      return { ok: true, skipped: false };
    });
    await tools.write_file?.execute?.({ path: "data/menu.json", content: "{}" }, toolOpts());
    expect(calls).toBe(0);
    await tools.write_file?.execute?.({ path: "a.ts", content: "const a = 1;\n" }, toolOpts());
    expect(calls).toBe(1);
  });

  test("snapshotWorkspace skips ignored dirs and oversized files", async () => {
    const { dir } = await makeTools({ "a.ts": "x" });
    await materializeWorkspace(dir, {
      "a.ts": "x",
      "node_modules/dep/index.js": "ignored",
      "big.bin": "y".repeat(300_000),
    });
    const { files, warnings } = await snapshotWorkspace(dir);
    expect(Object.keys(files)).toEqual(["a.ts"]);
    expect(warnings.join("\n")).toContain("big.bin");
  });

  test("tool labels and the mutating set track the merged tool set", async () => {
    const { tools, dir } = await makeTools({});
    // The same merge runTurn performs — every family, studio tools last.
    const merged = {
      ...createGuestWebTools(),
      ...createDesignInspirationTool({} as never),
      ...createProjectTools({ dir }),
      ...tools,
    };
    const names = Object.keys(merged).sort();
    // A tool without a label renders as raw snake_case in the UI; a label
    // without a tool is dead weight. Keep the two lists identical.
    expect(Object.keys(STUDIO_TOOL_LABELS).sort()).toEqual(names);
    // A file-touching tool missing here loses its edits on a mid-turn crash
    // (the checkpointer never fires for it).
    for (const name of MUTATING_TOOLS) expect(names).toContain(name);
  });

  test("test_agent builds via the host and trials a tool in place", async () => {
    const { tools } = await makeTools({ "agent.ts": "x" });
    const out = String(
      await tools.test_agent?.execute?.({ tool: undefined, args: undefined }, toolOpts()),
    );
    expect(out).toContain('Agent "A"');
  });

  test("test_agent flags an S2S build, and stays quiet on a pipeline one", async () => {
    const s2s = await makeTools({ "agent.ts": "x" }, { name: "A", toolSchemas: [] });
    const flagged = String(
      await s2s.tools.test_agent?.execute?.({ tool: undefined, args: undefined }, toolOpts()),
    );
    expect(flagged).toContain("s2s mode");
    expect(flagged).toContain("voice agent API");

    const pipeline = await makeTools(
      { "agent.ts": "x" },
      { name: "A", mode: "pipeline", toolSchemas: [] },
    );
    const quiet = String(
      await pipeline.tools.test_agent?.execute?.({ tool: undefined, args: undefined }, toolOpts()),
    );
    expect(quiet).toContain("pipeline mode");
    expect(quiet).not.toContain("voice agent API");
  });
});
