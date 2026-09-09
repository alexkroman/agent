// Copyright 2026 the AAI authors. MIT license.
/**
 * The coding tool set over a real directory — everything except `bash`, which
 * spawns and lives in `coding-tools.scenario.test.ts`.
 *
 * Each tool is called through its `execute`, which is what the runtime's tool
 * executor does after validating arguments against the declared schema. What
 * is asserted is the SENTENCE the model reads back, because that is the whole
 * interface: every failure here is a string the model has to be able to act
 * on, and "no such file" versus a raw `ENOENT` stack is the difference between
 * a recovered turn and a stranded one.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createToolContext } from "../sdk/_testing-context.ts";
import type { ToolDef } from "../sdk/tool-def.ts";
import { createCodingTools } from "./coding-tools.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aai-coding-tools-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a workspace file, creating its parents. */
async function put(rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf-8");
}

/** Call one tool the way the executor does: parsed args in, a string out. */
function run(
  tools: Record<string, ToolDef>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const tool = tools[name];
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  // The context every tool here IGNORES — none of them reads `ctx` — built by
  // the SDK's own helper rather than cast in, so the day one of them starts
  // reading `ctx.env` this file does not have to change shape.
  return Promise.resolve(tool.execute(args, createToolContext())).then(String);
}

describe("createCodingTools", () => {
  test("builds all nine tools, or exactly the ones asked for", () => {
    expect(Object.keys(createCodingTools({ dir })).sort()).toEqual([
      "bash",
      "delete_file",
      "edit_file",
      "glob",
      "grep",
      "list_files",
      "read_file",
      "todo_write",
      "write_file",
    ]);
    // A host with a better tool of its own names the rest, rather than
    // building the set and deleting a key.
    expect(Object.keys(createCodingTools({ dir, only: ["read_file", "grep"] })).sort()).toEqual([
      "grep",
      "read_file",
    ]);
  });

  test("refuses a path that escapes the workspace", async () => {
    const tools = createCodingTools({ dir });
    // `read_file` answers as it does for any absent path — a traversal and a
    // typo are the same recovery.
    expect(await run(tools, "read_file", { path: "../secrets.txt" })).toBe(
      "Error: no such file: ../secrets.txt",
    );
    // `write_file` THROWS, so the executor turns it into an error result the
    // model cannot mistake for a file it merely has not created yet.
    await expect(run(tools, "write_file", { path: "../escape.ts", content: "x" })).rejects.toThrow(
      /escapes the workspace/,
    );
  });

  test("read_file numbers lines and pages with offset/limit", async () => {
    await put("notes.md", Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n"));
    const tools = createCodingTools({ dir });
    const head = await run(tools, "read_file", { path: "notes.md", limit: 3 });
    expect(head).toContain("00001| line 1");
    expect(head).toContain("00003| line 3");
    // The continuation is NAMED, so a truncated read cannot read as the file
    // ending there.
    expect(head).toContain("pass offset: 4 to continue");
    expect(await run(tools, "read_file", { path: "notes.md", offset: 8 })).toContain(
      "00008| line 8",
    );
  });

  test("list_files and glob answer over the walked tree", async () => {
    await put("agent.ts", "export default {};\n");
    await put("tools/read_thing.ts", "export default {};\n");
    await put("node_modules/pkg/index.js", "module.exports = {};\n");
    const tools = createCodingTools({ dir });
    const listed = (await run(tools, "list_files")).split("\n");
    expect(listed).toContain("agent.ts");
    expect(listed).toContain(path.join("tools", "read_thing.ts"));
    // The ignored directories are the walk's, so no tool has to know them.
    expect(listed.join("\n")).not.toContain("node_modules");
    expect(await run(tools, "glob", { pattern: "**/*.ts" })).toContain("agent.ts");
    expect(await run(tools, "glob", { pattern: "**/*.py" })).toBe("No files found");
  });

  test("grep searches only what the glob selects, and names a bad pattern", async () => {
    await put("agent.ts", "const rollDice = 1;\n");
    await put("notes.md", "rollDice is the dice tool\n");
    const tools = createCodingTools({ dir });
    const scoped = await run(tools, "grep", { pattern: "rollDice", glob: "*.ts" });
    expect(scoped).toContain("agent.ts:1:");
    expect(scoped).not.toContain("notes.md");
    // A bad regex is the model's to fix, so it comes back as prose with the
    // remedy in it rather than as a throw.
    expect(await run(tools, "grep", { pattern: "(" })).toMatch(/Invalid regex/);
  });

  test("write_file and edit_file persist, and edit_file returns the diff", async () => {
    const tools = createCodingTools({ dir });
    expect(await run(tools, "write_file", { path: "a/b.ts", content: "const x = 1;\n" })).toContain(
      "Wrote a/b.ts",
    );
    expect(await readFile(path.join(dir, "a/b.ts"), "utf-8")).toBe("const x = 1;\n");
    const edited = await run(tools, "edit_file", {
      path: "a/b.ts",
      oldText: "const x = 1;",
      newText: "const x = 2;",
    });
    expect(edited).toContain("Edited a/b.ts");
    expect(edited).toContain("-1 const x = 1;");
    expect(edited).toContain("+1 const x = 2;");
    expect(await readFile(path.join(dir, "a/b.ts"), "utf-8")).toBe("const x = 2;\n");
    // A miss is recoverable advice, not an exception.
    expect(
      await run(tools, "edit_file", { path: "a/b.ts", oldText: "nope", newText: "x" }),
    ).toMatch(/Could not find that text/);
    expect(await run(tools, "edit_file", { path: "gone.ts", oldText: "a", newText: "b" })).toBe(
      "Error: no such file: gone.ts",
    );
  });

  test("validate refuses a write before it lands, on both writers", async () => {
    const tools = createCodingTools({
      dir,
      validate: async (rel, content) =>
        content.includes("BAD") ? `Error: refused to write ${rel}` : undefined,
    });
    await run(tools, "write_file", { path: "a.ts", content: "ok\n" });
    expect(await run(tools, "write_file", { path: "a.ts", content: "BAD\n" })).toBe(
      "Error: refused to write a.ts",
    );
    // Refused means NOTHING was written — the state the host is refusing is a
    // half-applied one, so the file on disk is unchanged.
    expect(await readFile(path.join(dir, "a.ts"), "utf-8")).toBe("ok\n");
    expect(await run(tools, "edit_file", { path: "a.ts", oldText: "ok", newText: "BAD" })).toBe(
      "Error: refused to write a.ts",
    );
    expect(await readFile(path.join(dir, "a.ts"), "utf-8")).toBe("ok\n");
  });

  test("afterWrite rides on a SUCCESSFUL write, and only then", async () => {
    const seen: string[] = [];
    const tools = createCodingTools({
      dir,
      validate: async (_rel, content) => (content.includes("BAD") ? "Error: refused" : undefined),
      afterWrite: async (rel) => {
        seen.push(rel);
        return `\n\n1 error in ${rel}`;
      },
    });
    expect(await run(tools, "write_file", { path: "a.ts", content: "x\n" })).toContain(
      "1 error in a.ts",
    );
    expect(await run(tools, "edit_file", { path: "a.ts", oldText: "x", newText: "y" })).toContain(
      "1 error in a.ts",
    );
    await run(tools, "write_file", { path: "a.ts", content: "BAD\n" });
    // The refused write never reaches it: diagnostics describe what is on
    // disk, and nothing was put there.
    expect(seen).toEqual(["a.ts", "a.ts"]);
  });

  test("delete_file removes one file, and refuses a directory in prose", async () => {
    await put("scratch.ts", "x\n");
    await put("nested/keep.ts", "x\n");
    const tools = createCodingTools({ dir });
    expect(await run(tools, "delete_file", { path: "scratch.ts" })).toBe("Deleted scratch.ts");
    expect(await run(tools, "delete_file", { path: "scratch.ts" })).toBe(
      "Error: no such file: scratch.ts",
    );
    const refusal = await run(tools, "delete_file", { path: "nested" });
    expect(refusal).toContain("is a directory");
    expect(refusal).toContain("bash");
    await expect(readFile(path.join(dir, "nested/keep.ts"), "utf-8")).resolves.toBe("x\n");
  });

  test("todo_write renders the marks and what is left", async () => {
    const tools = createCodingTools({ dir });
    const out = await run(tools, "todo_write", {
      todos: [
        { content: "read the code", status: "completed" },
        { content: "write the fix", status: "in_progress" },
        { content: "run the tests", status: "pending" },
      ],
    });
    expect(out).toContain("[x] read the code");
    expect(out).toContain("[>] write the fix");
    expect(out).toContain("2 remaining");
    expect(await run(tools, "todo_write", { todos: [] })).toBe("(empty todo list)");
  });

  test("descriptions can be overridden per tool, leaving the rest alone", () => {
    const tools = createCodingTools({ dir, descriptions: { bash: "Run it in the sandbox." } });
    expect(tools.bash?.description).toBe("Run it in the sandbox.");
    expect(tools.read_file?.description).toContain("offset/limit");
  });
});
