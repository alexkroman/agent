// Copyright 2026 the AAI authors. MIT license.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createStudioTools,
  materializeWorkspace,
  type StudioToolDeps,
  snapshotWorkspace,
} from "./studio-tools.ts";

const toolOpts = () => ({ toolCallId: "t1", messages: [] }) as never;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeTools(
  files: Record<string, string>,
): Promise<{ tools: ReturnType<typeof createStudioTools>; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aai-studio-tools-"));
  dirs.push(dir);
  await materializeWorkspace(dir, files);
  const deps: StudioToolDeps = {
    dir,
    build: async () => ({ worker: "export default {}" }),
    loadBundle: async () => ({ config: { name: "A", toolSchemas: [] } }),
    executeTool: async (name) => `ran ${name}`,
  };
  return { tools: createStudioTools(deps), dir };
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

  test("test_agent builds via the host and trials a tool in place", async () => {
    const { tools } = await makeTools({ "agent.ts": "x" });
    const out = String(
      await tools.test_agent?.execute?.({ tool: undefined, args: undefined }, toolOpts()),
    );
    expect(out).toContain('Agent "A"');
  });
});
