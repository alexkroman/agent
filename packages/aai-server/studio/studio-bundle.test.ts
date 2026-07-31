// Copyright 2025 the AAI authors. MIT license.
// Real-bundler tests: bundling is a pure transform (no code execution), so
// exercising it directly keeps the import policy honest.

import { describe, expect, test } from "vitest";
import { bundleWorkspaceWorker } from "./studio-bundle.ts";
import { StudioBuildError } from "./studio-errors.ts";
import { starterFiles } from "./studio-template.ts";
import { withWorkspaceDir } from "./studio-workspace-dir.ts";

/** Materialize a workspace and run the real worker build over it. */
const bundleWorkspace = (files: Record<string, string>): Promise<string> =>
  withWorkspaceDir(files, bundleWorkspaceWorker);

describe("bundleWorkspaceWorker", () => {
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
    ).rejects.toThrow(/escapes the workspace/);
  }, 30_000);

  test("cannot reach real server source by traversing out of the scratch dir", async () => {
    // The scratch dir is a real directory inside the server package, so "not
    // found" is no longer what stops a `../` climb — the resolver must.
    await expect(
      bundleWorkspace({
        "agent.ts": `import { createSandbox } from "../../sandbox.ts";
export default { name: String(typeof createSandbox) };`,
      }),
    ).rejects.toThrow(/escapes the workspace/);
  }, 30_000);

  test("rejects absolute-path imports", async () => {
    await expect(
      bundleWorkspace({
        "agent.ts": `import "/etc/passwd";
export default {};`,
      }),
    ).rejects.toThrow(/escapes the workspace/);
  }, 30_000);

  test("imports ?raw-suffixed files as raw strings", async () => {
    const code = await bundleWorkspace({
      "agent.ts": `import { agent } from "@alexkroman1/aai";
import prompt from "./prompt.md?raw";
export default agent({ name: "Md Agent", systemPrompt: prompt });`,
      "prompt.md": "You are markdown-configured.",
    });
    expect(code).toContain("You are markdown-configured.");
  }, 30_000);

  test("rejects imports outside the allowlist", async () => {
    // The import must be *used* — the bundler tree-shakes unused imports away
    // before resolution, which is fine (nothing disallowed reaches the bundle).
    await expect(
      bundleWorkspace({
        "agent.ts": `import pad from "left-pad";
export default { name: pad("x", 3) };`,
      }),
    ).rejects.toThrow(/Cannot import "left-pad"/);
  }, 30_000);

  test("names the valid subpaths when an SDK subpath does not exist", async () => {
    // A subpath guess the model makes on its own. Left to Vite it failed with
    // rolldown's "is not exported under the conditions […] see exports field
    // in /…/package.json" — which points the agent at a file it cannot read
    // and names no alternative, so it guesses again instead of fixing the
    // import.
    const err = await bundleWorkspace({
      "agent.ts": `import { sequential } from "@alexkroman1/aai/combinators";
export default { name: String(typeof sequential) };`,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StudioBuildError);
    const message = (err as Error).message;
    expect(message).toContain('Cannot import "@alexkroman1/aai/combinators"');
    expect(message).toContain("has no such subpath");
    // The actionable half: the correct subpath is in the message.
    expect(message).toContain("@alexkroman1/aai/patterns");
    // And the root entry.
    expect(message).toContain("@alexkroman1/aai,");
  }, 30_000);

  test("accepts every subpath the SDK really exports", async () => {
    const code = await bundleWorkspace({
      "agent.ts": `import { sequential } from "@alexkroman1/aai/patterns";
import { agent } from "@alexkroman1/aai";
export default { name: String(typeof sequential) + String(typeof agent) };`,
    });
    expect(code).toBeTruthy();
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
    ).rejects.toThrow(/Could not resolve '\.\/missing\.ts'/);
  }, 30_000);

  test("leaves process.env.NODE_ENV alone", async () => {
    // Vite's build() sets NODE_ENV=production when it is unset. In a
    // `pnpm dev:aai-server` process that is exactly the case, so the first
    // studio build used to flip the whole server to "production" for the rest
    // of its life — production-only checks (Modal credentials, storage env)
    // then start failing on a dev machine.
    const saved = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      await bundleWorkspace(starterFiles());
      expect(process.env.NODE_ENV).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved;
    }
  }, 30_000);

  test("scrubs the scratch-dir path out of diagnostics", async () => {
    // The coding agent only knows workspace-relative paths; a leaked
    // .studio-build/<uuid>/ prefix is noise it might try to "fix".
    const err = await bundleWorkspace({
      "agent.ts": `import "./missing.ts"; export default {};`,
    }).catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/\.studio-build/);
    expect((err as Error).message).toContain("agent.ts");
  }, 30_000);

  test("surfaces TypeScript syntax errors as StudioBuildError", async () => {
    await expect(bundleWorkspace({ "agent.ts": "const oops = {" })).rejects.toThrow(
      StudioBuildError,
    );
  }, 30_000);
});
