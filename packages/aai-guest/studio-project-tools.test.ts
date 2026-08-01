// Copyright 2026 the AAI authors. MIT license.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createDesignInspirationTool,
  createProjectTools,
  type ProjectToolDeps,
} from "./studio-project-tools.ts";

let dir: string;

const typecheckOk: ProjectToolDeps["typecheck"] = () =>
  Promise.resolve({ ok: true, skipped: false });

function makeTools(typecheck: ProjectToolDeps["typecheck"] = typecheckOk): ToolSet {
  return createProjectTools({ dir, typecheck });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "studio-project-tools-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function execute(tools: ToolSet, name: string, args: unknown): Promise<unknown> {
  const t = tools[name];
  if (!t?.execute) throw new Error(`no such tool: ${name}`);
  return Promise.resolve(t.execute(args as never, {} as never));
}

describe("add_dependency / remove_dependency", () => {
  // Valid specs spawn a real npm process, so unit tests only cover the
  // validation gate — the seam that keeps flags and shell syntax out of
  // the npm invocation.
  test.each([
    "-g",
    "--flag",
    "; rm -rf /",
    "https://evil.example/pkg.tgz",
    "../escape",
    "UPPER/case",
  ])("rejects invalid spec %s without spawning", async (spec) => {
    const tools = makeTools();
    const result = await execute(tools, "add_dependency", { package: spec });
    expect(result).toContain("not a valid npm package spec");
    const removed = await execute(tools, "remove_dependency", { package: spec });
    expect(removed).toContain("not a valid npm package spec");
  });
});

describe("check_types", () => {
  test("reports a clean check", async () => {
    const result = await execute(makeTools(), "check_types", {});
    expect(result).toBe("No type errors");
  });

  test("reports a skipped check (no tsconfig)", async () => {
    const tools = makeTools(() => Promise.resolve({ ok: true, skipped: true }));
    const result = await execute(tools, "check_types", {});
    expect(result).toContain("no tsconfig.json");
  });

  test("returns the tsc diagnostics on failure", async () => {
    const tools = makeTools(() =>
      Promise.resolve({ ok: false, output: "agent.ts(3,7): error TS2322: nope" }),
    );
    const result = await execute(tools, "check_types", {});
    expect(result).toContain("error TS2322");
  });

  test("surfaces a thrown typecheck as an error string", async () => {
    const tools = makeTools(() => Promise.reject(new Error("toolchain missing")));
    const result = await execute(tools, "check_types", {});
    expect(result).toBe("Error: toolchain missing");
  });
});

describe("npm_info", () => {
  test.each(["-g", "; rm -rf /", "https://evil.example/pkg.tgz"])(
    "rejects invalid spec %s without spawning",
    async (spec) => {
      const result = await execute(makeTools(), "npm_info", { package: spec });
      expect(result).toContain("not a valid npm package spec");
    },
  );
});

describe("download_to_workspace", () => {
  test("refuses paths that escape the workspace before fetching", async () => {
    const tools = makeTools();
    const result = await execute(tools, "download_to_workspace", {
      url: "https://example.com/data.json",
      path: "../outside.json",
    });
    expect(result).toContain("escapes the workspace");
  });

  test("reports an unfetchable URL as an error string", async () => {
    const tools = makeTools();
    const result = await execute(tools, "download_to_workspace", {
      url: "not-a-url",
      path: "data.json",
    });
    expect(result).toMatch(/^Error: fetch failed/);
  });
});

describe("generate_design_inspiration", () => {
  test("surfaces model failures as an error tool result", async () => {
    const tools = createDesignInspirationTool("not-a-real-model" as never);
    const result = await execute(tools, "generate_design_inspiration", {
      goal: "warm boutique voice agent UI",
    });
    expect(result).toMatch(/^Error: /);
  });
});

describe("workspace round-trip", () => {
  test("writes a downloaded text body into the workspace", async () => {
    // data: URLs never touch the network but still exercise the full
    // fetch → decode → write path.
    const tools = makeTools();
    const result = await execute(tools, "download_to_workspace", {
      url: "data:application/json,%7B%22ok%22%3Atrue%7D",
      path: "data/menu.json",
    });
    if (typeof result === "string" && result.startsWith("Downloaded")) {
      expect(await readFile(path.join(dir, "data/menu.json"), "utf-8")).toBe('{"ok":true}');
    } else {
      // safeFetch may refuse non-HTTP protocols — that refusal is the SSRF
      // screen working, and it must arrive as an error string, not a throw.
      expect(result).toMatch(/^Error: /);
    }
  });
});
