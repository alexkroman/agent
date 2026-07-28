// Copyright 2025 the AAI authors. MIT license.
// Real-esbuild tests: bundling is a pure transform (no code execution), so
// exercising it directly keeps the import policy honest.

import { describe, expect, test } from "vitest";
import { bundleWorkspace, StudioBuildError } from "./studio-bundle.ts";
import { starterFiles } from "./studio-template.ts";

describe("bundleWorkspace", () => {
  test("bundles the starter workspace with a self-describing config export", async () => {
    const code = await bundleWorkspace(starterFiles());
    expect(code).toContain("__aaiConfig");
    // The manifest helpers must be bundled in, not left as imports.
    expect(code).not.toMatch(/from\s+["']@alexkroman1\/aai/);
  }, 30_000);

  test("resolves workspace-relative imports (with and without extension)", async () => {
    const code = await bundleWorkspace({
      "agent.ts": `import { agent } from "@alexkroman1/aai";
import { NAME } from "./name.ts";
import greeting from "./greeting";
export default agent({ name: NAME, greeting });`,
      "name.ts": `export const NAME = "Rel Import Agent";`,
      "greeting.ts": `export default "hello from helper";`,
    });
    expect(code).toContain("Rel Import Agent");
    expect(code).toContain("hello from helper");
  }, 30_000);

  test("imports .json files as data", async () => {
    const code = await bundleWorkspace({
      "agent.ts": `import { agent } from "@alexkroman1/aai";
import config from "./config.json";
export default agent({ name: config.name });`,
      "config.json": `{ "name": "Json Config Agent" }`,
    });
    expect(code).toContain("Json Config Agent");
  }, 30_000);

  test("rejects relative imports that escape the workspace root", async () => {
    await expect(
      bundleWorkspace({
        "agent.ts": `import { x } from "../outside.ts";
export default { name: String(x) };`,
      }),
    ).rejects.toThrow(/File not found in workspace: \.\.\/outside\.ts/);
  }, 30_000);

  test("imports .md files as raw strings", async () => {
    const code = await bundleWorkspace({
      "agent.ts": `import { agent } from "@alexkroman1/aai";
import prompt from "./prompt.md";
export default agent({ name: "Md Agent", systemPrompt: prompt });`,
      "prompt.md": "You are markdown-configured.",
    });
    expect(code).toContain("You are markdown-configured.");
  }, 30_000);

  test("rejects imports outside the allowlist", async () => {
    // The import must be *used* — esbuild tree-shakes unused imports away
    // before resolution, which is fine (nothing disallowed reaches the bundle).
    await expect(
      bundleWorkspace({
        "agent.ts": `import pad from "left-pad";
export default { name: pad("x", 3) };`,
      }),
    ).rejects.toThrow(/Cannot import "left-pad"/);
  }, 30_000);

  test("leaves node: builtins external (CLI-build parity; guest denies at runtime)", async () => {
    const code = await bundleWorkspace({
      "agent.ts": `import { readFileSync } from "node:fs";
export default { name: String(typeof readFileSync) };`,
    });
    expect(code).toContain("node:fs");
  }, 30_000);

  test("rejects a workspace without agent.ts", async () => {
    await expect(bundleWorkspace({})).rejects.toThrow(StudioBuildError);
    await expect(bundleWorkspace({})).rejects.toThrow(/no agent\.ts/);
  });

  test("reports missing workspace files with their import path", async () => {
    await expect(
      bundleWorkspace({ "agent.ts": `import "./missing.ts"; export default {};` }),
    ).rejects.toThrow(/File not found in workspace: \.\/missing\.ts/);
  }, 30_000);

  test("surfaces TypeScript syntax errors as StudioBuildError", async () => {
    await expect(bundleWorkspace({ "agent.ts": "const oops = {" })).rejects.toThrow(
      StudioBuildError,
    );
  }, 30_000);
});
