// Copyright 2025 the AAI authors. MIT license.
/**
 * Vite's build is faked here (`BuildClientOptions.viteBuild`): the point of these tests is the *config* `buildClient`
 * hands it, which is where the client build's cross-package resolution policy
 * lives. Running a real bundle would exercise Rolldown, not that policy — and
 * the one bug this guards (React resolving from the wrong `node_modules`) only
 * reproduces in a pruned production install, which a unit test can't create.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { InlineConfig } from "vite";
import { describe, expect, vi } from "vitest";
import { test as baseTest } from "./_test-utils.ts";
import { type BuildClientOptions, buildClient as realBuildClient } from "./client-bundler.ts";

// The real config helpers (`mergeConfig`, the default conditions): only the
// BUILD is faked.
const build = vi.fn(async (config: InlineConfig) => {
  // Emit one artifact so the caller's read of the out dir succeeds.
  const outDir = path.join(String(config.root), String(config.build?.outDir));
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "index.html"), "<!doctype html>", "utf-8");
});

/** `buildClient`, running its config through the fake build above. */
function buildClient(cwd: string, options: BuildClientOptions = {}) {
  return realBuildClient(cwd, { viteBuild: build, ...options });
}

/** The config passed to Vite by the most recent `buildClient` call. */
function lastConfig(): InlineConfig {
  const config = build.mock.calls.at(-1)?.[0];
  if (!config) throw new Error("vite build was never called");
  return config;
}

/** `@alexkroman1/aai-ui`'s manifest — the source of truth for its peer deps. */
async function uiManifest(): Promise<{
  peerDependencies: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}> {
  const manifest = path.resolve(import.meta.dirname ?? ".", "../../aai-ui/package.json");
  return JSON.parse(await fs.readFile(manifest, "utf-8"));
}

/**
 * A `project` fixture: a temp dir holding the minimum a client build needs — an
 * entry point, and a `vite.config.ts` so the build leaves plugins to it rather
 * than loading the default pair from a `node_modules` a temp dir does not have
 * (that path is `_client-plugins.test.ts`'s).
 */
const test = baseTest.extend("project", async ({ tmpDir }) => {
  await fs.writeFile(path.join(tmpDir, "client.tsx"), "export {};", "utf-8");
  await fs.writeFile(path.join(tmpDir, "vite.config.ts"), "export default {};", "utf-8");
  return tmpDir;
});

describe("buildClient", () => {
  test("skips the build entirely when the project has no client.tsx", async ({ tmpDir: dir }) => {
    expect(await buildClient(dir)).toEqual({});
    expect(build).not.toHaveBeenCalled();
  });

  test("returns the built artifacts keyed by relative path", async ({ project: dir }) => {
    expect(await buildClient(dir)).toEqual({ "index.html": "<!doctype html>" });
    expect(lastConfig().root).toBe(dir);
  });

  test("dedupes every non-optional peer dependency of aai-ui", async ({ project: dir }) => {
    // aai-ui's peers are resolved from the build root, not from the copy of
    // `node_modules` above `aai-ui/dist` — which in the studio's production
    // image holds no React at all (see the DEDUPED_PEERS comment). A peer
    // added to aai-ui without being added here breaks publishing, and only in
    // production, so assert against aai-ui's manifest rather than a literal.
    const { peerDependencies, peerDependenciesMeta } = await uiManifest();
    const required = Object.keys(peerDependencies).filter(
      (name) => !peerDependenciesMeta?.[name]?.optional,
    );

    await buildClient(dir);
    expect(required.length).toBeGreaterThan(0);
    expect(lastConfig().resolve?.dedupe).toEqual(expect.arrayContaining(required));
  });

  test("passes the studio's plugins through and ignores its vite.config.ts", async ({
    project: dir,
  }) => {
    // Workspace files are untrusted, so a vite.config.ts the coding agent
    // writes must never be loaded as host code.
    const plugins = [{ name: "test-plugin" }];
    await fs.writeFile(path.join(dir, "vite.config.ts"), "export default {};", "utf-8");
    await buildClient(dir, { configFile: false, plugins, outDir: "out" });

    const config = lastConfig();
    expect(config.configFile).toBe(false);
    expect(config.plugins).toEqual(plugins);
    expect(config.build?.outDir).toBe("out");
  });

  test("leaves the project's vite.config.ts in charge by default", async ({ project: dir }) => {
    await buildClient(dir);
    const config = lastConfig();
    expect(config.configFile).toBeUndefined();
    expect(config.plugins).toBeUndefined();
  });

  test("with no vite.config.*, the default plugins are REQUIRED of the project", async ({
    tmpDir: dir,
  }) => {
    await fs.writeFile(path.join(dir, "client.tsx"), "export {};", "utf-8");
    await expect(buildClient(dir)).rejects.toMatchObject({ code: "client_plugins_missing" });
    expect(build).not.toHaveBeenCalled();
  });
});
