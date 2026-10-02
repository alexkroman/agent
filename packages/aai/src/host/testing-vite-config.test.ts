// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { defineAgentTestConfig } from "./testing-vite-config.ts";

const PRESET = {
  globals: true,
  reporters: ["default"],
  restoreMocks: true,
  unstubEnvs: true,
  unstubGlobals: true,
};

describe("defineAgentTestConfig", () => {
  test("is the scaffold's config: the agent plugin, globals, the pinned reporter, mock restore", () => {
    const config = defineAgentTestConfig();
    expect(config.plugins).toHaveLength(1);
    expect(config.plugins[0]).toMatchObject({ name: "aai:agent", enforce: "pre" });
    expect(config.test).toEqual(PRESET);
  });

  test("appends plugins, merges test key by key, and passes other keys through", () => {
    const extra = { name: "extra" };
    const config = defineAgentTestConfig({
      plugins: [extra],
      test: { testTimeout: 10_000, reporters: ["verbose"], unstubGlobals: false },
      define: { X: "1" },
    });
    expect(config.plugins.map((p) => (p as { name: string }).name)).toEqual(["aai:agent", "extra"]);
    expect(config.test).toEqual({
      ...PRESET,
      reporters: ["verbose"],
      unstubGlobals: false,
      testTimeout: 10_000,
    });
    expect(config.define).toEqual({ X: "1" });
  });

  test("leaves resolution to Vite's defaults unless AAI_DEV_SOURCE is on", () => {
    vi.stubEnv("AAI_DEV_SOURCE", "");
    expect(defineAgentTestConfig()).not.toHaveProperty("resolve");
    expect(defineAgentTestConfig()).not.toHaveProperty("ssr");
  });

  test("AAI_DEV_SOURCE=1 adds @dev/source to both resolvers, keeping the defaults", () => {
    vi.stubEnv("AAI_DEV_SOURCE", "1");
    const config = defineAgentTestConfig();
    expect(config.resolve).toEqual({
      conditions: ["module", "browser", "development|production", "@dev/source"],
    });
    expect(config.ssr).toEqual({
      resolve: { conditions: ["module", "node", "development|production", "@dev/source"] },
    });
  });
});
