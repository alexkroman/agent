/**
 * What this template CAN and CANNOT reach.
 *
 * A coding agent's tools take a path from a model, so the claims worth pinning
 * are about the boundary: what `WORKSPACE_DIR` selects, that nothing outside it
 * is reachable by any of the nine, and that a failure comes back as a sentence
 * the model can act on rather than as a thrown `ENOENT`. The behaviour of each
 * tool is the SDK's and is covered there; what belongs to this template is the
 * wiring.
 *
 * `vi.hoisted` runs before the imports below, which is the only way to point
 * `shared.ts` at a scratch directory: it reads the variable once, at module
 * scope, so a `beforeEach` would be far too late.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import agentDef from "virtual:aai/agent";
import { expectDeployable, toolRunner } from "@alexkroman1/aai/testing";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { WORKSPACE_DIR } from "./shared.ts";

const workspace = vi.hoisted(() => {
  // Hoisted above the imports, so it cannot use `node:os` — the temp root is
  // read the way `os.tmpdir()` reads it. The directory need not exist yet:
  // `shared.ts` records the path and touches nothing until a tool runs.
  const root = process.env.TMPDIR ?? process.env.TMP ?? "/tmp";
  const dir = `${root}/coding-agent-template-${process.pid}`;
  process.env.WORKSPACE_DIR = dir;
  return dir;
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const run = toolRunner(agentDef);

beforeEach(() => {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, "cart.ts"), "export const total = 1;\n", "utf-8");
});

describe("coding-agent template", () => {
  test("is deployable, and is a TEXT agent — no audio stage anywhere", () => {
    const config = expectDeployable(agentDef);
    // The mode is the template's point: `createRuntime` refuses a text agent by
    // name, so this is what says it runs on `createTextAgent` instead. A
    // provider triple appearing here would mean the mode had been lost.
    expect(config.text).toBe(true);
    expect(config.s2s).toBeUndefined();
  });

  test("declares the nine workspace tools, by the names the model calls", () => {
    expect(Object.keys(agentDef.tools).sort()).toEqual([
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
  });

  test("the tools work in WORKSPACE_DIR, which is the one thing to configure", async () => {
    expect(WORKSPACE_DIR).toBe(workspace);
    expect(String(await run("list_files", {}))).toContain("cart.ts");
    expect(String(await run("read_file", { path: "cart.ts" }))).toContain("export const total");
  });

  test("nothing outside the workspace is reachable, by any of the path tools", async () => {
    // A traversal reads as a file that is not there — the same answer a typo
    // gets, which is the recovery the model already knows.
    expect(String(await run("read_file", { path: "../../etc/passwd" }))).toContain(
      "Error: no such file",
    );
    // A WRITE that escapes THROWS rather than answering, which is deliberate:
    // in a real turn the runtime's executor shapes a thrown tool into an error
    // result, so the model sees a refusal it cannot mistake for a file it has
    // yet to create. Here there is no executor, so the throw is what a spec
    // sees.
    await expect(run("write_file", { path: "../escaped.ts", content: "x" })).rejects.toThrow(
      /escapes the workspace/,
    );
  });

  test("an edit is applied to disk and reported as a diff", async () => {
    const out = String(
      await run("edit_file", {
        path: "cart.ts",
        oldText: "const total = 1;",
        newText: "const total = 2;",
      }),
    );
    expect(out).toContain("Edited cart.ts");
    expect(readFileSync(path.join(workspace, "cart.ts"), "utf-8")).toBe(
      "export const total = 2;\n",
    );
  });

  test("a failed match is advice, not an exception — the agent can recover", async () => {
    expect(
      String(await run("edit_file", { path: "cart.ts", oldText: "nope", newText: "x" })),
    ).toContain("Could not find that text");
  });
});
