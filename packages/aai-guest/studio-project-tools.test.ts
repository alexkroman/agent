// Copyright 2026 the AAI authors. MIT license.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDef } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { runTool, useTempDir } from "./_test-utils.ts";
import { createDesignInspirationTool, createProjectTools } from "./studio-project-tools.ts";

const dir = useTempDir("studio-project-tools-");

function makeTools(): Record<string, ToolDef> {
  return createProjectTools({ dir: dir() });
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
    const result = await runTool(tools, "add_dependency", { package: spec });
    expect(result).toContain("not a valid npm package spec");
    const removed = await runTool(tools, "remove_dependency", { package: spec });
    expect(removed).toContain("not a valid npm package spec");
  });
});

describe("update_dependencies", () => {
  // As above, the real collaborators are only exercised up to the gate: a
  // name that passes would spawn npm against the live registry.
  test.each(["-g", "date-fns@2", "; rm -rf /", "../escape", "UPPER/case"])(
    "rejects %s without spawning",
    async (name) => {
      const result = await runTool(makeTools(), "update_dependencies", { packages: [name] });
      expect(result).toContain("not valid npm package name");
    },
  );

  test("a missing package.json is an error, not a spawn", async () => {
    const result = await runTool(makeTools(), "update_dependencies", {});
    expect(result).toContain("package.json is missing");
  });
});

describe("npm_info", () => {
  test.each(["-g", "; rm -rf /", "https://evil.example/pkg.tgz"])(
    "rejects invalid spec %s without spawning",
    async (spec) => {
      const result = await runTool(makeTools(), "npm_info", { package: spec });
      expect(result).toContain("not a valid npm package spec");
    },
  );
});

describe("download_to_workspace", () => {
  // The ORDERING this name claims — refused BEFORE the outbound request — is
  // asserted in studio-project-tools-mocked.test.ts, which has the `safeFetch`
  // spy to prove nothing was fetched. Here the collaborator is real, so the
  // most this can say is that the refusal happens at all.
  test("refuses paths that escape the workspace", async () => {
    const tools = makeTools();
    const result = await runTool(tools, "download_to_workspace", {
      url: "https://example.com/data.json",
      path: "../outside.json",
    });
    expect(result).toContain("escapes the workspace");
  });

  test("reports an unfetchable URL as an error string", async () => {
    const tools = makeTools();
    const result = await runTool(tools, "download_to_workspace", {
      url: "not-a-url",
      path: "data.json",
    });
    expect(result).toMatch(/^Error: fetch failed/);
  });

  // This used to be a "workspace round-trip" test that branched on whether the
  // download succeeded: `safeFetch` refuses `data:` outright, so the success
  // branch — the only one that read the file back — was dead code, and the
  // refusal branch accepted ANY `Error:` string, including a bug. The
  // fetch → cap → decode → write path is covered with the fetch mocked, in
  // studio-project-tools-mocked.test.ts; what this file can say with the real
  // collaborator is that the screen refuses, and WHY.
  test("refuses a non-HTTP protocol, naming it, as an error string", async () => {
    const result = await runTool(makeTools(), "download_to_workspace", {
      url: "data:application/json,%7B%22ok%22%3Atrue%7D",
      path: "data/menu.json",
    });
    // Named, not just "some refusal": every failure mode in the screen shares
    // the `Blocked request` prefix, and a DNS miss is not this test's subject.
    expect(result).toBe("Error: fetch failed: Blocked request with disallowed protocol: data:");
    // And a refusal writes nothing — the tool must not create the path first.
    await expect(readFile(path.join(dir(), "data/menu.json"), "utf-8")).rejects.toThrow();
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
