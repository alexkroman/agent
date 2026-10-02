// Copyright 2026 the AAI authors. MIT license.
// The verdaccio registry the e2e suite installs from (_mock-registry.ts),
// started with nothing to publish so only the registry itself is under test.
// Scenario tier: a real subprocess on a real port.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect } from "vitest";
import { startMockRegistry } from "./_mock-registry.ts";
import { test } from "./_test-utils.ts";

describe("startMockRegistry", { timeout: 60_000 }, () => {
  test("serves a local registry and points npm at it, then cleans up", async () => {
    const registry = await startMockRegistry(path.resolve(import.meta.dirname, "../.."), []);
    const npmrc = registry.env.npm_config_userconfig ?? "";
    try {
      expect(registry.registryUrl).toMatch(/^http:\/\/localhost:\d+$/);
      expect(registry.env.npm_config_registry).toBe(registry.registryUrl);
      expect(registry.env.NPM_CONFIG_USERCONFIG).toBe(npmrc);
      // A unique version per run, so pnpm's store never serves stale bytes.
      expect(registry.testVersion).toMatch(/^0\.0\.0-e2e\.\d+$/);
      expect(readFileSync(npmrc, "utf8")).toContain(`registry=${registry.registryUrl}`);

      const ping = await fetch(`${registry.registryUrl}/-/ping`);
      expect(ping.status).toBe(200);
    } finally {
      await registry.stop();
    }
    expect(existsSync(path.dirname(npmrc))).toBe(false);
  });

  test("an unparseable package.json fails the start, naming the file", async ({ tmpDir: dir }) => {
    await mkdir(path.join(dir, "broken"));
    await writeFile(path.join(dir, "broken", "package.json"), "{ not json");
    await expect(startMockRegistry(dir, ["broken"])).rejects.toThrow(
      `Invalid JSON in ${path.join(dir, "broken", "package.json")}`,
    );
  });
});
