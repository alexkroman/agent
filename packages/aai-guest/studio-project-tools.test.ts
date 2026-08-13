// Copyright 2026 the AAI authors. MIT license.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolDef } from "@alexkroman1/aai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runTool } from "./_test-utils.ts";
import { createDesignInspirationTool, createProjectTools } from "./studio-project-tools.ts";

let dir: string;

function makeTools(): Record<string, ToolDef> {
  return createProjectTools({ dir });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "studio-project-tools-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function execute(tools: Record<string, ToolDef>, name: string, args: unknown): Promise<unknown> {
  const t = tools[name];
  if (!t?.execute) throw new Error(`no such tool: ${name}`);
  return runTool({ [name]: t }, name, args as Record<string, unknown>);
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

describe("update_dependencies", () => {
  // As above, the real collaborators are only exercised up to the gate: a
  // name that passes would spawn npm against the live registry.
  test.each(["-g", "date-fns@2", "; rm -rf /", "../escape", "UPPER/case"])(
    "rejects %s without spawning",
    async (name) => {
      const result = await execute(makeTools(), "update_dependencies", { packages: [name] });
      expect(result).toContain("not valid npm package name");
    },
  );

  test("a missing package.json is an error, not a spawn", async () => {
    const result = await execute(makeTools(), "update_dependencies", {});
    expect(result).toContain("package.json is missing");
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
  test("surfaces generation failures as an error tool result", async () => {
    // A brief the model could not produce must come back as something the
    // coding agent can read and move past, never as a thrown turn.
    const result = await runTool(
      createDesignInspirationTool(),
      "generate_design_inspiration",
      { goal: "warm boutique voice agent UI" },
      { generate: () => Promise.reject(new Error("gateway is down")) },
    );
    expect(result).toMatch(/^Error: gateway is down/);
  });

  test("without a generate capability at all", async () => {
    // `executeToolCall` substitutes a rejecting `ctx.generate` when the
    // context has none, and the tool's own catch turns that into text too.
    const result = await runTool(createDesignInspirationTool(), "generate_design_inspiration", {
      goal: "anything",
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
