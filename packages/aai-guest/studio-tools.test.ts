// Copyright 2026 the AAI authors. MIT license.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runTool, useTempDirs } from "./_test-utils.ts";
import { createStudioAgent } from "./studio-agent.ts";
import { createStudioTools, STUDIO_TOOL_LABELS, type StudioToolDeps } from "./studio-tools.ts";
import { MUTATING_TOOLS } from "./studio-turn-settle.ts";
import { materializeWorkspace, snapshotWorkspace } from "./studio-workspace-fs.ts";
import { createPostWriteDiagnostics, type TypecheckFn } from "./studio-write-diagnostics.ts";

const makeDir = useTempDirs("aai-studio-tools-");

async function makeTools(
  files: Record<string, string>,
  config: Record<string, unknown> = { name: "A", toolSchemas: [] },
  typecheck: TypecheckFn = async () => ({ ok: true, skipped: false }),
  overrides: Partial<StudioToolDeps> = {},
): Promise<{ tools: ReturnType<typeof createStudioTools>; dir: string }> {
  const dir = await makeDir();
  await materializeWorkspace(dir, files);
  const deps: StudioToolDeps = {
    dir,
    diagnostics: createPostWriteDiagnostics(typecheck),
    build: async () => ({ worker: "export default {}" }),
    loadBundle: async () => ({ config }),
    executeTool: async (name) => `ran ${name}`,
    ...overrides,
  };
  return { tools: createStudioTools(deps), dir };
}

describe("guest workspace tools", () => {
  test("file tools refuse paths that escape the workspace", async () => {
    const { tools } = await makeTools({ "a.ts": "x" });
    // `read_file` catches for itself, so the escape reads as a missing file.
    const out = await runTool(tools, "read_file", { path: "../../etc/passwd" });
    expect(out).toContain("Error");
    // `write_file` lets `resolveInside` throw, and the executor is what turns
    // a thrown tool into the SDK's error result — a shape the model can read
    // and recover from, rather than a failed turn. Asserting the shape here
    // is the point: this is the one refusal that must never become a write.
    const write = await runTool(tools, "write_file", {
      path: "../outside.txt",
      content: "x",
    });
    expect(JSON.parse(write)).toMatchObject({ error: expect.stringContaining("escapes") });
  });

  test("read_file windows large files with numbered lines", async () => {
    const big = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const { tools } = await makeTools({ "big.txt": big });
    const out = String(
      await runTool(tools, "read_file", { path: "big.txt", offset: 10, limit: 3 }),
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
    const out = String(await runTool(tools, "glob", { pattern: "**/*.ts" }));
    expect(out).toContain("agent.ts");
    expect(out).toContain("lib/util.ts");
    expect(out).not.toContain("notes.md");
    expect(String(await runTool(tools, "glob", { pattern: "*.py" }))).toBe("No files found");
  });

  test("bash runs in the workspace with the guest token scrubbed", async () => {
    vi.stubEnv("AAI_GUEST_TOKEN", "secret-token");
    const { tools } = await makeTools({ "f.txt": "hi" });
    const out = String(
      await runTool(tools, "bash", { command: "cat f.txt && echo token=$AAI_GUEST_TOKEN" }),
    );
    expect(out).toContain("hi");
    expect(out).toContain("token=");
    expect(out).not.toContain("secret-token");
  });

  test("bash failures report the exit code", async () => {
    const { tools } = await makeTools({});
    const out = String(await runTool(tools, "bash", { command: "exit 3" }));
    expect(out).toContain("[exit code 3]");
  });

  test("edit_file applies and writes through to disk", async () => {
    const { tools, dir } = await makeTools({ "a.ts": "const x = 1;\n" });
    const out = String(
      await runTool(tools, "edit_file", { path: "a.ts", oldText: "x = 1", newText: "x = 2" }),
    );
    expect(out).toContain("Edited a.ts");
    expect(await readFile(path.join(dir, "a.ts"), "utf-8")).toBe("const x = 2;\n");
  });

  test("write_file and edit_file report post-write type errors, saving anyway", async () => {
    const red = async () =>
      ({ ok: false, output: "Type check failed:\na.ts(1,7): error TS2322: nope" }) as const;
    const { tools, dir } = await makeTools({ "a.ts": "const x = 1;\n" }, undefined, red);
    const wrote = String(
      await runTool(tools, "write_file", { path: "a.ts", content: "const x = 2;\n" }),
    );
    expect(wrote).toContain("Wrote a.ts");
    expect(wrote).toContain("error TS2322");
    expect(wrote).toContain("WAS saved");
    expect(await readFile(path.join(dir, "a.ts"), "utf-8")).toBe("const x = 2;\n");

    const edited = String(
      await runTool(tools, "edit_file", { path: "a.ts", oldText: "x = 2", newText: "x = 3" }),
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
    await runTool(tools, "write_file", { path: "data/menu.json", content: "{}" });
    expect(calls).toBe(0);
    await runTool(tools, "write_file", { path: "a.ts", content: "const a = 1;\n" });
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

  test("snapshotWorkspace skips binary files instead of mangling them", async () => {
    const { dir } = await makeTools({ "a.ts": "x" });
    // The coding agent's `bash` can produce real binaries (a curl'd image, a
    // build artifact). The workspace row is a JSON path→string map, so a
    // utf-8 read replaces every invalid byte with U+FFFD and the end-of-turn
    // sync silently writes the mangled version back as the project's source.
    await writeFile(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]));

    const { files, warnings } = await snapshotWorkspace(dir);
    expect(Object.keys(files)).toEqual(["a.ts"]);
    expect(warnings.join("\n")).toContain("logo.png");
  });

  test("tool labels and the mutating set track the agent's real tool set", async () => {
    const { dir } = await makeTools({});
    // The definition runTurn builds, not a hand-merged copy of it — the whole
    // point of `createStudioAgent` is that there is one tool surface. Its
    // builtins are named on the definition (`builtinTools`) rather than
    // present as entries, so they are added back here the way the SDK will.
    const def = createStudioAgent(
      {
        dir,
        scope: "user:1",
        project: "p",
        files: {},
        apiKey: "k",
        chatToken: "t",
        system: "s",
        model: "gpt-5.5",
        maxSteps: 8,
      },
      {
        loadBundle: async () => ({}),
        executeTool: async () => "",
        typecheck: async () => ({ ok: true, skipped: false }),
      },
    );
    const names = [...Object.keys(def.tools), ...(def.builtinTools ?? [])].sort();
    // A tool without a label renders as raw snake_case in the UI; a label
    // without a tool is dead weight. Keep the two lists identical.
    expect(Object.keys(STUDIO_TOOL_LABELS).sort()).toEqual(names);
    // A file-touching tool missing here loses its edits on a mid-turn crash
    // (the checkpointer never fires for it).
    expect(MUTATING_TOOLS.size).toBeGreaterThan(0);
    for (const name of MUTATING_TOOLS) expect(names).toContain(name);
  });

  test("delete_file removes the file and names a missing one", async () => {
    const { tools, dir } = await makeTools({ "old.ts": "x" });
    expect(String(await runTool(tools, "delete_file", { path: "old.ts" }))).toBe("Deleted old.ts");
    await expect(readFile(path.join(dir, "old.ts"))).rejects.toThrow();
    expect(String(await runTool(tools, "delete_file", { path: "old.ts" }))).toBe(
      "Error: no such file: old.ts",
    );
  });

  // `stat` admits a directory and `rm` without `recursive` rejects one, so the
  // raw `ERR_FS_EISDIR` escaped `runTool`'s shaping as the only Node error in a
  // tool set where every other failure is prose the model can act on.
  test("delete_file refuses a directory in prose, not with a raw fs error", async () => {
    const { tools, dir } = await makeTools({ "pages/home.ts": "x" });
    const out = String(await runTool(tools, "delete_file", { path: "pages" }));
    expect(out).toContain("is a directory");
    expect(out).not.toContain("EISDIR");
    // Refusing means refusing: the tree is still there.
    expect(await readFile(path.join(dir, "pages/home.ts"), "utf-8")).toBe("x");
  });

  test("todo_write renders marks and the remaining count", async () => {
    const { tools } = await makeTools({});
    const out = String(
      await runTool(tools, "todo_write", {
        todos: [
          { content: "scaffold the agent", status: "completed" },
          { content: "wire the tool", status: "in_progress" },
          { content: "test it", status: "pending" },
          { content: "gold-plate it", status: "cancelled" },
        ],
      }),
    );
    expect(out).toContain("[x] scaffold the agent");
    expect(out).toContain("[>] wire the tool");
    expect(out).toContain("[ ] test it");
    expect(out).toContain("[-] gold-plate it");
    expect(out).toContain("2 remaining");
    expect(String(await runTool(tools, "todo_write", { todos: [] }))).toBe("(empty todo list)");
  });

  test("grep searches only what the glob selects and reports bad patterns", async () => {
    const { tools } = await makeTools({
      "agent.ts": "const needle = 1;\n",
      "notes.md": "needle in prose\n",
    });
    const scoped = String(await runTool(tools, "grep", { pattern: "needle", glob: "*.ts" }));
    expect(scoped).toContain("agent.ts");
    expect(scoped).not.toContain("notes.md");
    // A broken regex must come back as an error string the agent can fix.
    const bad = String(await runTool(tools, "grep", { pattern: "([" }));
    expect(bad).toContain("Error:");
  });

  test("test_agent surfaces a build failure as-is and stops there", async () => {
    let loads = 0;
    const { tools } = await makeTools({}, undefined, undefined, {
      build: async () => ({ buildError: "Build failed:\nagent.ts:1: nope" }),
      loadBundle: async () => {
        loads++;
        return {};
      },
    });
    const out = String(await runTool(tools, "test_agent", { tool: undefined, args: undefined }));
    expect(out).toBe("Build failed:\nagent.ts:1: nope");
    expect(loads).toBe(0);
  });

  test("test_agent reports a build that returned no worker", async () => {
    const { tools } = await makeTools({}, undefined, undefined, { build: async () => ({}) });
    const out = String(await runTool(tools, "test_agent", { tool: undefined, args: undefined }));
    expect(out).toBe("Error: build returned no worker bundle");
  });

  test("test_agent reports a bundle that failed to load", async () => {
    const { tools } = await makeTools({}, undefined, undefined, {
      loadBundle: async () => {
        throw new Error("import exploded");
      },
    });
    const out = String(await runTool(tools, "test_agent", { tool: undefined, args: undefined }));
    expect(out).toBe("Bundle failed to load: import exploded");
  });

  test("test_agent refuses to trial a tool the agent does not declare", async () => {
    const { tools } = await makeTools(
      { "agent.ts": "x" },
      {
        name: "A",
        mode: "pipeline",
        toolSchemas: [{ name: "lookup" }],
      },
    );
    const out = String(await runTool(tools, "test_agent", { tool: "nope", args: {} }));
    expect(out).toContain('Cannot invoke "nope": not one of the agent\'s tools.');

    const trialed = String(
      await runTool(tools, "test_agent", { tool: "lookup", args: { q: "x" } }),
    );
    expect(trialed).toContain('lookup({"q":"x"}) → ran lookup');
  });

  test("test_agent builds via the host and trials a tool in place", async () => {
    const { tools } = await makeTools({ "agent.ts": "x" });
    const out = String(await runTool(tools, "test_agent", { tool: undefined, args: undefined }));
    expect(out).toContain('Agent "A"');
  });

  test("test_agent flags an S2S build, and stays quiet on a pipeline one", async () => {
    const s2s = await makeTools({ "agent.ts": "x" }, { name: "A", toolSchemas: [] });
    const flagged = String(await runTool(s2s.tools, "test_agent", {}));
    expect(flagged).toContain("s2s mode");
    expect(flagged).toContain("voice agent API");

    const pipeline = await makeTools(
      { "agent.ts": "x" },
      { name: "A", mode: "pipeline", toolSchemas: [] },
    );
    const quiet = String(await runTool(pipeline.tools, "test_agent", {}));
    expect(quiet).toContain("pipeline mode");
    expect(quiet).not.toContain("voice agent API");
  });
});
